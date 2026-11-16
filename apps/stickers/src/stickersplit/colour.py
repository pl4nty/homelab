"""Recolouring for holographic foil, which scans blue: the scanner lights it from one fixed
angle, so the foil reflects one band of colour instead of a rainbow.

The editor shifts the hue, saturation and brightness of one colour (the sticker's main
colour, or a picked one), faded out over hues 30-60 degrees away, lightness 25-50 L* away,
and greys. A whole-sticker warmth/tint gain, faded in by brightness, was used before: the
gain that greyed the CTF cat's cyan foil turned its neutral silver edge salmon and its red
ink magenta. This greys the foil and leaves the edge, the white and the other inks alone.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image


def lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.ascontiguousarray(rgb, np.float32) / 255, cv2.COLOR_RGB2Lab)


def lab_of(hex: str) -> np.ndarray:
    return lab(np.array([[[int(hex[k : k + 2], 16) for k in (1, 3, 5)]]]))[0, 0]


def dominant(im: Image.Image, foil: bool = False) -> str | None:
    """The most common strong colour, as #rrggbb, or None for a grey sticker. With `foil`, only
    light cyans and blues count, and must cover a tenth of the sticker: printed blue ink
    (Intel's, L* 45) is darker than foil (L* 55-93)."""
    small = im.convert("RGBA")
    small.thumbnail((512, 512))
    a = np.asarray(small)
    px = a[a[..., 3] > 200][:, :3]
    L, A, B = lab(px[None])[0].T
    c, h = np.hypot(A, B), np.degrees(np.arctan2(B, A))
    weight = np.clip(c - 10, 0, None)
    if foil:
        weight *= (L > 52) & (np.abs(h + 125) < 55)  # cyan to blue
        if (weight > 0).mean() < 0.1:
            return None
    hist, _ = np.histogram(h, 72, (-180, 180), weights=weight)
    if not hist.any():
        return None
    peak = np.convolve(np.r_[hist[-1], hist, hist[0]], [1, 1, 1], "valid").argmax() * 5 - 177.5
    sel = (c > 10) & (np.abs((h - peak + 180) % 360 - 180) < 7.5)
    return "#" + "".join(f"{v:02x}" for v in px[sel].mean(0).round().astype(int))


def adjust(
    im: Image.Image, target: str | None, hue: float, saturation: float, brightness: float
) -> Image.Image:
    """Rotate the hue by `hue` degrees and scale the chroma by 1 + `saturation` of the colours
    near `target`, and move their lightness towards white (`brightness` > 0) or black."""
    if target is None or not (hue or saturation or brightness):
        return im
    t = lab_of(target)
    if np.hypot(t[1], t[2]) < 5:
        return im
    h0 = np.arctan2(t[2], t[1])
    a = np.array(im.convert("RGBA"))
    for y in range(0, a.shape[0], 512):  # strips, to bound memory on big stickers
        L, A, B = np.moveaxis(lab(a[y : y + 512, :, :3]), -1, 0)
        c, h = np.hypot(A, B), np.arctan2(B, A)
        d = np.degrees(np.abs((h - h0 + np.pi) % (2 * np.pi) - np.pi))
        w = (
            np.clip((60 - d) / 30, 0, 1)
            * np.clip((c - 5) / 10, 0, 1)
            * np.clip((50 - np.abs(L - t[0])) / 25, 0, 1)
        )
        h += w * np.radians(hue)
        c *= 1 + w * saturation
        L += w * brightness * (100 - L if brightness > 0 else L)
        rgb = cv2.cvtColor(np.stack([L, c * np.cos(h), c * np.sin(h)], -1), cv2.COLOR_Lab2RGB)
        a[y : y + 512, :, :3] = np.clip(rgb * 255 + 0.5, 0, 255)
    out = Image.fromarray(a, "RGBA")
    out.info = dict(im.info)  # keep the DPI
    return out


def auto(im: Image.Image) -> dict | None:
    """The adjustment that turns blue foil silver: chroma down to 3, lightness up to L* 78.
    None without light blue, so a warm or green design is left alone."""
    target = dominant(im, foil=True)
    if target is None:
        return None
    L, A, B = lab_of(target)
    return {
        "target": target,
        "hue": 0.0,
        "saturation": round(float(max(-1.0, 3 / np.hypot(A, B) - 1)), 2),
        "brightness": round(float(max(0.0, (78 - L) / (100 - L))), 2),
    }
