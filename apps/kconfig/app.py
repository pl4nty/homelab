import asyncio
import gzip
import html
import ipaddress
import json
import os
import pickle
import re
import sys
import tempfile
import threading
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

import httpx2
import kernel_hardening_checker.checks as khc_checks
import kernel_hardening_checker.cli as khc_cli
import kernel_hardening_checker.engine as khc
from kconfiglib import (
    AND,
    BOOL,
    OR,
    TRI_TO_STR,
    TRISTATE,
    TYPE_TO_STR,
    Choice,
    expr_str,
    expr_value,
    split_expr,
    standard_sc_expr_str,
)
from nicegui import PageArguments, app, run, ui

DATA = Path(os.environ.get("KCONFIG_DATA", "/data"))
MANIFEST = json.loads((DATA / "trees.json").read_text())
TREES = {t["id"]: t for t in MANIFEST["trees"]}
NUMBER = re.compile(r"-?(0x)?[0-9a-f]+", re.IGNORECASE)
HEADER = "#\n# Automatically generated file; DO NOT EDIT.\n# {}\n#\n"
MAX_CONFIG = 4 << 20
KHC = "https://github.com/a13xp0p0v/kernel-hardening-checker"

sys.setrecursionlimit(1_000_000)


def prompt(sym):
    return next((n.prompt[0] for n in sym.nodes if n.prompt), "")


@lru_cache(maxsize=4)
def load_tree(tree_id, arch):
    data = gzip.decompress((DATA / tree_id / f"{arch}.pickle.gz").read_bytes())
    out = []
    threading.stack_size(1 << 29)
    thread = threading.Thread(target=lambda: out.append(pickle.loads(data)))
    thread.start()
    threading.stack_size(0)
    thread.join()
    kconf = out[0]
    index = [
        (
            sym,
            sym.name.lower(),
            prompt(sym).lower(),
            "\n".join(n.help or "" for n in sym.nodes).lower(),
        )
        for sym in kconf.unique_defined_syms
    ]
    return kconf, index


def load_text(kconf, text, replace=True):
    with tempfile.NamedTemporaryFile("w", suffix=".config") as f:
        f.write(text)
        f.flush()
        kconf.load_config(f.name, replace=replace)
    return len(kconf.missing_syms)


@lru_cache(maxsize=16)
def baseline(tree_id, arch, text):
    kconf, _ = load_tree(tree_id, arch)
    load_text(kconf, text)
    return {sym.name: sym.user_value for sym in kconf.unique_defined_syms}


def decode(data):
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data.decode(errors="replace")


def raw_url(url):
    parts = urlsplit(url.strip())
    m = parts.hostname == "github.com" and re.fullmatch(
        r"/([^/]+/[^/]+)/(?:blob|raw)/(.+)", parts.path
    )
    if m:
        return f"https://raw.githubusercontent.com/{m[1]}/{m[2]}"
    return parts._replace(path=parts.path.replace("/-/blob/", "/-/raw/")).geturl()


async def fetch(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("only https URLs are supported")
    addrs = await asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or 443)
    if not all(ipaddress.ip_address(a[4][0]).is_global for a in addrs):
        raise ValueError(f"{parts.hostname} is not a public address")
    data = bytearray()
    async with httpx2.AsyncClient(timeout=20) as client, client.stream("GET", url) as res:
        res.raise_for_status()
        async for chunk in res.aiter_bytes():
            data += chunk
            if len(data) > MAX_CONFIG:
                raise ValueError("larger than 4 MiB")
    return decode(bytes(data))


def harden(path):
    arch, msg = khc_cli.detect_arch_by_kconfig(path)
    if not arch:
        return msg
    version, msg = khc_cli.detect_kernel_version(path)
    if not version:
        return msg
    checklist = []
    khc_checks.add_kconfig_checks(checklist, arch)
    khc.populate_with_data(checklist, version, "version")
    parsed = {}
    khc_cli.parse_kconfig_file("json", parsed, path)
    khc.populate_with_data(checklist, parsed, "kconfig")
    for target in ("CONFIG_ARCH_MMAP_RND_BITS", "CONFIG_ARCH_MMAP_RND_COMPAT_BITS"):
        khc_cli.refine_check("json", checklist, parsed, target, f"{target}_MAX")
    khc.perform_checks(checklist)
    return checklist


def check_names(check):
    if isinstance(check, khc.ComplexOptCheck):
        return [n for o in check.opts for n in check_names(o)]
    return [] if isinstance(check, khc.VersionCheck) else [check.name]


def expected(value):
    if value in ("is not set", "is present", "is not off"):
        return value
    if value.startswith("*") and value.endswith("*"):
        return f'contains "{html.escape(value[1:-1])}"'
    return f"= {html.escape(value)}"


def badge(sym):
    value = sym.str_value
    cls = f"v-{value}" if sym.orig_type in (BOOL, TRISTATE) else "v-str"
    locked = "" if sym.visibility else " locked"
    return f'<span class="badge {cls}{locked}">{html.escape(value or '""')}</span>'


def section(title, body):
    if body:
        ui.label(title).classes("h3")
        ui.html("".join(body))


class Session:
    def __init__(self, tree_id, arch):
        self.tree = TREES[tree_id]
        self.arch = arch
        self.state = app.storage.user.setdefault(f"{tree_id}/{arch}", {"base": "", "config": ""})
        self.configs = DATA / tree_id / arch
        self.query = ""
        self.failures_only = True

    def href(self, path=""):
        return f"/{self.tree['id']}/{self.arch}/{path}"

    def load(self):
        self.base = baseline(self.tree["id"], self.arch, self.state["base"])
        self.kconf, self.index = load_tree(self.tree["id"], self.arch)
        load_text(self.kconf, self.state["config"])
        return self.kconf

    def save(self):
        self.state["config"] = self.kconf._min_config_contents("")
        self.results.refresh()
        self.frame.refresh()

    def start_from(self, text, name):
        missing = load_text(self.load(), text)
        self.state["base"] = self.kconf._min_config_contents("")
        self.save()
        ui.notify(f"Loaded {name}" + (f", {missing} symbols not in this tree" if missing else ""))

    def change(self, name, value):
        sym = self.load().syms[name]
        if (sym.unset_value() if value is None else sym.set_value(value)) is False:
            ui.notify(f"{value} is not a valid {TYPE_TO_STR[sym.orig_type]}", type="negative")
        self.save()

    def base_changed(self, e):
        if e.value is not None:
            self.start_from(
                (self.configs / e.value).read_text() if e.value else "", e.value or "alldefconfig"
            )

    def fragment_changed(self, e):
        if e.value:
            self.load()
            missing = load_text(self.kconf, (self.configs / e.value).read_text(), replace=False)
            self.save()
            ui.notify(
                f"Applied {e.value}" + (f", {missing} symbols not in this tree" if missing else "")
            )
            e.sender.value = None

    async def upload(self, e):
        self.start_from(decode(await e.file.read()), e.file.name)
        e.sender.reset()

    async def load_url(self, url):
        url = raw_url(url)
        try:
            text = await fetch(url)
        except (OSError, ValueError, httpx2.HTTPError) as err:
            ui.notify(f"Couldn't load {url}: {err}", type="negative")
            return
        self.start_from(text, url)

    def download(self, full):
        kconf = self.load()
        if full:
            ui.download.content(
                kconf._config_contents(HEADER.format(kconf.top_node.prompt[0])), ".config"
            )
        else:
            ui.download.content(kconf._min_config_contents(""), "defconfig")

    def link(self, sc):
        if sc.__class__ is Choice:
            return "&lt;choice&gt;"
        if sc.is_constant or (not sc.nodes and NUMBER.fullmatch(sc.name)):
            return f'<span class="const">{html.escape(standard_sc_expr_str(sc))}</span>'
        if not sc.nodes:
            return f'<span class="undef" title="Not defined in this tree">{sc.name}</span>'
        return f'<span class="ref"><a href="{self.href(sc.name)}">{sc.name}</a>{badge(sc)}</span>'

    def opt_link(self, name):
        sym = self.kconf.syms.get(name.removeprefix("CONFIG_"))
        return (
            self.link(sym) if sym else f'<span class="undef">{name.removeprefix("CONFIG_")}</span>'
        )

    def expr(self, e, cls="expr"):
        value = TRI_TO_STR[expr_value(e)]
        return (
            f'<div class="{cls}">{expr_str(e, self.link)} <b class="v-{value}">→ {value}</b></div>'
        )

    def own(self, sym, cond):
        deps = [n.dep for n in sym.nodes]
        if cond in deps:
            return None
        return cond[1] if isinstance(cond, tuple) and cond[0] is AND and cond[2] in deps else cond

    def pairs(self, sym, items, first):
        active = not first
        out = []
        for target, full in items:
            cond = self.own(sym, full)
            on = expr_value(full) > 0
            mark = first and on and not active
            active = active or mark
            cls = f"pair{' chosen' if mark else ''}{'' if on else ' off'}"
            target = "" if target is None else expr_str(target, self.link)
            cond = (
                ""
                if cond is None or cond is self.kconf.y
                else f' <span class="if">if {expr_str(cond, self.link)}</span>'
            )
            out.append(f'<div class="{cls}">{target}{cond}</div>')
        return out

    def check_html(self, check, nested=False):
        if isinstance(check, khc.VersionCheck):
            return (
                f'<span class="const">kernel &gt;= {".".join(map(str, check.ver_expected))}</span>'
            )
        if isinstance(check, khc.ComplexOptCheck):
            op = " || " if isinstance(check, khc.OR) else " &amp;&amp; "
            body = op.join(self.check_html(o, True) for o in check.opts)
            return f"({body})" if nested else body
        return f"{self.opt_link(check.name)} {expected(check.expected)}"

    def check_row(self, check):
        ok = check.result.startswith("OK")
        first = check
        while isinstance(first, khc.ComplexOptCheck):
            first = first.opts[0]
        why = " · ".join(html.escape(str(x)) for x in (first.decision, first.reason, check.result))
        return (
            f'<div class="khc"><span class="badge {"v-y" if ok else "v-fail"}">{"OK" if ok else "FAIL"}</span>'
            f'<div><div class="expr">{self.check_html(check)}</div><div class="why">{why}</div></div></div>'
        )

    def checks(self):
        with tempfile.NamedTemporaryFile("w", suffix=".config") as f:
            f.write(self.kconf._config_contents(HEADER.format(self.kconf.top_node.prompt[0])))
            f.flush()
            return harden(f.name)

    @ui.refreshable_method
    def results(self):
        self.load()
        changed = self.changed.value
        q = self.query.strip().lower().removeprefix("config_")
        words = q.split()
        hits = []
        for sym, name, text, help_text in self.index:
            if changed and sym.user_value == self.base.get(sym.name):
                continue
            if not words or name == q:
                score = 0
            elif name.startswith(q):
                score = 1
            elif q in name:
                score = 2
            elif all(w in name or w in text for w in words):
                score = 3
            elif all(w in name or w in text or w in help_text for w in words):
                score = 4
            else:
                continue
            hits.append((score, name, sym))
        hits.sort(key=lambda h: h[:2])
        count = sum(s.user_value != self.base.get(s.name) for s, *_ in self.index)
        self.changed.text = f"Changed by you ({count})" if count else "Changed by you"
        rows = [
            f'<a class="hit" href="{self.href(s.name)}"><code>{s.name}</code>{badge(s)}'
            f"<span>{html.escape(prompt(s))}</span></a>"
            for *_, s in hits[:200]
        ]
        more = f'<p class="more">{len(hits) - 200} more</p>' if len(hits) > 200 else ""
        ui.html("".join(rows) + (more if hits else '<p class="more">No matches</p>')).classes(
            "results"
        )

    def overview(self):
        kconf = self.load()
        ui.label(
            f"{self.tree['name']} ({self.tree['version']}) for {self.arch}, {len(self.index):,} symbols."
        )
        ui.label(
            "Search for a symbol, pick a defconfig to start from, then download the .config or defconfig."
        )
        ui.link("Check hardening", self.href("hardening"))
        ui.label(kconf.top_node.prompt[0]).classes("note")

    def hardening(self):
        self.load()
        ui.label("Hardening").classes("h2")
        ui.html(
            f'Checks from <a href="{KHC}" target="_blank">kernel-hardening-checker {khc_cli.__version__}</a>, run against the current .config.'
        )
        result = self.checks()
        if isinstance(result, str):
            ui.label(f"Can't check this config: {result}").classes("note")
            return
        fails = [c for c in result if not c.result.startswith("OK")]
        with ui.row().classes("items-center"):
            ui.html(
                f'<span class="badge v-y">{len(result) - len(fails)} OK</span> <span class="badge v-fail">{len(fails)} FAIL</span>'
            )
            ui.switch("Failures only", value=self.failures_only).on_value_change(
                self.toggle_failures
            )
        ui.html("".join(map(self.check_row, fails if self.failures_only else result)))

    def toggle_failures(self, e):
        self.failures_only = e.value
        self.frame.refresh()

    def symbol(self, name):
        kconf = self.load()
        sym = kconf.syms.get(name.removeprefix("CONFIG_"))
        if not sym or not sym.nodes:
            ui.label(f"{name} is not defined in {self.tree['name']} {self.arch}").classes("note")
            return
        nodes = sym.nodes
        with ui.row().classes("items-center"):
            ui.label(f"CONFIG_{sym.name}").classes("h2")
            ui.html(badge(sym))
            ui.label(TYPE_TO_STR[sym.orig_type] or "untyped").classes("type")
            if sym.user_value != self.base.get(sym.name):
                ui.label("changed").classes("type changed")
            if sym.is_transitional:
                ui.label("transitional").classes("type")
        ui.label(prompt(sym) or "(no prompt: set only by defaults, select or imply)").classes(
            "prompt"
        )
        with ui.row().classes("items-center"):
            if sym.orig_type in (BOOL, TRISTATE):
                for v in (0, 2) if sym.type == BOOL else (0, 1, 2):
                    on = sym.tri_value == v
                    ui.button(TRI_TO_STR[v], on_click=lambda v=v: self.change(sym.name, v)).props(
                        f"{'unelevated' if on else 'outline'} dense"
                    ).classes(f"tri v-{TRI_TO_STR[v]}").set_enabled(v in sym.assignable)
            else:
                value = ui.input(value=sym.str_value).props("dense outlined").classes("value")
                ui.button("Set", on_click=lambda: self.change(sym.name, value.value)).set_enabled(
                    bool(sym.visibility)
                )
                value.set_enabled(bool(sym.visibility))
            ui.button("Unset", on_click=lambda: self.change(sym.name, None)).props(
                "flat"
            ).set_enabled(sym.user_value is not None)
        if not sym.visibility:
            ui.label("Not user-settable now: no prompt is visible.").classes("note")
        ui.html(
            " ".join(
                f'<a href="{self.tree["repo"]}/blob/{self.tree["commit"]}/{n.filename}#L{n.linenr}" target="_blank">{n.filename}:{n.linenr}</a>'
                for n in nodes
            )
        ).classes("where")
        section("Help", [f'<pre class="help">{html.escape(n.help)}</pre>' for n in nodes if n.help])
        section("Depends on", [] if sym.direct_dep is kconf.y else [self.expr(sym.direct_dep)])
        section(
            "Prompt visible if",
            [
                self.expr(c)
                for n in nodes
                if n.prompt and (c := self.own(sym, n.prompt[1])) is not None
            ],
        )
        if sym.choice:
            choice = sym.choice
            title = next((n.prompt[0] for n in choice.nodes if n.prompt), choice.name or "")
            section(
                f"Choice: {title}",
                [
                    f'<div class="pair{" chosen" if choice.selection is s else ""}">{self.link(s)}</div>'
                    for s in choice.syms
                ],
            )
        for title, dep in (("Selected by", sym.rev_dep), ("Implied by", sym.weak_rev_dep)):
            terms = (
                [] if dep is kconf.n else sorted(split_expr(dep, OR), key=expr_value, reverse=True)
            )
            section(title, [self.expr(t) for t in terms])
        section("Defaults", self.pairs(sym, sym.defaults, True))
        section(
            "Range",
            [
                f'<div class="pair{"" if expr_value(c) else " off"}">{self.link(lo)} – {self.link(hi)}'
                + ("" if c is kconf.y else f' <span class="if">if {expr_str(c, self.link)}</span>')
                + "</div>"
                for lo, hi, c in sym.ranges
            ],
        )
        section("Selects", self.pairs(sym, sym.selects, False))
        section("Implies", self.pairs(sym, sym.implies, False))
        result = self.checks()
        if not isinstance(result, str):
            section(
                "Hardening",
                [self.check_row(c) for c in result if f"CONFIG_{sym.name}" in check_names(c)],
            )
        have = set(MANIFEST["names"].get(sym.name, []))
        section(
            "Available in",
            [
                f'<div class="trees"><strong>{t["name"]}</strong>'
                + "".join(
                    f'<a class="chip{" here" if t is self.tree and a == self.arch else ""}" href="/{t["id"]}/{a}/{sym.name}">{a}</a>'
                    if f"{t['id']}/{a}" in have
                    else f'<span class="chip missing">{a}</span>'
                    for a in t["arches"]
                )
                + "</div>"
                for t in MANIFEST["trees"]
            ],
        )

    def build(self, config_url):
        with ui.row().classes("bar"):
            ui.label("Kconfig").classes("h1")
            ui.select({t["id"]: t["name"] for t in MANIFEST["trees"]}, value=self.tree["id"]).props(
                "dense outlined"
            ).on_value_change(lambda e: ui.navigate.to(f"/{e.value}/{self.arch}"))
            ui.select(self.tree["arches"], value=self.arch).props("dense outlined").on_value_change(
                lambda e: ui.navigate.to(f"/{self.tree['id']}/{e.value}")
            )
            ui.label(f"{self.tree['version']} · {self.tree['commit'][:12]}").classes("status")
        configs = self.tree["configs"][self.arch]
        with ui.row().classes("bar"):
            ui.select(
                {"": "alldefconfig", **{c: c for c in configs if c.endswith("defconfig")}},
                label="Start from",
            ).props("dense outlined").classes("pick").on_value_change(self.base_changed)
            ui.select([c for c in configs if c.endswith(".config")], label="Add fragment").props(
                "dense outlined"
            ).classes("pick").on_value_change(self.fragment_changed)
            upload = ui.upload(
                auto_upload=True, max_file_size=MAX_CONFIG, on_upload=self.upload
            ).classes("hidden")
            ui.button("Load file", on_click=lambda: upload.run_method("pickFiles")).props("outline")
            url = (
                ui.input(placeholder="or a .config URL", value=config_url or "")
                .props("dense outlined")
                .classes("url")
            )
            ui.button("Load", on_click=lambda: self.load_url(url.value)).props("outline")
            ui.space()
            ui.button("Hardening", on_click=lambda: ui.navigate.to(self.href("hardening"))).props(
                "outline"
            )
            ui.button("Reset", on_click=lambda: self.start_from("", "alldefconfig")).props(
                "outline"
            )
            ui.button("defconfig", on_click=lambda: self.download(False)).props("outline")
            ui.button(".config", on_click=lambda: self.download(True)).props("unelevated")
        with ui.element("main"):
            with ui.element("nav"):
                ui.input(placeholder="Search symbols, prompts and help").props(
                    "dense outlined clearable debounce=150"
                ).on_value_change(self.search)
                self.changed = ui.checkbox("Changed by you").on_value_change(self.results.refresh)
                self.results()
            with ui.element("section").classes("detail"):
                self.frame = ui.sub_pages(
                    {"/": self.overview, "/hardening": self.hardening, "/{name}": self.symbol}
                )

    def search(self, e):
        self.query = e.value or ""
        self.results.refresh()


def home():
    t = MANIFEST["trees"][0]
    ui.navigate.to(f"/{t['id']}/{t['arches'][0]}")


async def shell(tree_id: str, arch: str, args: PageArguments):
    if tree_id not in TREES or arch not in TREES[tree_id]["arches"]:
        home()
        return
    await run.io_bound(load_tree, tree_id, arch)
    session = Session(tree_id, arch)
    config_url = args.query_parameters.get("config")
    session.build(config_url)
    if config_url:
        ui.navigate.history.replace(args.path + args.remaining_path)
        await session.load_url(config_url)


def root():
    ui.button.default_props("no-caps")
    ui.colors(primary="#2e7d32")
    ui.dark_mode(None)
    ui.add_css(Path(__file__).with_name("style.css").read_text())
    ui.sub_pages({"/": home, "/{tree_id}/{arch}": shell}, show_404=False)


@app.middleware("http")
async def no_store(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/_nicegui/"):
        response.headers["Cache-Control"] = "no-store"
    return response


ui.run(
    root,
    title="Kconfig",
    favicon="🐧",
    port=8080,
    show=False,
    reload=False,
    storage_secret=os.environ.get("STORAGE_SECRET") or os.urandom(16).hex(),
)
