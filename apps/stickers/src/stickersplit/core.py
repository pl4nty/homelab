"""Split a flatbed scan of many stickers into individual, deskewed crops.

Pipeline:
  1. Estimate background colour from the image border (or take it as input).
  2. Foreground mask = perceptual (Lab) distance from background, Otsu threshold.
  3. Morphological clean-up scaled to physical size (DPI-aware).
  4. External contours -> one region per sticker (holes filled automatically).
  5. minAreaRect per region -> rotate so the rect is axis-aligned (|angle| <= 45).
     Round / irregular die-cuts have no meaningful rect orientation, so they are
     only deskewed when the shape fills its min-area rect well (fill ratio).
  6. Crop with padding, attach alpha from the mask, record size in mm.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

MM_PER_INCH = 25.4

# Scanner glow: next to a bright sticker the black mat reads 13-18 Lab units
# from its own colour across a ~3 mm gap (measured on a real scan; open mat
# far from stickers gives ~15 with the noise-based estimate). A lower floor
# bridges neighbouring stickers. Dark stickers below this are caught by the
# edge-outline mask instead.
MIN_COLOUR_THRESHOLD = 25.0


@dataclass
class Options:
    dpi: float | None = None  # override; else read from file, else 600
    bg_color: tuple[int, int, int] | None = None  # RGB; None = estimate from border
    threshold: float | None = None  # Lab distance; None = from background noise
    work_dpi: float | None = 300.0  # segmentation resolution; None = full res
    edges: bool = True  # also fill closed edge outlines (black-on-black)
    min_size_mm: float = 8.0  # discard regions smaller than this (shorter side)
    pad_mm: float = 1.0  # padding around each crop
    deskew_min_fill: float = 0.85  # area / minAreaRect area needed to rotate
    keep_edge: bool = False  # keep regions touching the image border
    alpha: bool = True  # write RGBA with transparent background


@dataclass
class Sticker:
    index: int
    file: str
    source: str
    center_px: tuple[float, float]
    angle_deg: float  # rotation applied (0 if not deskewed)
    deskewed: bool
    fill_ratio: float  # contour area / min-area-rect area
    width_px: int
    height_px: int
    width_mm: float
    height_mm: float
    dpi: float
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def load_image(path: Path) -> tuple[np.ndarray, float | None]:
    """Load as BGR uint8, honouring EXIF orientation. Returns (image, dpi or None)."""
    # A4 at 1200 dpi is ~140 MP and A3 ~280 MP, above Pillow's default
    # decompression-bomb cap (~179 MP). Inputs are the user's own scans.
    old_cap = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            dpi = im.info.get("dpi")
            rgb = np.asarray(im.convert("RGB"))
    finally:
        Image.MAX_IMAGE_PIXELS = old_cap
    file_dpi = float(dpi[0]) if dpi and dpi[0] and dpi[0] > 1 else None
    if file_dpi is not None:
        # PNG stores pixels/metre, so 300 dpi round-trips as 299.9994.
        file_dpi = round(file_dpi, 1)
    # 72 dpi is almost always a "no real DPI" default from phones/editors.
    if file_dpi is not None and abs(file_dpi - 72) < 0.5:
        file_dpi = None
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), file_dpi


def _border(a: np.ndarray, frac: float = 0.02) -> np.ndarray:
    """Pixels in a thin strip around the image edge, flattened (keeps channels)."""
    h, w = a.shape[:2]
    b = max(2, int(min(h, w) * frac))
    tail = a.shape[2:]
    return np.concatenate(
        [
            a[:b].reshape(-1, *tail),
            a[-b:].reshape(-1, *tail),
            a[:, :b].reshape(-1, *tail),
            a[:, -b:].reshape(-1, *tail),
        ]
    )


def _clipped_stats(v: np.ndarray, k: float = 3.0, iters: int = 5) -> tuple[float, float]:
    """Median and robust SD of the low (background) mode of `v`.

    Iteratively discards values above median + k*SD, so stickers that touch the
    scan edge (often a large share of the border strip) don't inflate the
    background noise estimate.
    """
    v = v.astype(np.float64).ravel()
    med = sd = 0.0
    for _ in range(iters):
        med = float(np.median(v))
        sd = 1.4826 * float(np.median(np.abs(v - med))) + 1e-6
        nv = v[v < med + k * sd]
        if nv.size == v.size or nv.size < 100:
            break
        v = nv
    return med, sd


def estimate_background(img: np.ndarray) -> np.ndarray:
    """Background colour (BGR): mean of the border pixels nearest the border median.

    Taking the closest half rejects stickers that touch the scan edge.
    """
    strip = _border(img).astype(np.float32)
    d = np.linalg.norm(strip - np.median(strip, axis=0), axis=1)
    return strip[d <= np.median(d)].mean(axis=0).round().astype(np.uint8)


def _outline_mask(img: np.ndarray, dpi: float, edge_boxes: list | None = None) -> np.ndarray:
    """Filled closed outlines from edge detection.

    Catches stickers the same colour as the mat (black on black): their cut edge
    still shows as a continuous thin line. Canny thresholds come from the
    gradient noise of the background; closed outer contours are filled, open
    ones (stickers cut off by the scan edge, stray fibres) stay thin and are
    removed later by OPEN and the size filter.
    """
    L = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)[..., 0]
    L = cv2.GaussianBlur(L, (0, 0), sigmaX=max(0.7, 0.08 / MM_PER_INCH * dpi))
    g = np.abs(cv2.Sobel(L, cv2.CV_32F, 1, 0)) + np.abs(cv2.Sobel(L, cv2.CV_32F, 0, 1))
    med, sd = _clipped_stats(_border(g))
    del g
    edges = cv2.Canny(L, med + 4 * sd, med + 8 * sd)
    k = max(3, round(0.4 / MM_PER_INCH * dpi) | 1)
    edges = cv2.morphologyEx(
        edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    )
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(edges)
    cv2.drawContours(filled, cnts, -1, 255, thickness=cv2.FILLED)
    if edge_boxes is not None:
        # Outlines cut by the scan edge can't close, so a dark cut-off sticker
        # leaves no filled region, only this open line. Report its bbox so the
        # caller can reject print fragments inside it. Skip very large boxes:
        # lid shadow running along two bed edges would otherwise span the page.
        h, w = edges.shape
        for c in cnts:
            x, y, bw, bh = cv2.boundingRect(c)
            if (x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1) and bw * bh <= 0.25 * w * h:
                edge_boxes.append((x, y, bw, bh))
    return filled


def foreground_mask(
    img: np.ndarray,
    bg_bgr: np.ndarray,
    dpi: float,
    threshold: float | None,
    edges: bool = True,
    edge_boxes: list | None = None,
) -> tuple[np.ndarray, float]:
    """Binary mask of sticker pixels: colour mask OR filled edge outlines.

    The colour threshold defaults to the background's own noise level
    (median + 6 robust SDs of the Lab distance in the border strip, floor
    MIN_COLOUR_THRESHOLD),
    not Otsu: with many dark stickers on a dark mat the distribution is not
    bimodal, and Otsu splits bright stickers from dark ones instead of
    stickers from mat.
    """
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    bg_lab = cv2.cvtColor(bg_bgr.reshape(1, 1, 3), cv2.COLOR_BGR2LAB).astype(np.float32)[0, 0]
    dist = np.linalg.norm(lab - bg_lab, axis=2)
    del lab
    # Blur ~0.15 mm: merges halftone dots so printed areas read as solid.
    dist = cv2.GaussianBlur(dist, (0, 0), sigmaX=max(0.7, 0.15 / MM_PER_INCH * dpi))
    if threshold is None:
        med, sd = _clipped_stats(_border(dist))
        threshold = max(MIN_COLOUR_THRESHOLD, med + 6 * sd)
    mask = (dist > threshold).astype(np.uint8) * 255
    del dist
    outline = _outline_mask(img, dpi, edge_boxes) if edges else None
    if outline is not None:
        mask |= outline
    # Clean-up kernels sized in mm so behaviour is DPI-independent.
    # CLOSE before OPEN: fill speckle holes inside stickers first, otherwise
    # OPEN (erosion) deletes any region whose interior is speckled.
    k = max(3, round(0.5 / MM_PER_INCH * dpi) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    # One iteration bridges gaps up to ~0.5 mm. More merges stickers placed
    # 1-2 mm apart (seen on a real scan); halftone is already handled by the blur.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    if outline is not None:
        mask = _split_by_outlines(mask, outline, min_px=8.0 / MM_PER_INCH * dpi)
    return mask, float(threshold)


def _split_by_outlines(
    mask: np.ndarray, outline: np.ndarray, min_px: float, min_cover: float = 0.8
) -> np.ndarray:
    """Separate stickers that the colour mask joined but edges keep apart.

    Glow between two bright stickers ~1.3 mm apart lifts the gap above the
    colour threshold (seen on a real scan), while each sticker still has its
    own closed outline. A mask region is split when it holds >= 2 outline
    components (each >= min_px on a side) that together cover >= min_cover of
    the region: then the extra colour-only pixels are just the gap. Separate
    print elements inside one sticker cover far less, so are left alone.
    Pixels go to their nearest outline component; a seam is cut between them.
    """
    n_u, ulbl, ust, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    n_o, olbl, ost, _ = cv2.connectedComponentsWithStats(outline & mask, connectivity=8)
    keep = np.zeros(n_o, bool)
    keep[1:] = np.minimum(ost[1:, 2], ost[1:, 3]) >= min_px
    if keep.sum() < 2:
        return mask
    # Union region of each kept outline component (sample its top-left pixel run).
    o_u = np.zeros(n_o, np.int64)
    ys, xs = np.nonzero(olbl)
    o_u[olbl[ys, xs]] = ulbl[ys, xs]
    count = np.bincount(o_u[keep], minlength=n_u)
    cover = np.bincount(o_u[keep], weights=ost[keep, 4], minlength=n_u)
    split_u = np.nonzero((count >= 2) & (cover >= min_cover * ust[:, 4]))[0]
    split_u = split_u[split_u > 0]
    if split_u.size == 0:
        return mask
    marker = np.where(keep[olbl], olbl, 0)
    src = np.where(marker > 0, 0, 255).astype(np.uint8)
    _, near_pix = cv2.distanceTransformWithLabels(
        src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL
    )
    pix_to_o = np.zeros(int(near_pix.max()) + 1, np.int32)
    pix_to_o[near_pix[marker > 0]] = marker[marker > 0]
    owner = pix_to_o[near_pix]
    region = np.isin(ulbl, split_u)
    owner[~region] = 0
    seam = np.zeros(mask.shape, bool)
    seam[:, 1:] |= (owner[:, 1:] != owner[:, :-1]) & region[:, 1:] & region[:, :-1]
    seam[1:, :] |= (owner[1:, :] != owner[:-1, :]) & region[1:, :] & region[:-1, :]
    # 3 px wide so 8-connected contour tracing can't leak diagonally across it.
    seam = cv2.dilate(seam.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    out = mask.copy()
    out[seam & region] = 0
    return out


def _normalise_rect(rect):
    """Return (center, (w, h), angle) with angle in [-45, 45)."""
    (cx, cy), (w, h), a = rect
    while a >= 45:
        a -= 90
        w, h = h, w
    while a < -45:
        a += 90
        w, h = h, w
    return (cx, cy), (w, h), a


def _row_sort_key(c_center, band_px):
    cx, cy = c_center
    return (int(cy // band_px), cx)


def _inside(inner, outer, frac=0.8) -> bool:
    """True if >= frac of bbox `inner` (x, y, w, h) lies within bbox `outer`."""
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    w = max(0, min(ix + iw, ox + ow) - max(ix, ox))
    h = max(0, min(iy + ih, oy + oh) - max(iy, oy))
    return w * h >= frac * iw * ih


def split_scan(
    path: Path, out_dir: Path, opts: Options, report: dict | None = None
) -> tuple[list[Sticker], np.ndarray]:
    """Process one scan. Returns sticker records and a debug overlay (BGR).

    If `report` is given it is filled with counts of skipped regions.
    """
    img, file_dpi = load_image(path)
    dpi = opts.dpi or file_dpi or 600.0
    px_per_mm = dpi / MM_PER_INCH
    h_img, w_img = img.shape[:2]

    # Segment on a downscaled copy: outlines don't need full resolution, and
    # the float Lab pipeline costs ~12 bytes/pixel (a 1200 dpi A3 scan would
    # need >10 GB). Crops are still cut from the full-resolution image.
    scale = min(1.0, opts.work_dpi / dpi) if opts.work_dpi else 1.0
    small = (
        img
        if scale == 1.0
        else cv2.resize(
            img, (round(w_img * scale), round(h_img * scale)), interpolation=cv2.INTER_AREA
        )
    )
    work_px_mm = px_per_mm * scale
    hs, ws = small.shape[:2]

    bg = (
        np.array(opts.bg_color[::-1], dtype=np.uint8)
        if opts.bg_color
        else estimate_background(small)
    )
    open_outlines: list = []  # open edge contours cut by the scan edge
    mask, _ = foreground_mask(small, bg, dpi * scale, opts.threshold, opts.edges, open_outlines)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    del mask
    min_side_px = opts.min_size_mm * px_per_mm
    pad = round(opts.pad_mm * px_per_mm)

    regions = []
    edge_boxes = []  # bboxes (working coords) of skipped edge-touching stickers
    for cs in contours:
        x, y, bw, bh = cv2.boundingRect(cs)
        touches = x <= 1 or y <= 1 or x + bw >= ws - 1 or y + bh >= hs - 1
        if touches and not opts.keep_edge and min(bw, bh) >= opts.min_size_mm * work_px_mm:
            edge_boxes.append((x, y, bw, bh))
        if scale < 1.0:
            # Smooth the pixel staircase before upscaling, then map pixel
            # centres from working to full-resolution coordinates.
            cs = cv2.approxPolyDP(cs, 0.75, True)
            c = np.round((cs.astype(np.float64) + 0.5) / scale - 0.5).astype(np.int32)
        else:
            c = cs
        rect = cv2.minAreaRect(c)
        (_, (rw, rh), _) = rect
        if min(rw, rh) < min_side_px:
            continue
        if touches and not opts.keep_edge:
            continue
        regions.append((c, rect, touches, (x, y, bw, bh)))

    # A sticker cut off by the edge with dark (background-coloured) artwork
    # splits into several regions; only the one touching the edge is skipped
    # above. Drop the leftovers that sit inside its bounding box.
    # Also reject inside open outlines of cut-off stickers too dark to show in
    # the mask at all.
    min_work = opts.min_size_mm * work_px_mm
    reject = edge_boxes + (
        [] if opts.keep_edge else [b for b in open_outlines if min(b[2], b[3]) >= min_work]
    )
    n_before = len(regions)
    regions = [r for r in regions if not any(_inside(r[3], eb) for eb in reject)]
    if report is not None:
        report["edge_skipped"] = len(edge_boxes)
        report["fragments_skipped"] = n_before - len(regions)
    regions = [r[:3] for r in regions]

    band = 20 * px_per_mm  # stickers within 20 mm vertically count as one row
    regions.sort(key=lambda r: _row_sort_key(r[1][0], band))

    out_dir.mkdir(parents=True, exist_ok=True)
    overlay = small.copy()
    stickers: list[Sticker] = []
    bg_fill = tuple(int(v) for v in bg)

    for i, (c, rect, touches) in enumerate(regions, start=1):
        (cx, cy), (rw, rh), a = _normalise_rect(rect)
        area = cv2.contourArea(c)
        fill = float(area / max(rw * rh, 1.0))
        deskew = fill >= opts.deskew_min_fill
        hull = cv2.convexHull(c)
        solidity = float(area / max(cv2.contourArea(hull), 1.0))
        warnings: list[str] = []
        if touches:
            warnings.append("touches image edge; may be cut off")
        if solidity < 0.75:
            warnings.append("non-convex outline; check it is one sticker, not a merged pair")
        # For rect-like stickers, use the convex hull as the outline. This repairs
        # notches where dark print at the sticker edge matched a dark background,
        # while keeping rounded corners (unlike filling the whole min-area rect).
        outline = hull if deskew else c

        if deskew:
            angle = a
            out_w, out_h = rw, rh
        else:
            angle = 0.0
            _, _, bw, bh = cv2.boundingRect(c)
            out_w, out_h = float(bw), float(bh)
            x, y, _, _ = cv2.boundingRect(c)
            cx, cy = x + bw / 2, y + bh / 2

        # Work on a local window to avoid warping the whole scan per sticker.
        half = int(np.ceil(np.hypot(out_w, out_h) / 2)) + pad + 2
        x0, y0 = max(0, int(cx) - half), max(0, int(cy) - half)
        x1, y1 = min(w_img, int(cx) + half), min(h_img, int(cy) + half)
        win = img[y0:y1, x0:x1]
        region_mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.drawContours(region_mask, [outline - [x0, y0]], -1, 255, thickness=cv2.FILLED)

        ow, oh = round(out_w) + 2 * pad, round(out_h) + 2 * pad
        M = cv2.getRotationMatrix2D((cx - x0, cy - y0), angle, 1.0)
        M[0, 2] += ow / 2 - (cx - x0)
        M[1, 2] += oh / 2 - (cy - y0)
        crop = cv2.warpAffine(
            win,
            M,
            (ow, oh),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=bg_fill,
        )
        alpha = cv2.warpAffine(
            region_mask,
            M,
            (ow, oh),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )

        name = f"{path.stem}_{i:03d}.png"
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        if opts.alpha:
            pil = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
        else:
            pil = Image.fromarray(rgb, "RGB")
        pil.save(out_dir / name, dpi=(dpi, dpi))

        stickers.append(
            Sticker(
                index=i,
                file=name,
                source=path.name,
                center_px=(round(float(cx), 1), round(float(cy), 1)),
                angle_deg=round(float(angle), 2),
                deskewed=deskew,
                fill_ratio=round(fill, 3),
                width_px=round(out_w),
                height_px=round(out_h),
                width_mm=round(out_w / px_per_mm, 1),
                height_mm=round(out_h / px_per_mm, 1),
                dpi=dpi,
                warnings=warnings,
            )
        )

        box = (cv2.boxPoints(rect) * scale).astype(np.int32)
        colour = (0, 200, 0) if deskew else (0, 160, 255)
        lw = max(2, int(work_px_mm / 3))
        cv2.drawContours(overlay, [box], -1, colour, lw)
        cv2.putText(
            overlay,
            str(i),
            (int(cx * scale), int(cy * scale)),
            cv2.FONT_HERSHEY_SIMPLEX,
            work_px_mm * 0.3,
            (0, 0, 255),
            lw * 2,
            cv2.LINE_AA,
        )

    return stickers, overlay
