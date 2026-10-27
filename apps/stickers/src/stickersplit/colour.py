"""White balance for holographic foil, which scans blue: the scanner lights it from one
fixed angle, so the foil reflects one band of colour instead of a rainbow.

The correction is a warmth (blue <-> amber) and tint (green <-> magenta) gain that is
faded in by brightness: dark ink keeps its colour and the bright foil is corrected.
On the first 17 holo stickers, balancing the whole sticker to grey turned printed
colours (green Patchstack, yellow Emu Exploit) grey, and an unweighted gain turned
navy ink brown; this does neither.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])


def gains(warmth: float, tint: float) -> np.ndarray:
    g = np.exp([0.5 * warmth, -0.5 * tint, -0.5 * warmth])
    return g / (g @ LUMA)                    # keep brightness


def balance(im: Image.Image, warmth: float, tint: float) -> Image.Image:
    if not (warmth or tint):
        return im
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    k = np.clip((a[..., :3] @ LUMA - 60) / 120, 0, 1)[..., None]
    a[..., :3] *= 1 + k * (gains(warmth, tint) - 1)
    out = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGBA")
    out.info = dict(im.info)                 # keep the DPI
    return out


def auto(im: Image.Image, strength: float = 1.0) -> tuple[float, float]:
    """(warmth, tint) that make the bright, non-white parts neutral on average; (0, 0) if
    they aren't blue. Iterates, because the brightness fade and clipped channels mean one
    step under-corrects: on PentesterLab's holo, one step moved the foil from b* -50 only
    to -23, while the plain version's white paper is b* -3."""
    small = im.convert("RGBA")
    small.thumbnail((512, 512))
    a = np.asarray(small).reshape(-1, 4).astype(float)
    sel = (a[:, 3] > 200) & (a[:, :3] @ LUMA > 140) & (a[:, :3].min(1) < 250)   # cyan foil clips blue: keep it
    if sel.sum() < 100:
        return 0.0, 0.0

    def cast(px):
        r, g, b = np.log(np.maximum(px[sel, :3].mean(0), 1))
        return b - r, 2 * (g - (r + b) / 2)

    w, t = cast(a)
    if w < 0.15:                             # not blue: a warm or green design is left alone
        return 0.0, 0.0
    for _ in range(6):
        dw, dt = cast(np.asarray(balance(small, w, t)).reshape(-1, 4).astype(float))
        w, t = w + dw, t + dt
    return round(float(np.clip(strength * w, -2, 2)), 2), round(float(np.clip(strength * t, -1, 1)), 2)
