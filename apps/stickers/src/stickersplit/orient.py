"""Find which way up a sticker goes by reading its text.

RapidOCR (PP-OCR on ONNX Runtime) finds the text lines once. Each line is cut out and read at
each quarter turn under which it lies flat (wider than tall): the right way up it reads with
high confidence, upside down or sideways it reads as low-confidence noise. The turn with the
most confidently read characters wins.

Without PP-OCR's own direction classifier, which would flip upside-down lines before reading
them and so make every turn read alike.

Measured on the 128 published stickers, each turned all four ways (512 cases): 239 turned
upright, none turned wrong, 273 left as scanned. Those are stickers without text (45 of the
128 never decide), or with too little text or text on a curve, such as a ring of words around
a round sticker, which reads well both ways up. Lines tilted more than MAX_TILT are ignored
for that reason. A sticker the reader can't decide is left as it was scanned.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image

WORK_PX = 1024  # long edge read; small print on a 60 mm sticker is still ~10 px high
MIN_CONF = 0.9  # a line counts only when read at least this confidently
MIN_SCORE = 4.0  # confidently read characters needed at the best turn
MIN_RATIO = 1.6  # and this many times more than at the runner-up
MAX_TILT = 10.0  # degrees from level or upright; text on a curve is ambiguous
TURNS = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

_engine = None
_lock = threading.Lock()  # one ONNX session, which already uses every core


@dataclass
class Orientation:
    turn: int  # clockwise turn that makes the sticker upright: 0, 90, 180 or 270
    confident: bool  # False: no clear text, so turn is 0
    scores: dict[int, float] = field(default_factory=dict)  # confident characters per turn
    text: str = ""  # what was read at the chosen turn


def _ocr():
    global _engine
    if _engine is None:
        from rapidocr import RapidOCR

        _engine = RapidOCR(params={"Global.log_level": "error", "Global.use_cls": False})
    return _engine


def flatten(im: Image.Image, bg=(128, 128, 128)) -> Image.Image:
    """Composite RGBA onto mid-grey, so white and black stickers both stand out."""
    im = im.convert("RGBA")
    base = Image.new("RGBA", im.size, bg + (255,))
    base.alpha_composite(im)
    return base.convert("RGB")


def _cut(img: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """The quadrilateral `pts` (clockwise from its first corner) warped to a rectangle."""
    w = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3])))
    h = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    M = cv2.getPerspectiveTransform(pts.astype(np.float32), dst)
    return cv2.warpPerspective(
        img, M, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC
    )


def _tilt(pts: np.ndarray) -> float:
    dx, dy = pts[1] - pts[0]
    a = float(np.degrees(np.arctan2(dy, dx))) % 90
    return min(a, 90 - a)


def detect(im: Image.Image) -> Orientation:
    work = flatten(im)
    work.thumbnail((WORK_PX, WORK_PX), Image.LANCZOS)
    img = np.asarray(work)
    scores = {t: 0.0 for t in (0, 90, 180, 270)}
    texts: dict[int, list[str]] = {t: [] for t in scores}
    with _lock:
        ocr = _ocr()
        boxes = ocr(img, use_det=True, use_cls=False, use_rec=False).boxes
        for pts in boxes if boxes is not None else ():
            pts = np.asarray(pts, np.float32)
            if _tilt(pts) > MAX_TILT:
                continue
            line = _cut(img, pts)
            if min(line.shape[:2]) < 6:
                continue
            for t in scores:
                turned = cv2.rotate(line, TURNS[t]) if t else line
                if turned.shape[1] < turned.shape[0]:
                    continue
                r = ocr(turned, use_det=False, use_cls=False, use_rec=True)
                txt, conf = (r.txts[0], float(r.scores[0])) if r.txts else ("", 0.0)
                n = len(re.sub(r"\W", "", txt))
                if conf >= MIN_CONF and n:
                    scores[t] += conf * n
                    texts[t].append(txt)
    best, second = sorted(scores, key=scores.get, reverse=True)[:2]
    ok = scores[best] >= MIN_SCORE and scores[best] >= MIN_RATIO * scores[second]
    turn = best if ok else 0
    return Orientation(
        turn, ok, {t: round(s, 1) for t, s in scores.items()}, " ".join(texts[turn])[:200]
    )
