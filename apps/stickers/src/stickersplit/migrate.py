"""One-off import from the old PhotoPrism catalogue, straight into approved.

Delete this file, its include_router line in server.py and the "Import" tab in
static/app.js once the import is done.

PhotoPrism in public mode needs no login (checked against stickers.tplant.com.au):
    GET /api/v1/session                  -> config.downloadToken
    GET /api/v1/photos?count&offset      -> UID, Title, Hash, TakenAt
    GET /api/v1/photos/{uid}             -> Labels[].Label.Name, LabelSrc ("manual" = our tags)
    GET /api/v1/dl/{hash}?t=<token>      -> the original PNG, alpha and DPI intact
"""

from __future__ import annotations

import json
import threading
from io import BytesIO
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends
from PIL import Image
from pydantic import BaseModel


class Source(BaseModel):
    url: str = "https://stickers.tplant.com.au"
    creator: str = ""


def fetch(url: str) -> bytes:
    # Cloudflare's bot filter answers 403 to urllib's default User-Agent.
    with urlopen(Request(url, headers={"User-Agent": "stickers-migrate"}), timeout=120) as r:
        return r.read()


def run(store, src: Source, status: dict) -> None:
    api = src.url.rstrip("/") + "/api/v1"
    get = lambda path: json.loads(fetch(api + path))
    try:
        token = get("/session")["config"]["downloadToken"]
        photos: list[dict] = []
        while batch := get(f"/photos?count=500&offset={len(photos)}&merged=true&order=added"):
            photos += batch
        status["total"] = len(photos)
        for p in photos:
            id = "pp" + p["UID"]  # rerunning skips what is already here
            if id in store.items:
                status["skipped"] += 1
                continue
            try:
                labels = get(f"/photos/{p['UID']}").get("Labels") or []
                with Image.open(BytesIO(fetch(f"{api}/dl/{p['Hash']}?t={token}"))) as im:
                    im.load()
                store.add(
                    im,
                    "approved",
                    id=id,
                    title=p.get("Title") or "",
                    creator=src.creator,
                    tags=[x["Label"]["Name"] for x in labels if x.get("LabelSrc") == "manual"],
                    added=p.get("TakenAt"),
                )
                status["imported"] += 1
            except Exception as e:
                status["errors"].append(f"{p.get('Title') or p['UID']}: {e}")
    except Exception as e:
        status["errors"].append(f"{src.url}: {e}")
    finally:
        status["running"] = False


def router(store, admin) -> APIRouter:
    r = APIRouter(dependencies=[Depends(admin)])
    status: dict = {"running": False}

    @r.get("/api/migrate")
    def progress():
        return status

    @r.post("/api/migrate")
    def start(src: Source):
        if not status["running"]:
            status.clear()
            status.update(running=True, source=src.url, total=0, imported=0, skipped=0, errors=[])
            threading.Thread(target=run, args=(store, src, status), daemon=True).start()
        return status

    return r
