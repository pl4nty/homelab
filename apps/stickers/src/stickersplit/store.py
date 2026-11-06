"""Sticker store: one PNG per sticker, its folder is its state, its XMP is its metadata.

    DATA/pending/<id>.png    split from a scan, waiting for an admin to review it
    DATA/approved/<id>.png   public
    DATA/cache/<id>-<v>-<px>.webp

XMP fields (Windows Explorer reads dc:title as Title, dc:subject as Tags and
dc:creator as Authors for PNG; exif:UserComment is Microsoft's source for Comments):
    dc:title         title
    dc:subject       tags
    exif:UserComment comment (how it was acquired)
    dc:creator       who submitted it
    xmp:CreateDate   when it was added
Physical size is not stored: it is the alpha bounding box divided by the PNG's DPI.
"""

from __future__ import annotations

import dataclasses
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from PIL import Image, PngImagePlugin

from . import similar
from .colour import balance
from .tag import rotate_image

STATES = ("pending", "approved")
SIZES = (256, 512, 1024, 2048)  # thumbnail long edges
NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "exif": "http://ns.adobe.com/exif/1.0/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
}
XMP_KEY = "XML:com.adobe.xmp"


@dataclasses.dataclass
class Meta:
    id: str
    state: str = "pending"
    title: str = ""
    tags: list[str] = dataclasses.field(default_factory=list)
    comment: str = ""
    creator: str = ""
    added: str = ""
    w: int = 0  # pixels
    h: int = 0
    w_mm: float = 0.0  # sticker outline, not the padded image
    h_mm: float = 0.0
    v: int = 0  # changes on every write; busts caches


EDITABLE = ("title", "tags", "comment", "creator")


def to_xmp(m: Meta) -> str:
    alt = lambda s: f'<rdf:Alt><rdf:li xml:lang="x-default">{escape(s)}</rdf:li></rdf:Alt>'
    tags = "".join(f"<rdf:li>{escape(t)}</rdf:li>" for t in m.tags)
    return (
        f'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="{NS["rdf"]}">'
        f'<rdf:Description rdf:about="" xmlns:dc="{NS["dc"]}" xmlns:exif="{NS["exif"]}" '
        f'xmlns:xmp="{NS["xmp"]}">'
        f"<dc:title>{alt(m.title)}</dc:title>"
        f"<dc:subject><rdf:Bag>{tags}</rdf:Bag></dc:subject>"
        f"<exif:UserComment>{alt(m.comment)}</exif:UserComment>"
        f"<dc:creator><rdf:Seq><rdf:li>{escape(m.creator)}</rdf:li></rdf:Seq></dc:creator>"
        f"<xmp:CreateDate>{escape(m.added)}</xmp:CreateDate>"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
    )


def from_xmp(raw: str) -> dict:
    d = ET.fromstring(raw).find(".//rdf:Description", NS)
    if d is None:
        return {}
    li = lambda tag: d.findtext(f"{tag}//rdf:li", "", NS)
    return {
        "title": li("dc:title"),
        "comment": li("exif:UserComment"),
        "creator": li("dc:creator"),
        "added": d.findtext("xmp:CreateDate", "", NS),
        "tags": [e.text or "" for e in d.findall("dc:subject//rdf:li", NS)],
    }


def clean_tags(tags) -> list[str]:
    return list(dict.fromkeys(t.strip().lower() for t in tags if t.strip()))


def dpi_of(im: Image.Image) -> float:
    return float((im.info.get("dpi") or (600,))[0]) or 600.0


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Store:
    def __init__(self, root: Path):
        self.root, self.lock = root, threading.RLock()
        self.items: dict[str, Meta] = {}
        self.thumbing = threading.Semaphore(2)  # bounds memory under a burst of requests
        for d in (*STATES, "cache"):
            (root / d).mkdir(parents=True, exist_ok=True)
        for s in STATES:
            for p in (root / s).glob("*.png"):
                self._index(p, s)

    def path(self, m: Meta) -> Path:
        return self.root / m.state / f"{m.id}.png"

    def _index(self, p: Path, state: str) -> Meta:
        with Image.open(p) as im:
            raw = im.info.get(XMP_KEY)
            alpha = im.getchannel("A") if "A" in im.getbands() else None
            box = (alpha.point(lambda v: 255 if v > 127 else 0).getbbox() if alpha else None) or (
                0,
                0,
                *im.size,
            )
            mm = lambda px: round(px / dpi_of(im) * 25.4, 1)
            m = Meta(
                id=p.stem,
                state=state,
                **(from_xmp(raw) if raw else {}),
                w=im.width,
                h=im.height,
                w_mm=mm(box[2] - box[0]),
                h_mm=mm(box[3] - box[1]),
                v=p.stat().st_mtime_ns // 1000 % 10**9,
            )
        self.items[m.id] = m
        return m

    def _write(self, m: Meta, im: Image.Image, dpi: float) -> Meta:
        p = self.path(m)
        info = PngImagePlugin.PngInfo()
        info.add_itxt(XMP_KEY, to_xmp(m))
        tmp = p.with_suffix(".tmp")
        im.save(tmp, "PNG", pnginfo=info, dpi=(dpi, dpi))
        tmp.replace(p)
        for f in (self.root / "cache").glob(f"{m.id}-*"):
            f.unlink(missing_ok=True)
        return self._index(p, m.state)

    def add(self, im: Image.Image, state: str = "pending", id: str | None = None, **fields) -> Meta:
        fields["tags"] = clean_tags(fields.get("tags") or [])
        m = Meta(
            id=id or secrets.token_urlsafe(9),
            state=state,
            added=fields.pop("added", None) or now(),
            **{k: v for k, v in fields.items() if k in EDITABLE},
        )
        with self.lock:
            return self._write(m, im, dpi_of(im))

    def update(
        self,
        id: str,
        rotate: float = 0.0,
        warmth: float = 0.0,
        tint: float = 0.0,
        state: str | None = None,
        **fields,
    ) -> Meta:
        """Edit metadata, white-balance, rotate clockwise by `rotate` degrees, and/or change state."""
        with self.lock:
            old = self.items[id]
            with Image.open(self.path(old)) as im:
                im.load()
            dpi = dpi_of(im)
            im = balance(im, warmth, tint)
            if rotate % 360:
                im = rotate_image(im, rotate, dpi)
            changes = {k: v for k, v in fields.items() if k in EDITABLE and v is not None}
            if "tags" in changes:
                changes["tags"] = clean_tags(changes["tags"])
            new = dataclasses.replace(old, **changes, state=state or old.state)
            m = self._write(new, im, dpi)
            if new.state != old.state:
                self.path(old).unlink()
            return m

    def delete(self, id: str) -> None:
        with self.lock:
            m = self.items.pop(id)
            self.path(m).unlink(missing_ok=True)
            for f in (self.root / "cache").glob(f"{id}-*"):
                f.unlink(missing_ok=True)

    def list(self, state: str) -> list[dict]:
        with self.lock:
            ms = [dataclasses.asdict(m) for m in self.items.values() if m.state == state]
        return sorted(ms, key=lambda m: m["added"], reverse=True)

    def thumb(self, id: str, px: int) -> Path:
        """WebP no larger than the next size up from `px` (long edge), cached."""
        m = self.items[id]
        px = next((s for s in SIZES if s >= px), SIZES[-1])
        out = self.root / "cache" / f"{id}-{m.v}-{px}.webp"
        if not out.exists():
            # A unique temp name outside the "<id>-*" pattern: concurrent requests for the
            # same size, or a write purging the cache, must not trip over each other.
            tmp = out.with_name(f".{secrets.token_hex(4)}.tmp")
            with self.thumbing, Image.open(self.path(m)) as im:
                im.thumbnail((px, px), Image.LANCZOS)
                im.save(tmp, "WEBP", quality=88)
            tmp.replace(out)
        return out

    def similar(self, id: str) -> list[dict]:
        """Other stickers that may be this one scanned again, most likely first."""
        m, px = self.items[id], 512
        out = []
        for o in [o for o in self.items.values() if o.id != id and similar.same_size(m, o)]:
            r = similar.compare(str(self.thumb(id, px)), str(self.thumb(o.id, px)))
            if r:
                out.append({**dataclasses.asdict(o), **r})
        return sorted(out, key=lambda r: (r["kind"] != "duplicate", -r["inliers"]))
