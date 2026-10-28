"""The pages in a real browser (Playwright + Chromium), at desktop and phone sizes.

Skipped unless Playwright and its Chromium are installed:
    pip install playwright && playwright install chromium
"""

import math
import threading
import time

import pytest

from PIL import Image

from stickersplit.server import create_app
from test_server import sticker
from test_split import SHAPES, make_scan

sync_api = pytest.importorskip("playwright.sync_api")
uvicorn = pytest.importorskip("uvicorn")

VIEWPORTS = {
    "desktop": dict(viewport={"width": 1440, "height": 900}),
    "phone": dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True),
}
COLOURS = [(220, 40, 40), (30, 120, 220), (240, 190, 30), (40, 170, 90), (150, 60, 200)]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    data = tmp_path_factory.mktemp("data")
    app = create_app(data, "sub-token", "adm-token")
    st = app.state.store
    for i in range(24):                      # varied aspect ratios, like real stickers
        w, h = [(40, 20), (30, 60), (50, 50), (90, 25), (35, 45)][i % 5]
        st.add(sticker(w, h, color=COLOURS[i % 5] + (255,)), "approved", title=f"Sticker {i}",
               tags=["holo"] if i % 3 == 0 else ["club", "australia"] if i % 3 == 1 else ["ctf"],
               comment="From a swap", creator="Tom", added=f"2026-10-{i + 1:02d}")
    for i in range(3):
        st.add(sticker(40, 30), "pending", title=f"Pending {i}", creator="Bo")
    srv = uvicorn.Server(uvicorn.Config(app, port=0, log_level="warning"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    while not srv.started:
        time.sleep(0.05)
    port = srv.servers[0].sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", app
    srv.should_exit = True


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:
            pytest.skip(f"no Chromium for Playwright: {e}")
        yield b
        b.close()


@pytest.fixture(params=list(VIEWPORTS))
def page(request, browser):
    ctx = browser.new_context(**VIEWPORTS[request.param])
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
    pg.kind = request.param
    yield pg
    assert pg.errors == []
    ctx.close()


def no_sideways_scroll(pg):
    assert pg.evaluate("document.documentElement.scrollWidth <= innerWidth")


def test_gallery_rows_fill_the_width(page, server):
    url, _ = server
    page.goto(url)
    page.wait_for_selector(".tile img")
    rows = page.evaluate("""[...document.querySelectorAll('.row')].map(r => {
        const t = [...r.children].map(c => c.getBoundingClientRect());
        const g = r.parentElement.getBoundingClientRect();
        return {left: t[0].left, right: t.at(-1).right, h: r.getBoundingClientRect().height, width: g.width, x0: g.left}; })""")
    assert len(rows) >= 2
    for r in rows[:-1]:                       # every full row spans the grid exactly
        assert r["left"] == pytest.approx(r["x0"], abs=1)
        assert r["right"] == pytest.approx(r["x0"] + r["width"], abs=2)
    assert rows[-1]["h"] <= (104 if page.kind == "phone" else 168) + 1   # the last row is not stretched
    # each tile shows the whole sticker at its own aspect ratio
    ratios = page.evaluate("""[...document.querySelectorAll('.tile')].map(t => {
        const b = t.getBoundingClientRect(), i = t.querySelector('img'); return [b.width / b.height, i.width / i.height]; })""")
    for a, b in ratios:
        assert a == pytest.approx(b, rel=0.03)
    no_sideways_scroll(page)
    page.screenshot(path=f"/tmp/ui-{page.kind}-gallery.png")


def test_search_tags_and_viewer(page, server):
    url, _ = server
    page.goto(url)
    page.wait_for_selector(".tile")
    assert page.locator(".tile").count() == 24
    page.fill("#q", "sticker 1")             # every word matches anywhere: 1, 10-19, 21
    assert page.locator(".tile").count() == 12 and "?q=sticker+1" in page.url
    page.fill("#q", "")
    page.click(".chips .chip[data-tag=club]")
    assert page.locator(".tile").count() == 8 and "tag=club" in page.url
    page.click(".chips .chip[data-tag=australia]")  # AND: still 8, both chips pressed
    assert page.locator(".tile").count() == 8
    assert page.locator(".chip[aria-pressed=true]").count() == 2
    page.fill("#q", "nothing like this")
    assert "No stickers match" in page.inner_text(".empty")
    page.click("[data-clear]")
    assert page.locator(".tile").count() == 24 and "tag=" not in page.url

    order = page.eval_on_selector_all(".tile img", "els => els.map(e => e.alt)")
    assert sorted(order) == sorted(f"Sticker {i}" for i in range(24))
    assert order != [f"Sticker {i}" for i in range(23, -1, -1)]     # shuffled, not newest first
    page.reload()
    page.wait_for_selector(".tile")
    assert page.eval_on_selector_all(".tile img", "els => els.map(e => e.alt)") == order   # same tab, same order

    page.click(".tile >> nth=0")
    page.wait_for_selector("dialog .view img")
    first = page.inner_text("dialog h1")
    assert first == order[0]
    k = int(first.split()[-1])
    w, h = [(40, 20), (30, 60), (50, 50), (90, 25), (35, 45)][k % 5]
    tag = ["#holo", "#club", "#ctf"][k % 3]
    side = page.inner_text("dialog .side")
    assert f"{w} × {h}" in side and tag in side and "From a swap" in side and "Tom" in side
    assert page.locator(".count").count() == 0 and page.get_attribute("#q", "placeholder") == "Search 24 stickers"
    lens = page.get_attribute("dialog a[href*=lens]", "href")
    assert lens.startswith("https://lens.google.com/uploadbyurl?url=http%3A%2F%2F127.0.0.1")
    page.keyboard.press("ArrowRight")
    assert page.inner_text("dialog h1") == order[1] and "s=" in page.url
    page.click("dialog .nav.prev")
    assert page.inner_text("dialog h1") == first
    page.screenshot(path=f"/tmp/ui-{page.kind}-viewer.png")
    no_sideways_scroll(page)
    deep = page.url
    page.keyboard.press("Escape")
    page.wait_for_selector("dialog", state="detached")
    assert "s=" not in page.url
    page.goto(deep)                                             # shared link opens the sticker
    page.wait_for_selector("dialog h1")
    assert page.inner_text("dialog h1") == first
    tag = tag[1:]
    page.click(f"dialog .chip[data-tag={tag}]")                # a tag in the viewer filters
    page.wait_for_selector("dialog", state="detached")
    assert page.locator(".tile").count() == 8


def test_bad_link_explains(page, server):
    url, _ = server
    page.goto(f"{url}/admin#sub-token")                          # submit link can't open admin
    assert "expired or is wrong" in page.inner_text(".empty")
    page.goto(f"{url}/submit#nope")
    page.reload()
    assert "expired or is wrong" in page.inner_text(".empty")


def test_upload_review_publish_edit(page, server, tmp_path):
    url, app = server
    st = app.state.store
    for m in st.list("pending"):                                     # left by a failed run
        if m["creator"] == "Ana":
            st.delete(m["id"])
    page.goto(f"{url}/submit#sub-token")
    page.wait_for_selector(".upload")
    assert page.locator(".tile").count() == 0 and page.is_hidden("#q")    # submitters only upload
    page.set_input_files("[type=file]", str(make_scan(tmp_path / f"scan-{page.kind}.png")))
    page.fill(".upload [name=creator]", "Ana")
    page.fill(".upload [name=comment]", "Swap table")
    page.click(".upload .primary")
    page.wait_for_function("document.querySelector('.jobs .st')?.textContent === 'done: 4 stickers'", timeout=60000)
    no_sideways_scroll(page)
    new = [m for m in st.list("pending") if m["creator"] == "Ana"]
    assert len(new) == len(SHAPES)
    new.sort(key=lambda m: -m["w_mm"] * m["h_mm"])      # the biggest rectangle: the flat circle has no keypoints
    with Image.open(st.path(st.items[new[0]["id"]])) as im:             # an earlier scan of one of them
        im.load()
        earlier = st.add(im, "approved", title="Earlier copy").id

    page.goto(f"{url}/admin?s={new[0]['id']}#adm-token")             # a link straight to one sticker
    page.wait_for_function("document.querySelector('.stage img')?.style.transform")
    assert page.input_value("dialog [name=comment]") == "Swap table"
    page.wait_for_selector(".dupes:not([hidden])")
    assert "Same sticker?" in page.inner_text(".dupes") and "Earlier copy" in page.inner_text(".dupes")
    page.click("[data-turn='90']")
    page.click("[data-turn='1']")
    assert page.inner_text(".readout").startswith("91°")
    page.click("[data-act=fit]")
    page.fill("dialog [name=title]", "Reviewed")
    page.fill("dialog [name=tags]", "Holo, ctf, holo")
    page.eval_on_selector("[name=warmth]", "e => { e.value = 0.5; e.dispatchEvent(new Event('input', {bubbles: true})) }")
    page.wait_for_function("document.querySelector('.stage img').src.includes('preview.webp?warmth=0.5')")
    page.screenshot(path=f"/tmp/ui-{page.kind}-editor.png")
    no_sideways_scroll(page)
    page.click("dialog [name=title]")
    page.keyboard.press("Enter")                                     # Enter publishes
    page.wait_for_selector(".toast.on")
    assert page.inner_text(".toast") == "Published"
    m = st.items[new[0]["id"]]
    assert (m.state, m.title, m.tags, m.creator) == ("approved", "Reviewed", ["holo", "ctf"], "Ana")
    before = len(st.list("pending"))
    page.click("[data-act=delete]")                                  # next one: reject, two clicks
    assert "click again" in page.inner_text("[data-act=delete]")
    page.click("[data-act=delete]")
    page.wait_for_selector(".toast.on >> text=Rejected")
    assert len(st.list("pending")) == before - 1
    page.keyboard.press("Escape")

    # the public viewer offers Edit on this browser; the admin edits the comment, then deletes
    page.goto(f"{url}/?q=reviewed")
    page.click(".tile >> nth=0")
    page.click("dialog a:text('Edit')")
    page.wait_for_function("document.querySelector('.stage img')?.style.transform")
    page.fill("dialog [name=comment]", "Swapped for a pin")
    assert page.inner_text(".actions .primary") == "Save changes"
    page.click(".actions .primary")
    page.wait_for_selector(".toast.on >> text=Saved")
    assert st.items[new[0]["id"]].comment == "Swapped for a pin"
    page.click("[data-act=delete]")
    page.click("[data-act=delete]")
    page.wait_for_selector(".toast.on >> text=Deleted")
    assert new[0]["id"] not in st.items
    for m in st.list("pending"):                                     # clean up for the other viewport
        if m["creator"] == "Ana":
            st.delete(m["id"])
    st.delete(earlier)


def test_editor_gestures(page, server):
    url, app = server
    page.goto(f"{url}/admin#adm-token")
    page.click(".tabs a[data-tab=approved]")
    page.click(".tile >> nth=0")
    page.wait_for_function("document.querySelector('.stage img')?.style.transform")
    box = page.locator(".stage").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def pointers(*paths, kind="touch"):
        """Dispatch pointer events along paths: [(x, y), ...] per finger."""
        page.evaluate("""([paths, kind, n]) => {
            const s = document.querySelector('.stage'), ev = (t, id, [x, y]) => s.dispatchEvent(new PointerEvent(t,
                {pointerId: id, pointerType: kind, clientX: x, clientY: y, bubbles: true, isPrimary: id === 1}));
            paths.forEach((p, k) => ev('pointerdown', k + 1, p[0]));
            for (let i = 1; i < n; i++) paths.forEach((p, k) => ev('pointermove', k + 1, p[i]));
            paths.forEach((p, k) => ev('pointerup', k + 1, p.at(-1)));
        }""", [paths, kind, len(paths[0])])

    # pinch out to 2x while twisting 20 degrees clockwise
    steps = [i / 5 for i in range(6)]
    arm = [(40 * (1 + s) * math.cos(math.radians(20 * s)), 40 * (1 + s) * math.sin(math.radians(20 * s))) for s in steps]
    f1 = [(cx - dx, cy - dy) for dx, dy in arm]
    f2 = [(cx + dx, cy + dy) for dx, dy in arm]
    pointers(f1, f2)
    assert page.inner_text(".readout") == "20°, 200%"
    page.click("[data-act=fit]")
    # level: a line drawn 4 degrees below horizontal turns the sticker 4 degrees back
    page.click("[data-tool=level]")
    pointers([(cx - 100, cy), (cx + 100, cy + 200 * math.tan(math.radians(4)))], kind="mouse")
    assert page.inner_text(".readout") == "16°"
    page.click("[data-tool=rotate]")
    # one-finger drag around the centre rotates
    pointers([(cx + 100, cy), (cx + 100 * math.cos(math.radians(30)), cy + 100 * math.sin(math.radians(30)))])
    assert page.inner_text(".readout") == "46°"
    page.screenshot(path=f"/tmp/ui-{page.kind}-gestures.png")
