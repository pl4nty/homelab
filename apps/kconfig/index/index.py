import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import kconfiglib
from kconfiglib import (
    AND,
    BOOL,
    EQUAL,
    GREATER,
    GREATER_EQUAL,
    HEX,
    INT,
    LESS,
    LESS_EQUAL,
    MENU,
    NOT,
    OR,
    STRING,
    TRISTATE,
    UNEQUAL,
    Choice,
    Symbol,
)

SPARSE = ["/Makefile", "**/Kconfig*", "/scripts/", "/arch/*/configs/"]
SRCARCH = {"x86_64": "x86", "i386": "x86"}
CROSS = {
    "arm64": "aarch64-linux-gnu-",
    "riscv": "riscv64-linux-gnu-",
    "arm": "arm-linux-gnueabihf-",
}
TYPES = {BOOL: "bool", TRISTATE: "tristate", STRING: "string", INT: "int", HEX: "hex"}
OPS = {
    AND: "&",
    OR: "|",
    NOT: "!",
    EQUAL: "=",
    UNEQUAL: "!=",
    LESS: "<",
    LESS_EQUAL: "<=",
    GREATER: ">",
    GREATER_EQUAL: ">=",
}


def fetch(src, dest):
    url, ref = src.split("#")
    git = ["git", "-C", str(dest)]
    dest.mkdir(parents=True)
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "sparse-checkout", "set", "--no-cone", *SPARSE], check=True)
    subprocess.run([*git, "fetch", "-q", "--depth=1", "--filter=blob:none", url, ref], check=True)
    subprocess.run([*git, "checkout", "-q", "FETCH_HEAD"], check=True)
    commit = subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    make = (dest / "Makefile").read_text()
    parts = [
        re.search(rf"^{k} = (\S*)", make, re.MULTILINE)
        for k in ("VERSION", "PATCHLEVEL", "SUBLEVEL")
    ]
    version = ".".join(m.group(1) for m in parts if m and m.group(1))
    return url.removesuffix(".git"), commit, version


def load(src, arch, version):
    cross = CROSS.get(arch, "")
    os.environ.update(
        srctree=str(src),
        ARCH=arch,
        SRCARCH=SRCARCH.get(arch, arch),
        KERNELVERSION=version,
        CC=f"{cross}gcc",
        LD=f"{cross}ld",
        HOSTCC="gcc",
        HOSTCXX="g++",
        RUSTC="rustc",
        BINDGEN="bindgen",
        PAHOLE="pahole",
    )
    os.chdir(src)
    return kconfiglib.Kconfig("Kconfig", warn=False)


class Exporter:
    def __init__(self, kconf):
        self.kconf = kconf
        self.sym_ids = {}
        self.choice_ids = {c: i for i, c in enumerate(kconf.unique_choices)}
        self.expr_ids = {}
        self.syms = []
        self.exprs = []
        for sym in kconf.unique_defined_syms:
            self.sym(sym)

    def sym(self, sym):
        if sym in self.sym_ids:
            return self.sym_ids[sym]
        self.sym_ids[sym] = len(self.syms)
        self.syms.append(sym)
        return self.sym_ids[sym]

    def expr(self, e):
        if e.__class__ is Symbol:
            return self.sym(e)
        if e.__class__ is Choice:
            key = ("C", self.choice_ids[e])
        elif e[0] is NOT:
            key = ("!", self.expr(e[1]))
        else:
            key = (OPS[e[0]], self.expr(e[1]), self.expr(e[2]))
        if key not in self.expr_ids:
            self.expr_ids[key] = -1 - len(self.exprs)
            self.exprs.append(list(key))
        return self.expr_ids[key]

    def node(self, node):
        item = node.item
        out = {}
        if item.__class__ is Symbol:
            out["s"] = self.sym(item)
        elif item.__class__ is Choice:
            out["c"] = self.choice_ids[item]
        else:
            out["k"] = "menu" if item is MENU else "comment"
        if node.prompt:
            out["p"] = node.prompt[0]
            out["pc"] = self.expr(node.prompt[1])
        out["d"] = self.expr(node.dep)
        if item is MENU:
            out["v"] = self.expr(node.visibility)
        if getattr(node, "help", None):
            out["h"] = node.help
        if node.is_menuconfig and item.__class__ is Symbol:
            out["mc"] = 1
        out["f"] = node.filename
        out["l"] = node.linenr
        children = []
        child = node.list
        while child:
            children.append(self.node(child))
            child = child.next
        if children:
            out["ch"] = children
        return out

    def pairs(self, items):
        return [[self.expr(a), self.expr(b)] for a, b in items]

    def export(self):
        kconf = self.kconf
        top = self.node(kconf.top_node)
        choices = [
            {
                "n": c.name,
                "t": TYPES.get(c.orig_type, ""),
                "o": int(c.is_optional),
                "df": self.pairs(c.defaults),
                "sy": [self.sym(s) for s in c.syms],
            }
            for c in kconf.unique_choices
        ]
        syms = []
        i = 0
        while i < len(self.syms):
            sym = self.syms[i]
            i += 1
            if sym.is_constant:
                syms.append({"n": sym.name, "k": "const"})
                continue
            if not sym.nodes:
                syms.append({"n": sym.name, "k": "undef"})
                continue
            out = {
                "n": sym.name,
                "t": TYPES.get(sym.orig_type, ""),
                "d": self.expr(sym.direct_dep),
                "r": self.expr(sym.rev_dep),
                "w": self.expr(sym.weak_rev_dep),
            }
            if sym.defaults:
                out["df"] = self.pairs(sym.defaults)
            if sym.ranges:
                out["rg"] = [
                    [self.expr(lo), self.expr(hi), self.expr(c)] for lo, hi, c in sym.ranges
                ]
            if sym.selects:
                out["sel"] = self.pairs(sym.selects)
            if sym.implies:
                out["imp"] = self.pairs(sym.implies)
            if sym.choice:
                out["ch"] = self.choice_ids[sym.choice]
            if sym.env_var is not None or sym is kconf.defconfig_list:
                out["env"] = 1
            if sym.is_transitional:
                out["tr"] = 1
            syms.append(out)
        return {
            "title": kconf.top_node.prompt[0],
            "modules": self.sym_ids.get(kconf.modules),
            "syms": syms,
            "choices": choices,
            "exprs": self.exprs,
            "top": top,
        }


def write_gz(path, data):
    raw = gzip.compress(json.dumps(data, separators=(",", ":")).encode(), mtime=0)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest()[:16]


HEADER = "#\n# Automatically generated file; DO NOT EDIT.\n# {}\n#\n"


def index_arch(job):
    src, out, ref, tree, arch, version = job
    kconf = load(src, arch, version)
    data = Exporter(kconf).export()
    configs = src / "arch" / SRCARCH.get(arch, arch) / "configs"
    names = sorted(p.name for p in configs.iterdir()) if configs.is_dir() else []
    data["configs"] = names
    arch_out = out / tree / arch
    (arch_out / "configs").mkdir(parents=True)
    for name in names:
        (arch_out / "configs" / name).write_bytes((configs / name).read_bytes())
    digest = write_gz(out / tree / f"{arch}.json.gz", data)

    header = HEADER.format(kconf.top_node.prompt[0])
    arch_ref = ref / tree / arch
    arch_ref.mkdir(parents=True)
    for name in ["alldefconfig", *(n for n in names if n.endswith("defconfig"))]:
        kconf.load_config(str(configs / name) if name in names else os.devnull)
        (arch_ref / f"{name}.config").write_text(kconf._config_contents(header))
        (arch_ref / f"{name}.min").write_text(kconf._min_config_contents(""))
    return tree, arch, digest, [s["n"] for s in data["syms"] if "k" not in s], names


def main():
    sys.setrecursionlimit(100_000)
    trees = json.loads(sys.argv[1])
    work, out, ref = (Path(p).resolve() for p in sys.argv[2:5])
    jobs = []
    manifest = []
    for tree in trees:
        repo, commit, version = fetch(tree["src"], work / tree["id"])
        manifest.append(
            {k: tree[k] for k in ("id", "name", "arches")}
            | {"repo": repo, "commit": commit, "version": version, "configs": {}, "hash": {}}
        )
        jobs += [(work / tree["id"], out, ref, tree["id"], a, version) for a in tree["arches"]]
    keys = []
    names = {}
    with ProcessPoolExecutor() as pool:
        for tree, arch, digest, syms, configs in pool.map(index_arch, jobs):
            entry = next(t for t in manifest if t["id"] == tree)
            entry["configs"][arch] = configs
            entry["hash"][arch] = digest
            for name in syms:
                names.setdefault(name, []).append(len(keys))
            keys.append(f"{tree}/{arch}")
    digest = write_gz(out / "names.json.gz", {"keys": keys, "names": names})
    (out / "trees.json").write_text(json.dumps({"trees": manifest, "names": digest}, indent=1))


if __name__ == "__main__":
    main()
