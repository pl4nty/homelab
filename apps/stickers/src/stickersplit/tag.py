"""Orient and tag sticker crops with Claude.

For each sticker crop, one request sends:
  1. the sticker itself (for reading text and identifying it), and
  2. a 2x2 grid of the sticker at 0/90/180/270 degrees, labelled A-D,
and asks, via a JSON schema, which panel is upright plus a title, the
visible text, and free-form tags. Picking the upright panel out of four is
a comparison task, which is more reliable than asking for a rotation angle
from a single image.

The chosen rotation is applied to the PNG in place.
"""

from __future__ import annotations

import base64
import io
import json
import threading
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

DEFAULT_MODEL = "claude-sonnet-5-5"
DETAIL_PX = 1568  # long edge; at or below the standard-tier no-resize limit
PANEL_PX = 480  # each grid panel; grid is ~1000 px square
PANELS = {"A": 0, "B": 90, "C": 180, "D": 270}  # clockwise rotation shown in panel


class StickerInfo(BaseModel):
    upright_panel: Literal["A", "B", "C", "D"]
    orientation_confidence: Literal["high", "medium", "low"]
    title: str
    tags: list[str]


# Hand-written to stay inside the structured-output schema subset
# (additionalProperties false, string enums, no length constraints).
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["upright_panel", "orientation_confidence", "title", "tags"],
    "properties": {
        "upright_panel": {
            "type": "string",
            "enum": list(PANELS),
            "description": "Grid panel in which the sticker is the right way up.",
        },
        "orientation_confidence": {
            "type": "string",
            "enum": ["high", "medium", "low"],
            "description": "high if text or a clear subject fixes the orientation; "
            "low for abstract or symmetric designs.",
        },
        "title": {
            "type": "string",
            "description": "Short catalogue name, e.g. the event or brand plus year.",
        },
        "tags": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Usually empty or one or two lowercase tags; see the rules in the prompt.",
        },
    },
}

PROMPT = """\
These are scans of one physical sticker from a personal collection.

Image 1 is the sticker as scanned. Image 2 shows the same sticker four times, \
rotated, in panels labelled A, B, C and D.

1. Choose the panel in which the sticker is the right way up: text reads normally \
left-to-right, people and animals stand upright. If the design has no clear up \
direction, choose A and set orientation_confidence to low.
2. Give a short catalogue title: the organisation, event or brand, plus what tells \
this sticker apart from others like it. Base it on what is printed or clearly shown; \
do not add guesses such as product generations, parodies or team names that the \
sticker does not state.
3. Give tags. Tags are only for filtering the collection by things the title does not \
say, so most stickers get none, one or two:
- the finish, when it is clearly visible: holo (any holographic or iridescent foil), \
glitter, clear;
- the event and year as a slug, when both are printed and not already the title, \
e.g. defcon-2025;
- a tag already used in the collection, when it clearly applies.
Never tag colours, shapes, objects, characters, the brand, words from the title, \
or anything you are guessing. For example, a holographic "Intel inside Core i7" laptop \
badge is titled "Intel Core i7" and tagged ["holo"].

Tags already used in the collection, most used first: {vocab}"""


def _b64_jpeg(im: Image.Image, quality: int = 90) -> str:
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=quality)
    return base64.standard_b64encode(buf.getvalue()).decode()


def _flatten(im: Image.Image, bg=(128, 128, 128)) -> Image.Image:
    """Composite RGBA onto mid-grey, so white and black stickers both stand out."""
    im = im.convert("RGBA")
    base = Image.new("RGBA", im.size, bg + (255,))
    base.alpha_composite(im)
    return base.convert("RGB")


def detail_image(im: Image.Image) -> Image.Image:
    im = _flatten(im)
    im.thumbnail((DETAIL_PX, DETAIL_PX), Image.LANCZOS)
    return im


def rotation_grid(im: Image.Image) -> Image.Image:
    """2x2 grid of the sticker rotated clockwise by PANELS[label], labels unrotated."""
    im = _flatten(im)
    im.thumbnail((PANEL_PX, PANEL_PX), Image.LANCZOS)
    label_h, gap = 44, 12
    cell = PANEL_PX + gap
    grid = Image.new("RGB", (2 * cell + gap, 2 * (cell + label_h) + gap), (255, 255, 255))
    d = ImageDraw.Draw(grid)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 34)
    except OSError:
        font = ImageFont.load_default()
    for i, (label, deg) in enumerate(PANELS.items()):
        x = gap + (i % 2) * cell
        y = gap + (i // 2) * (cell + label_h)
        d.text((x, y), label, fill=(200, 0, 0), font=font)
        r = im.rotate(-deg, expand=True)  # PIL rotates counter-clockwise
        grid.paste(r, (x + (PANEL_PX - r.width) // 2, y + label_h + (PANEL_PX - r.height) // 2))
    return grid


def build_request(im: Image.Image, model: str, effort: str | None, vocab: list[str] = ()) -> dict:
    output_config: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if effort:
        output_config["effort"] = effort
    img = lambda data: {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": data},
    }
    return {
        "model": model,
        "max_tokens": 4096,
        "output_config": output_config,
        "messages": [
            {
                "role": "user",
                "content": [
                    img(_b64_jpeg(detail_image(im))),
                    img(_b64_jpeg(rotation_grid(im))),
                    {"type": "text", "text": PROMPT.format(vocab=", ".join(vocab) or "none yet")},
                ],
            }
        ],
    }


def parse_response(resp) -> StickerInfo:
    if getattr(resp, "stop_reason", None) == "refusal":
        raise RuntimeError("model declined")
    text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), None)
    if text is None:
        raise RuntimeError(f"no text block (stop_reason={getattr(resp, 'stop_reason', None)})")
    return StickerInfo.model_validate_json(text)


# --- fine orientation -------------------------------------------------------
# Die-cut stickers are not deskewed by stickersplit (a min-area rectangle of a
# dog or a key has no meaningful angle), so they keep whatever angle they were
# laid at. The 90-degree grid can only get them to the nearest quarter turn.
# A second pass shows nine panels 10 degrees apart around that answer; if the
# pick lands on the edge of the range the grid is re-centred once.

FINE_STEPS = [-40, -30, -20, -10, 0, 10, 20, 30, 40]
FINE_LABELS = "ABCDEFGHI"
FINE_PX = 330
FINE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["panel"],
    "properties": {"panel": {"type": "string", "enum": list(FINE_LABELS)}},
}
FINE_PROMPT = """\
The same die-cut sticker is shown in nine panels, each rotated by a slightly \
different angle. Choose the panel where the sticker's design is most upright: a \
character's head directly above its body, an object standing as it would in the \
designer's artwork, text baselines horizontal unless the design deliberately sets \
text at an angle."""


def fine_grid(im: Image.Image, centre: float) -> Image.Image:
    im = _flatten(im)
    im.thumbnail((FINE_PX - 30, FINE_PX - 30), Image.LANCZOS)
    label_h = 36
    g = Image.new("RGB", (3 * FINE_PX, 3 * (FINE_PX + label_h)), (255, 255, 255))
    d = ImageDraw.Draw(g)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 30)
    except OSError:
        font = ImageFont.load_default()
    for k, step in enumerate(FINE_STEPS):
        x, y = (k % 3) * FINE_PX, (k // 3) * (FINE_PX + label_h)
        d.text((x + 6, y), FINE_LABELS[k], fill=(200, 0, 0), font=font)
        r = im.rotate(
            -(centre + step), expand=True, resample=Image.BICUBIC, fillcolor=(128, 128, 128)
        )
        r.thumbnail((FINE_PX - 10, FINE_PX - 10))
        g.paste(r, (x + (FINE_PX - r.width) // 2, y + label_h + (FINE_PX - r.height) // 2))
    return g


def fine_request(im: Image.Image, centre: float, model: str, effort: str | None) -> dict:
    oc: dict = {"format": {"type": "json_schema", "schema": FINE_SCHEMA}}
    if effort:
        oc["effort"] = effort
    return {
        "model": model,
        "max_tokens": 4096,
        "output_config": oc,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": _b64_jpeg(fine_grid(im, centre)),
                        },
                    },
                    {"type": "text", "text": FINE_PROMPT},
                ],
            }
        ],
    }


def fine_angle(call, im: Image.Image, model: str, effort: str | None, rounds: int = 2) -> float:
    """Extra clockwise degrees (multiple of 10, within +-80) to make `im` upright."""
    centre = 0.0
    for _ in range(rounds):
        resp = call(fine_request(im, centre, model, effort))
        text = next(b.text for b in resp.content if getattr(b, "type", None) == "text")
        step = FINE_STEPS[FINE_LABELS.index(json.loads(text)["panel"])]
        centre += step
        if abs(step) < FINE_STEPS[-1]:
            break
    return centre


# --- applying rotations -----------------------------------------------------


def rotate_image(im: Image.Image, deg: float, dpi: float = 600.0) -> Image.Image:
    """Rotate clockwise by `deg`. Quarter turns are lossless. Other angles
    resample and trim to the alpha outline, keeping the original transparent
    margin (capped at 3 mm)."""
    deg %= 360
    if deg in (0, 90, 180, 270):
        return (
            im
            if not deg
            else im.transpose(
                {
                    90: Image.Transpose.ROTATE_270,
                    180: Image.Transpose.ROTATE_180,
                    270: Image.Transpose.ROTATE_90,
                }[int(deg)]
            )
        )
    im = im.convert("RGBA")
    ob = _solid(im).getbbox()
    pad = min(ob[0], ob[1], im.width - ob[2], im.height - ob[3]) if ob else 0
    pad = min(pad, int(3 / 25.4 * dpi))
    rot = im.rotate(-deg, expand=True, resample=Image.BICUBIC)
    box = _solid(rot).getbbox()
    if not box:
        return rot
    x0, y0, x1, y1 = box
    return rot.crop(
        (max(0, x0 - pad), max(0, y0 - pad), min(rot.width, x1 + pad), min(rot.height, y1 + pad))
    )


def _solid(im: Image.Image) -> Image.Image:
    return im.getchannel("A").point(lambda v: 255 if v > 127 else 0)


def rotate_png(record: dict, png: Path, deg: float) -> dict:
    """Rotate the PNG clockwise by `deg` in place; return the updated record
    (quarter turns swap width/height, other angles re-measure the outline)."""
    deg = deg % 360
    r = dict(record)
    r["rotated_deg"] = round((record.get("rotated_deg", 0) + deg) % 360, 1)
    if deg == 0:
        return r
    with Image.open(png) as im:
        im.load()
    dpi = im.info.get("dpi")
    dpi_x = float(dpi[0]) if dpi else float(record.get("dpi") or 600)
    out = rotate_image(im, deg, dpi_x)
    if deg in (90, 270):
        r["width_mm"], r["height_mm"] = record["height_mm"], record["width_mm"]
        r["width_px"], r["height_px"] = record["height_px"], record["width_px"]
    elif deg != 180 and (box := _solid(out).getbbox()):
        x0, y0, x1, y1 = box
        r["width_px"], r["height_px"] = x1 - x0, y1 - y0
        r["width_mm"] = round((x1 - x0) / dpi_x * 25.4, 1)
        r["height_mm"] = round((y1 - y0) / dpi_x * 25.4, 1)
    out.save(png, **({"dpi": dpi} if dpi else {}))
    return r


def symmetry_angle(im: Image.Image, search: float = 20.0) -> tuple[float, float, float]:
    """Clockwise rotation within +-search that best mirrors the outline left-right.
    Returns (angle, IoU at angle, IoU at 0)."""
    im = im.convert("RGBA")
    im.thumbnail((400, 400))
    alpha = im.getchannel("A")

    def score(a: float) -> float:
        m = np.asarray(alpha.rotate(-a, expand=True, resample=Image.BILINEAR)) > 127
        if not m.any():
            return 0.0
        cx = np.nonzero(m)[1].mean()
        mir = np.roll(m[:, ::-1], round(2 * cx - (m.shape[1] - 1)), axis=1)
        return float((m & mir).sum() / max((m | mir).sum(), 1))

    best = max(np.arange(-search, search + 0.01, 1.0), key=score)
    best = max(np.arange(best - 1, best + 1.01, 0.25), key=score)
    return round(float(best), 2), round(score(best), 4), round(score(0.0), 4)


def apply(record: dict, info: StickerInfo, png: Path, fine: float = 0.0) -> dict:
    """Rotate the PNG upright in place and merge tags into the manifest record."""
    r = rotate_png(record, png, PANELS[info.upright_panel] + fine)
    r["fine_deg"] = fine
    r["orientation_confidence"] = info.orientation_confidence
    r["title"] = info.title
    tags: list[str] = []
    for t in (x.strip().lower() for x in info.tags):
        if t and t not in tags:
            tags.append(t)
    r["tags"] = tags
    r.pop("tag_error", None)
    return r


def call_claude(client, req: dict, usage: dict | None = None, lock=None):
    """messages.create with refusal retry (a refusal on a harmless sticker was
    seen once on a real run and cleared on retry); accumulates token usage."""
    for _ in range(3):
        resp = client.messages.create(**req)
        u = getattr(resp, "usage", None)
        if usage is not None and u is not None:
            with lock or threading.Lock():
                usage["input_tokens"] = usage.get("input_tokens", 0) + (
                    getattr(u, "input_tokens", 0) or 0
                )
                usage["output_tokens"] = usage.get("output_tokens", 0) + (
                    getattr(u, "output_tokens", 0) or 0
                )
        if getattr(resp, "stop_reason", None) != "refusal":
            return resp
    raise RuntimeError("model declined")


def tag_one(
    client,
    folder: Path,
    rec: dict,
    model: str = DEFAULT_MODEL,
    effort: str | None = "low",
    fine_pass: bool = True,
    usage: dict | None = None,
    lock=None,
    vocab: list[str] = (),
) -> dict:
    """Orient and tag one sticker: rotates its PNG in place, returns the new record."""
    with Image.open(folder / rec["file"]) as im:
        im.load()
    call = lambda req: call_claude(client, req, usage, lock)
    info = parse_response(call(build_request(im, model, effort, vocab)))
    fine = 0.0
    # Fine-tune only die-cuts with a real up direction: on a live run the
    # fine pass rotated a round, low-confidence logo 50 deg away from correct.
    if fine_pass and not rec.get("deskewed", True) and info.orientation_confidence != "low":
        coarse = im.rotate(-PANELS[info.upright_panel], expand=True)
        fine = fine_angle(call, coarse, model, effort)
    return apply(rec, info, folder / rec["file"], fine)
