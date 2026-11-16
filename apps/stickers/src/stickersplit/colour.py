"""White balance for holographic foil, which scans blue: the scanner lights it from one
fixed angle, so the foil reflects one band of colour instead of a rainbow.

The correction is a warmth (blue <-> amber) and tint (green <-> magenta) gain that is
faded in by brightness: dark ink keeps its colour and the bright foil is corrected.
On the first 17 holo stickers, balancing the whole sticker to grey turned printed
colours (green Patchstack, yellow Emu Exploit) grey, and an unweighted gain turned
navy ink brown; this does neither.

That gain can't fix a sticker whose main colour scanned wrong while its silver edge and
white ink scanned right: the gain that greys a cyan foil turns the edge salmon. So the
editor can also shift the hue, saturation and brightness of one picked colour, faded out
over hues 30-60 degrees away and over greys, leaving every other colour as scanned.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])


def gains(warmth: float, tint: float) -> np.ndarray:
    g = np.exp([0.5 * warmth, -0.5 * tint, -0.5 * warmth])
    return g / (g @ LUMA)  # keep brightness


def balance(im: Image.Image, warmth: float, tint: float) -> Image.Image:
    if not (warmth or tint):
        return im
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    k = np.clip((a[..., :3] @ LUMA - 60) / 120, 0, 1)[..., None]
    a[..., :3] *= 1 + k * (gains(warmth, tint) - 1)
    out = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGBA")
    out.info = dict(im.info)  # keep the DPI
    return out


def lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.ascontiguousarray(rgb, np.float32) / 255, cv2.COLOR_RGB2Lab)


def dominant(im: Image.Image) -> str | None:
    """The most common strong colour, as #rrggbb, or None for a grey sticker."""
    small = im.convert("RGBA")
    small.thumbnail((512, 512))
    a = np.asarray(small)
    px = a[a[..., 3] > 200][:, :3]
    _, A, B = lab(px[None])[0].T
    c, h = np.hypot(A, B), np.degrees(np.arctan2(B, A))
    hist, _ = np.histogram(h, 72, (-180, 180), weights=np.clip(c - 10, 0, None))
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
    t = lab(np.array([[[int(target[k : k + 2], 16) for k in (1, 3, 5)]]]))[0, 0]
    if np.hypot(t[1], t[2]) < 5:
        return im
    h0 = np.arctan2(t[2], t[1])
    a = np.array(im.convert("RGBA"))
    for y in range(0, a.shape[0], 512):  # strips, to bound memory on big stickers
        L, A, B = np.moveaxis(lab(a[y : y + 512, :, :3]), -1, 0)
        c, h = np.hypot(A, B), np.arctan2(B, A)
        d = np.degrees(np.abs((h - h0 + np.pi) % (2 * np.pi) - np.pi))
        w = np.clip((60 - d) / 30, 0, 1) * np.clip((c - 5) / 10, 0, 1)
        h += w * np.radians(hue)
        c *= 1 + w * saturation
        L += w * brightness * (100 - L if brightness > 0 else L)
        rgb = cv2.cvtColor(np.stack([L, c * np.cos(h), c * np.sin(h)], -1), cv2.COLOR_Lab2RGB)
        a[y : y + 512, :, :3] = np.clip(rgb * 255 + 0.5, 0, 255)
    out = Image.fromarray(a, "RGBA")
    out.info = dict(im.info)
    return out


def auto(im: Image.Image, strength: float = 1.0) -> tuple[float, float]:
    """(warmth, tint) that make the bright, non-white parts neutral on average; (0, 0) if
    they aren't blue. Iterates, because the brightness fade and clipped channels mean one
    step under-corrects: on PentesterLab's holo, one step moved the foil from b* -50 only
    to -23, while the plain version's white paper is b* -3."""
    small = im.convert("RGBA")
    small.thumbnail((512, 512))
    a = np.asarray(small).reshape(-1, 4).astype(float)
    sel = (
        (a[:, 3] > 200) & (a[:, :3] @ LUMA > 140) & (a[:, :3].min(1) < 250)
    )  # cyan foil clips blue: keep it
    if sel.sum() < 100:
        return 0.0, 0.0

    def cast(px):
        r, g, b = np.log(np.maximum(px[sel, :3].mean(0), 1))
        return b - r, 2 * (g - (r + b) / 2)

    w, t = cast(a)
    if w < 0.15:  # not blue: a warm or green design is left alone
        return 0.0, 0.0
    for _ in range(6):
        dw, dt = cast(np.asarray(balance(small, w, t)).reshape(-1, 4).astype(float))
        w, t = w + dw, t + dt
    return round(float(np.clip(strength * w, -2, 2)), 2), round(
        float(np.clip(strength * t, -1, 1)), 2
    )
