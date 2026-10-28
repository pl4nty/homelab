"""The web app over HTTP (FastAPI TestClient): store and XMP, permissions, the scan
queue, editing, and the PhotoPrism import against an in-process mock."""

import io
import json
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_split import SHAPES, make_scan
from test_tag import _reply

from stickersplit.server import create_app
from stickersplit.store import Store
from stickersplit.tag import FINE_SCHEMA

SUB, ADM = {"X-Token": "sub-token"}, {"X-Token": "adm-token"}


def sticker(w_mm=40, h_mm=20, pad_mm=1, dpi=600, color=(200, 30, 30, 255)) -> Image.Image:
    px = lambda mm: round(mm / 25.4 * dpi)  # noqa: E731
    im = Image.new("RGBA", (px(w_mm + 2 * pad_mm), px(h_mm + 2 * pad_mm)), (0, 0, 0, 0))
    im.paste(color, (px(pad_mm), px(pad_mm), px(pad_mm + w_mm), px(pad_mm + h_mm)))
    im.info["dpi"] = (dpi, dpi)
    return im


class Tagger:
    """Fake Claude: titles every sticker, fails on the second one."""

    def __init__(self):
        self.messages, self.n = self, 0

    def create(self, **req):
        self.n += 1
        if req["output_config"]["format"]["schema"] is FINE_SCHEMA:   # die-cut fine pass: as is
            return _reply(panel="E")
        if self.n == 2:
            raise RuntimeError("overloaded")
        return _reply(title=f"Sticker {self.n}", tags=["Holo", "CTF"])


def wait(cond, t=120):
    end = time.time() + t
    while not cond():
        assert time.time() < end, "timed out"
        time.sleep(0.1)


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "data", "sub-token", "adm-token", claude=Tagger(), max_mp=20)


@pytest.fixture
def client(app):
    return TestClient(app)


def test_xmp_round_trip_size_and_dpi(tmp_path):
    s = Store(tmp_path)
    m = s.add(sticker(), "approved", title='Key & "Lock" <3', tags=["Holo", " holo", "CTF"],
              comment="Swapped at BSides\nday 2", creator="Ana")
    assert (m.w_mm, m.h_mm) == (40.0, 20.0)                # alpha outline, not the padded image
    again = Store(tmp_path).items[m.id]                     # re-read from the file alone
    assert again == m and again.tags == ["holo", "ctf"] and again.comment == "Swapped at BSides\nday 2"
    im = Image.open(s.path(m))
    assert im.info["dpi"][0] == pytest.approx(600, abs=0.01) and im.mode == "RGBA"
    if shutil.which("exiftool"):                             # what other tools see
        x = json.loads(subprocess.check_output(["exiftool", "-j", "-XMP:all", str(s.path(m))]))[0]
        assert x["Title"] == 'Key & "Lock" <3' and x["Subject"] == ["holo", "ctf"]
        assert x["Creator"] == "Ana" and x["UserComment"] == "Swapped at BSides\nday 2"


def test_update_rotates_moves_and_keeps_metadata(tmp_path):
    s = Store(tmp_path)
    m = s.add(sticker(), "pending", title="T", creator="Ana")
    thumb = s.thumb(m.id, 300)
    assert thumb.name.endswith("-512.webp") and Image.open(thumb).size == (512, 512 * 22 // 42)
    m2 = s.update(m.id, rotate=90, state="approved", tags=["new"])
    assert (m2.w_mm, m2.h_mm, m2.state, m2.title, m2.creator, m2.tags) == (20.0, 40.0, "approved", "T", "Ana", ["new"])
    assert not (tmp_path / "pending" / f"{m.id}.png").exists() and not thumb.exists()
    m3 = s.update(m.id, rotate=-30)
    assert m3.w_mm > 20 and Image.open(s.path(m3)).info["dpi"][0] == pytest.approx(600, abs=0.01)
    s.delete(m.id)
    assert m.id not in s.items and not s.path(m3).exists()


def test_permissions(client, app):
    st = app.state.store
    ids = {state: st.add(sticker(), state).id for state in ("pending", "approved")}
    assert [m["id"] for m in client.get("/api/stickers").json()] == [ids["approved"]]
    assert client.get("/api/stickers?state=pending").status_code == 403
    assert client.get("/api/stickers?state=pending", headers=SUB).status_code == 403   # review is admin-only
    assert client.get("/api/stickers?state=pending", headers=ADM).status_code == 200
    assert client.get("/api/me", headers={"X-Token": "sub-tokenX"}).json()["role"] is None
    assert client.get("/api/me", headers={"X-Token": "é".encode("latin-1")}).json()["role"] is None

    edit = lambda id, h, **b: client.post(f"/api/stickers/{id}", headers=h, json=b).status_code  # noqa: E731
    for id in ids.values():
        assert edit(id, SUB, title="x") == 403 and edit(id, {}, title="x") == 403
        assert client.delete(f"/api/stickers/{id}", headers=SUB).status_code == 403
        for path in ("similar", "balance", "symmetry"):
            assert client.get(f"/api/stickers/{id}/{path}", headers=SUB).status_code == 403
    assert edit(ids["pending"], ADM, state="approved") == 200
    assert edit(ids["approved"], ADM, state="pending") == 200         # unpublish
    assert client.delete(f"/api/stickers/{ids['pending']}", headers=ADM).status_code == 200
    assert client.post("/api/scans", headers={}, files={"file": ("a.png", b"x")}).status_code == 403
    assert client.get("/api/scans", headers=SUB).status_code == 403   # submitters see only their own scans
    assert client.post("/api/migrate", json={}).status_code == 403
    assert client.get("/i/nope/256.webp").status_code == 404


def test_admin_edits_title_comment_tags_and_colour(client, app):
    m = app.state.store.add(sticker(color=(150, 190, 240, 255)), "approved", title="Old", tags=["a"])
    r = client.post(f"/api/stickers/{m.id}", headers=ADM, json={
        "title": "New", "comment": "Swapped", "tags": ["Holo", ""], "warmth": 0.5, "tint": 0.2})
    assert r.status_code == 200
    j = r.json()
    assert (j["title"], j["comment"], j["tags"], j["state"]) == ("New", "Swapped", ["holo"], "approved")
    r_, g_, b_ = Image.open(app.state.store.path(app.state.store.items[m.id])).convert("RGB").getpixel((100, 100))
    assert r_ > 150 and b_ < 240                                      # warmer: less blue, more red
    prev = client.get(f"/i/{m.id}/preview.webp?warmth=0.5&tint=0")
    assert prev.status_code == 200 and prev.headers["content-type"] == "image/webp"


def test_scan_is_split_tagged_and_queued_for_review(client, app, tmp_path):
    scan = make_scan(tmp_path / "scan.png")
    r = client.post("/api/scans", headers=SUB, data={"creator": " Ana ", "comment": "Swap table"},
                    files={"file": ("my scan.png", scan.read_bytes(), "image/png")})
    assert r.status_code == 200 and r.json()["status"] == "queued"
    job = r.json()["id"]
    wait(lambda: client.get(f"/api/scans/{job}", headers=SUB).json()["status"] == "done")
    assert client.get(f"/api/scans/{job}", headers=SUB).json()["stickers"] == len(SHAPES)
    assert [j["name"] for j in client.get("/api/scans", headers=ADM).json()] == ["my scan.png"]
    queued = client.get("/api/stickers?state=pending", headers=ADM).json()
    assert len(queued) == len(SHAPES)
    assert all(d["creator"] == "Ana" and d["comment"] == "Swap table" for d in queued)
    titled = [d for d in queued if d["title"]]
    assert len(titled) == len(SHAPES) - 1                     # one tagging failure, still queued
    assert all(d["tags"] == ["holo", "ctf"] for d in titled)
    assert sorted((d["w_mm"], d["h_mm"]) for d in queued)[0] == pytest.approx((30, 60), abs=1.5)
    assert not list((app.state.store.root / "scans").iterdir())  # scan removed once done

    d = queued[0]
    assert client.get(f"/i/{d['id']}/256.webp").headers["content-type"] == "image/webp"
    assert client.get(f"/i/{d['id']}.png").content[:8] == b"\x89PNG\r\n\x1a\n"
    sym = client.get(f"/api/stickers/{d['id']}/symmetry", headers=ADM).json()
    assert set(sym) == {"angle", "score", "score0"}

    # the same scan again: each sticker is flagged as a duplicate of its first copy (except
    # the one whose first copy failed tagging, so missed the holo colour correction)
    client.post("/api/scans", headers=SUB, files={"file": ("again.png", scan.read_bytes(), "image/png")})
    wait(lambda: len(client.get("/api/stickers?state=pending", headers=ADM).json()) == 2 * len(SHAPES))
    first = {d["id"] for d in queued}
    again = [d for d in client.get("/api/stickers?state=pending", headers=ADM).json() if d["id"] not in first]
    found = [client.get(f"/api/stickers/{d['id']}/similar", headers=ADM).json() for d in again]
    assert sum(bool(f) and f[0]["kind"] == "duplicate" and f[0]["id"] in first for f in found) >= len(SHAPES) - 1


def test_upload_rejects_bad_and_huge_files(client, tmp_path):
    r = client.post("/api/scans", headers=SUB, files={"file": ("x.png", b"not an image")})
    assert r.status_code == 400
    assert client.post("/api/scans", headers=SUB, files={"file": ("x.pdf", b"%PDF")}).status_code == 400
    big = io.BytesIO()
    Image.new("L", (5000, 5000)).save(big, "PNG")              # 25 MP > max_mp=20
    r = client.post("/api/scans", headers=SUB, files={"file": ("big.png", big.getvalue())})
    assert r.status_code == 413 and "limit is 20" in r.json()["detail"]
    assert client.get("/api/scans", headers=ADM).json() == []


def test_queued_scan_survives_restart(tmp_path):
    data = tmp_path / "data"
    (data / "scans").mkdir(parents=True)
    shutil.copy(make_scan(tmp_path / "s.png"), data / "scans" / "abc.png")
    (data / "scans" / "abc.json").write_text(json.dumps(
        {"id": "abc", "ext": ".png", "name": "s.png", "creator": "", "comment": ""}))
    app = create_app(data, "s", "a")
    wait(lambda: app.state.worker.jobs["abc"]["status"] == "done")
    assert len(app.state.store.list("pending")) == len(SHAPES)


class MockPhotoPrism(BaseHTTPRequestHandler):
    PNG = io.BytesIO()
    sticker().save(PNG, "PNG", dpi=(600, 600))
    PHOTOS = [{"UID": f"p{i}", "Title": f"Photo {i}", "Hash": f"h{i}", "TakenAt": f"2026-10-2{i}T00:00:00Z",
               "Caption": "LINE 1 / LINE 2\nSize: 40 × 20 mm"} for i in range(3)]

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if self.headers["User-Agent"].startswith("Python-urllib"):     # like Cloudflare
            return self.send_error(403)
        if path == "/api/v1/session":
            body = {"config": {"downloadToken": "dl"}}
        elif path == "/api/v1/photos":
            body = self.PHOTOS if "offset=0" in self.path else []
        elif path.startswith("/api/v1/photos/"):
            body = {"Labels": [{"Label": {"Name": "Holo"}, "LabelSrc": "manual"},
                               {"Label": {"Name": "Blue"}, "LabelSrc": "keyword"}]}
        elif path == "/api/v1/dl/h1" and self.path.endswith("t=dl"):
            return self.send_error(500)
        elif path.startswith("/api/v1/dl/") and self.path.endswith("t=dl"):
            data = self.PNG.getvalue()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        else:
            return self.send_error(404)
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def test_migrate_from_photoprism(client, app):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), MockPhotoPrism)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        run = lambda: client.post("/api/migrate", headers=ADM, json={"url": url, "creator": "Tom"})  # noqa: E731
        run()
        wait(lambda: not client.get("/api/migrate", headers=ADM).json()["running"])
        s = client.get("/api/migrate", headers=ADM).json()
        assert (s["total"], s["imported"], s["skipped"], len(s["errors"])) == (3, 2, 0, 1)
        got = {m["id"]: m for m in client.get("/api/stickers").json()}
        assert set(got) == {"ppp0", "ppp2"}
        m = got["ppp0"]
        assert (m["title"], m["tags"], m["creator"]) == ("Photo 0", ["holo"], "Tom")
        assert (m["w_mm"], m["h_mm"], m["added"]) == (40.0, 20.0, "2026-10-20T00:00:00Z")
        run()                                                      # rerun skips what's there
        wait(lambda: not client.get("/api/migrate", headers=ADM).json()["running"])
        assert client.get("/api/migrate", headers=ADM).json()["skipped"] == 2
    finally:
        srv.shutdown()


def test_pages_are_served(client):
    for path in ("/", "/submit", "/admin"):
        r = client.get(path)
        assert r.status_code == 200 and "/static/app.js" in r.text
    assert client.get("/static/app.js").status_code == 200


def test_auto_colour_fixes_blue_foil_only():
    from stickersplit.colour import auto, balance
    blue = sticker(color=(120, 200, 245, 255))                     # foil that scanned cyan-blue
    w, t = auto(blue)
    assert w > 0.3
    r, g, b = balance(blue, w, t).convert("RGB").getpixel((100, 100))
    assert abs(b - r) < 25 and abs(g - (r + b) / 2) < 25            # neutral, not just less blue
    assert auto(sticker(color=(150, 200, 60, 255))) == (0.0, 0.0)      # a green design is left alone
    ink = sticker(color=(20, 30, 70, 255))                            # dark navy ink is not shifted
    assert balance(ink, 0.8, 0.3).convert("RGB").getpixel((100, 100)) == (20, 30, 70)
    assert balance(blue, 0.5, 0).info["dpi"] == (600, 600)
