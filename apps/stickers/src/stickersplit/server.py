"""stickers: one web app to submit scans, review and approve stickers, and browse the collection.

    STICKERS_DATA=./data SUBMIT_TOKEN=... ADMIN_TOKEN=... ANTHROPIC_API_KEY=... stickers

Anyone can browse /. /submit#<SUBMIT_TOKEN> uploads scans; /admin#<ADMIN_TOKEN> reviews
each sticker found in them, publishes it, and edits or deletes published stickers. Tokens live in the URL fragment, so they never
reach server logs or Referer headers; the page sends them as an X-Token header.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import secrets
import shutil
import tempfile
import threading
from collections import Counter
from io import BytesIO
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from . import colour, migrate
from .core import Options, split_scan
from .store import STATES, Store
from .tag import DEFAULT_MODEL, symmetry_angle, tag_one

log = logging.getLogger("stickers")
STATIC = Path(__file__).with_name("static")
SCAN_EXTS = {".png", ".tif", ".tiff", ".jpg", ".jpeg", ".bmp", ".webp"}
RANK = {None: 0, "submit": 1, "admin": 2}
Image.MAX_IMAGE_PIXELS = None  # scans are big; uploads are capped by max_mp instead


class Edit(BaseModel):
    title: str | None = None
    tags: list[str] | None = None
    comment: str | None = None
    creator: str | None = None
    rotate: float = 0.0
    warmth: float = 0.0
    tint: float = 0.0
    state: Literal["pending", "approved"] | None = None


class Worker:
    """Splits and tags one scan at a time, so concurrent uploads can't exhaust memory.
    Each scan waits in DATA/scans/ (with a .json sidecar) until done, so a restart resumes."""

    def __init__(self, store: Store, claude=None, model: str = DEFAULT_MODEL):
        self.store, self.claude, self.model = store, claude, model
        self.dir = store.root / "scans"
        self.dir.mkdir(exist_ok=True)
        self.q: queue.Queue[str] = queue.Queue()
        self.jobs: dict[str, dict] = {}
        for sidecar in sorted(self.dir.glob("*.json"), key=lambda p: p.stat().st_mtime):
            self.enqueue(json.loads(sidecar.read_text()))
        threading.Thread(target=self.run, daemon=True).start()

    def enqueue(self, job: dict) -> dict:
        (self.dir / f"{job['id']}.json").write_text(json.dumps(job))
        self.jobs[job["id"]] = {**job, "status": "queued", "stickers": 0}
        queued = dict(self.jobs[job["id"]])  # the worker thread mutates the live dict
        self.q.put(job["id"])
        return queued

    def run(self) -> None:
        while True:
            job = self.jobs[self.q.get()]
            try:
                self.process(job)
                job["status"] = "done"
            except Exception as e:  # one bad scan must not stop the queue
                log.exception("scan %s failed", job["name"])
                job["status"] = f"failed: {type(e).__name__}: {e}"[:300]
            for f in self.dir.glob(f"{job['id']}.*"):
                f.unlink()

    def process(self, job: dict) -> None:
        scan = self.dir / f"{job['id']}{job['ext']}"
        with tempfile.TemporaryDirectory(dir=self.store.root) as tmp:
            job["status"] = "finding stickers"
            stickers, _ = split_scan(scan, Path(tmp), Options())
            vocab = [
                t
                for t, _ in Counter(
                    t for m in list(self.store.items.values()) for t in m.tags
                ).most_common(60)
            ]
            for k, s in enumerate(stickers, 1):
                rec = s.to_dict()
                if self.claude:
                    job["status"] = f"titling and tagging {k} of {len(stickers)}"
                    try:
                        rec = tag_one(self.claude, Path(tmp), rec, self.model, vocab=vocab)
                    except Exception as e:  # the sticker is still worth reviewing untagged
                        log.warning("tagging %s failed: %s", rec["file"], e)
                with Image.open(Path(tmp) / rec["file"]) as im:
                    im.load()
                if "holo" in rec.get("tags", []):
                    im = colour.balance(im, *colour.auto(im))
                self.store.add(
                    im,
                    "pending",
                    title=rec.get("title", ""),
                    tags=rec.get("tags", []),
                    creator=job["creator"],
                    comment=job["comment"],
                )
                job["stickers"] = k


def create_app(
    data: Path,
    submit_token: str,
    admin_token: str,
    claude=None,
    model: str = DEFAULT_MODEL,
    max_mp: float = 150.0,
) -> FastAPI:
    store = Store(data)
    worker = Worker(store, claude, model)
    app = FastAPI(title="stickers", docs_url=None, redoc_url=None)
    app.state.store, app.state.worker = store, worker

    def role(x_token: str = Header("")) -> str | None:
        t = x_token.encode()
        if secrets.compare_digest(t, admin_token.encode()):
            return "admin"
        return "submit" if secrets.compare_digest(t, submit_token.encode()) else None

    def need(have: str | None, want: str | None) -> None:
        if RANK[have] < RANK[want]:
            raise HTTPException(403, "This link has expired or is wrong. Ask for a new one.")

    def get(id: str):
        if id not in store.items:
            raise HTTPException(404, "No such sticker")
        return store.items[id]

    @app.get("/api/me")
    def me(r=Depends(role)):
        return {"role": r, "tagging": claude is not None}

    @app.get("/api/stickers")
    def stickers(state: str = "approved", r=Depends(role)):
        if state not in STATES:
            raise HTTPException(400, "Unknown state")
        need(r, None if state == "approved" else "admin")
        return store.list(state)

    @app.post("/api/stickers/{id}")
    def edit(id: str, e: Edit, r=Depends(role)):
        need(r, "admin")
        get(id)
        return store.update(id, **e.model_dump())

    @app.delete("/api/stickers/{id}")
    def delete(id: str, r=Depends(role)):
        need(r, "admin")
        get(id)
        store.delete(id)
        return {"ok": True}

    @app.get("/api/stickers/{id}/symmetry")
    def symmetry(id: str, r=Depends(role)):
        need(r, "admin")
        with Image.open(store.path(get(id))) as im:
            a, s, s0 = symmetry_angle(im)
        return {"angle": a, "score": s, "score0": s0}

    @app.get("/api/stickers/{id}/balance")
    def balance(id: str, r=Depends(role)):
        need(r, "admin")
        with Image.open(store.thumb(get(id).id, 512)) as im:
            warmth, tint = colour.auto(im)
        return {"warmth": warmth, "tint": tint}

    @app.get("/api/stickers/{id}/similar")
    def similar(id: str, r=Depends(role)):
        need(r, "admin")
        get(id)
        return store.similar(id)

    @app.post("/api/scans")
    def upload(file: UploadFile, creator: str = Form(""), comment: str = Form(""), r=Depends(role)):
        need(r, "submit")
        ext = Path(file.filename or "").suffix.lower()
        if ext not in SCAN_EXTS:
            raise HTTPException(400, f"Upload a scan as {', '.join(sorted(SCAN_EXTS))}")
        id = secrets.token_hex(6)
        dst = worker.dir / f"{id}{ext}"
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        try:
            with Image.open(dst) as im:
                mp = im.width * im.height / 1e6
        except Exception:
            dst.unlink()
            raise HTTPException(400, "That file isn't an image this app can read.")
        if mp > max_mp:
            dst.unlink()
            raise HTTPException(
                413,
                f"That scan is {mp:.0f} megapixels; the limit is {max_mp:.0f}. Scan at 600 dpi.",
            )
        return worker.enqueue(
            {
                "id": id,
                "ext": ext,
                "name": file.filename,
                "creator": creator.strip(),
                "comment": comment.strip(),
            }
        )

    @app.get("/api/scans")
    def scans(r=Depends(role)):
        need(r, "admin")
        return list(worker.jobs.values())

    @app.get("/api/scans/{id}")
    def scan(
        id: str, r=Depends(role)
    ):  # submitters see only the scans they uploaded (ids are random)
        need(r, "submit")
        if id not in worker.jobs:
            raise HTTPException(404, "No such scan")
        return worker.jobs[id]

    # Image URLs are public: pending stickers have unguessable ids, and a reverse image
    # search needs to fetch the image without a token.
    @app.get("/i/{id}.png")
    def original(id: str):
        m = get(id)
        return FileResponse(
            store.path(m),
            media_type="image/png",
            filename=f"{m.title or m.id}.png",
            content_disposition_type="inline",
        )

    @app.get("/i/{id}/preview.webp")
    def preview(id: str, warmth: float = 0.0, tint: float = 0.0):
        """The editor's colour preview, computed by the same code as the save."""
        get(id)
        with Image.open(store.thumb(id, 1024)) as im:
            out = BytesIO()
            colour.balance(im, max(-2.0, min(2.0, warmth)), max(-2.0, min(2.0, tint))).save(
                out, "WEBP", quality=85
            )
        return Response(out.getvalue(), media_type="image/webp")

    @app.get("/i/{id}/{px}.webp")
    def thumb(id: str, px: int):
        get(id)
        # Bytes, not FileResponse: an edit can purge the cached file before it would be streamed.
        return Response(
            store.thumb(id, px).read_bytes(),
            media_type="image/webp",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @app.exception_handler(FileNotFoundError)
    def gone(request, exc):  # deleted or moved between the lookup and the read
        return JSONResponse({"detail": "No such sticker"}, 404)

    app.include_router(migrate.router(store, lambda r=Depends(role): need(r, "admin")))

    index = lambda: FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
    for path in ("/", "/submit", "/admin"):
        app.get(path, include_in_schema=False)(index)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    data = Path(os.environ.get("STICKERS_DATA", "data"))
    tokens = {
        k: os.environ.get(k) or secrets.token_urlsafe(18) for k in ("SUBMIT_TOKEN", "ADMIN_TOKEN")
    }
    claude = None
    if os.environ.get("ANTHROPIC_API_KEY"):
        import anthropic

        claude = anthropic.Anthropic(max_retries=5)
    port = int(os.environ.get("PORT", "8000"))
    base = os.environ.get("PUBLIC_URL", f"http://localhost:{port}").rstrip("/")
    for k, v in tokens.items():
        print(
            f"{k.split('_')[0].lower():>6} link: {base}/{k.split('_')[0].lower()}#{v}"
            + ("" if os.environ.get(k) else "   (random; set " + k + " to keep it)")
        )
    print(f"tagging: {'Claude ' + DEFAULT_MODEL if claude else 'off (set ANTHROPIC_API_KEY)'}")
    app = create_app(
        data,
        tokens["SUBMIT_TOKEN"],
        tokens["ADMIN_TOKEN"],
        claude,
        max_mp=float(os.environ.get("MAX_MEGAPIXELS", "150")),
    )
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=port, proxy_headers=True)
