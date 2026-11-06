"""Synthetic scans with known sizes and angles."""

import cv2
import numpy as np
import pytest
from PIL import Image
from stickersplit.core import Options, split_scan

DPI = 300
PX_MM = DPI / 25.4
BG = (40, 170, 60)  # BGR green mat

# (center mm, size mm (w, h), angle deg, kind)
SHAPES = [
    ((40, 40), (50, 30), 12, "rect"),
    ((120, 40), (30, 60), -27, "rect"),
    ((40, 130), (70, 40), 3, "rect"),
    ((130, 130), (40, 40), 0, "circle"),
]


def make_scan(path, shapes=SHAPES, size_mm=(180, 180), noise=True, dpi=DPI):
    px = dpi / 25.4
    h, w = int(size_mm[1] * px), int(size_mm[0] * px)
    img = np.full((h, w, 3), BG, np.uint8)
    for cmm, smm, ang, kind in shapes:
        c = (cmm[0] * px, cmm[1] * px)
        if kind == "rect":
            box = cv2.boxPoints((c, (smm[0] * px, smm[1] * px), ang)).astype(np.int32)
            cv2.fillPoly(img, [box], (245, 245, 245))
            # asymmetric dark mark in one corner so content is non-uniform
            cv2.circle(img, tuple(box[0] + (box[2] - box[0]) // 6), int(3 * px), (30, 30, 200), -1)
        else:
            cv2.circle(img, (int(c[0]), int(c[1])), int(smm[0] / 2 * px), (20, 200, 240), -1)
    if noise:
        rng = np.random.default_rng(0)
        img = np.clip(img.astype(np.int16) + rng.normal(0, 4, img.shape), 0, 255).astype(np.uint8)
    Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(path, dpi=(dpi, dpi))
    return path


def test_sizes_and_deskew(tmp_path):
    scan = make_scan(tmp_path / "scan.png")
    stickers, _ = split_scan(scan, tmp_path / "out", Options(pad_mm=0))
    assert len(stickers) == len(SHAPES)

    # Match each output to its synthetic shape by nearest centre.
    for cmm, smm, ang, kind in SHAPES:
        s = min(
            stickers,
            key=lambda s: np.hypot(
                s.center_px[0] / PX_MM - cmm[0], s.center_px[1] / PX_MM - cmm[1]
            ),
        )
        dims = sorted([s.width_mm, s.height_mm])
        assert dims == pytest.approx(sorted(smm), abs=1.0), (kind, s)
        if kind == "circle":
            assert not s.deskewed
            continue
        assert s.deskewed
        # Output orientation keeps the original w/h within the +-45 deg window.
        assert (s.width_mm, s.height_mm) == pytest.approx(smm, abs=1.0)

        # Re-measure the written crop: the sticker must now be axis-aligned.
        rgba = np.asarray(Image.open(tmp_path / "out" / s.file))
        assert rgba.shape[2] == 4
        cnts, _ = cv2.findContours(
            (rgba[..., 3] > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        (_, _, residual) = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
        residual = min(residual % 90, 90 - residual % 90)
        assert residual < 1.0, s


def test_reading_order_and_names(tmp_path):
    scan = make_scan(tmp_path / "sheet.png")
    stickers, _ = split_scan(scan, tmp_path / "out", Options())
    assert [s.file for s in stickers] == [f"sheet_{i:03d}.png" for i in range(1, 5)]
    # Top row before bottom row.
    assert stickers[0].center_px[1] < stickers[2].center_px[1]
    assert stickers[0].center_px[0] < stickers[1].center_px[0]


def test_edge_and_small_regions_dropped(tmp_path):
    shapes = SHAPES + [
        ((2, 90), (20, 20), 0, "rect"),  # clipped by left edge
        ((90, 90), (3, 3), 0, "rect"),
    ]  # dust-sized
    scan = make_scan(tmp_path / "s.png", shapes)
    stickers, _ = split_scan(scan, tmp_path / "out", Options())
    assert len(stickers) == len(SHAPES)
    kept, _ = split_scan(scan, tmp_path / "out2", Options(keep_edge=True))
    assert len(kept) == len(SHAPES) + 1
    assert any("edge" in w for s in kept for w in s.warnings)


def test_dark_edge_print_does_not_notch_outline(tmp_path):
    """Dark ink touching the sticker edge on a near-black mat must not cut the alpha."""
    px = DPI / 25.4
    img = np.full((int(100 * px), int(100 * px), 3), 20, np.uint8)
    box = cv2.boxPoints(((50 * px, 50 * px), (60 * px, 40 * px), 15)).astype(np.int32)
    cv2.fillPoly(img, [box], (60, 100, 200))
    # Dark blob centred on one edge of the sticker.
    edge_mid = ((box[0] + box[1]) / 2).astype(int)
    cv2.circle(img, tuple(int(v) for v in edge_mid), int(4 * px), (22, 22, 22), -1)
    path = tmp_path / "dark.png"
    Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(path, dpi=(DPI, DPI))
    (s,), _ = split_scan(path, tmp_path / "out", Options(pad_mm=0))
    assert s.deskewed
    alpha = np.asarray(Image.open(tmp_path / "out" / s.file))[..., 3]
    assert (alpha > 127).mean() > 0.97


def test_star_is_not_rotated_and_is_flagged(tmp_path):
    px = DPI / 25.4
    img = np.full((int(100 * px), int(100 * px), 3), BG, np.uint8)
    pts = [
        (
            50 * px + (30 if k % 2 == 0 else 12) * px * np.cos(k * np.pi / 5 + 0.3),
            50 * px + (30 if k % 2 == 0 else 12) * px * np.sin(k * np.pi / 5 + 0.3),
        )
        for k in range(10)
    ]
    cv2.fillPoly(img, [np.array(pts, np.int32)], (60, 200, 250))
    path = tmp_path / "star.png"
    Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(path, dpi=(DPI, DPI))
    (s,), _ = split_scan(path, tmp_path / "out", Options())
    assert not s.deskewed and s.angle_deg == 0
    assert any("non-convex" in w for w in s.warnings)


def _save(img, path, dpi=DPI):
    Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).save(path, dpi=(dpi, dpi))
    return path


def test_halftone_speckle_is_kept(tmp_path):
    """Regression (real scan): a halftone-printed red sticker on a black mat,
    next to a bright sticker, was erased by OPEN-before-CLOSE."""
    px = 600 / 25.4
    img = np.zeros((int(80 * px), int(140 * px), 3), np.uint8)
    # Bright white sticker: pushes an Otsu-style threshold high.
    cv2.rectangle(
        img, (int(85 * px), int(20 * px)), (int(125 * px), int(60 * px)), (250, 250, 250), -1
    )
    # Halftone red: ~100 lpi dot grid (6 px period at 600 dpi), 2 px black gaps.
    y0, y1, x0, x1 = int(20 * px), int(50 * px), int(20 * px), int(70 * px)
    red = np.zeros((y1 - y0, x1 - x0, 3), np.uint8)
    red[..., 2] = 200
    red[::6, :] = 0
    red[1::6, :] = 0
    red[:, ::6] = 0
    red[:, 1::6] = 0
    img[y0:y1, x0:x1] = red
    stickers, _ = split_scan(
        _save(img, tmp_path / "ht.png", 600), tmp_path / "out", Options(pad_mm=0)
    )
    assert len(stickers) == 2
    s = min(stickers, key=lambda s: s.center_px[0])
    assert sorted([s.width_mm, s.height_mm]) == pytest.approx([30, 50], abs=1.0)


def test_navy_on_black_is_found(tmp_path):
    """Regression (real scan): Otsu put the threshold at ~119 Lab units with
    bright stickers present, missing navy (~44 from black)."""
    px = DPI / 25.4
    img = np.zeros((int(120 * px), int(120 * px), 3), np.uint8)
    cv2.rectangle(
        img, (int(10 * px), int(10 * px)), (int(50 * px), int(50 * px)), (255, 255, 255), -1
    )
    cv2.rectangle(img, (int(70 * px), int(70 * px)), (int(110 * px), int(100 * px)), (65, 5, 0), -1)
    stickers, _ = split_scan(_save(img, tmp_path / "navy.png"), tmp_path / "out", Options())
    assert len(stickers) == 2


def test_close_neighbour_of_edge_sticker_survives(tmp_path):
    """Regression (real scan): a sticker 1.5 mm from an edge-touching sticker
    was bridged into it and skipped along with it."""
    px = 600 / 25.4
    img = np.zeros((int(80 * px), int(100 * px), 3), np.uint8)
    cv2.rectangle(
        img, (int(60 * px), int(20 * px)), (int(100 * px), int(60 * px)), (230, 230, 230), -1
    )
    cv2.rectangle(
        img, (int(33.5 * px), int(30 * px)), (int(58.5 * px), int(48 * px)), (200, 120, 30), -1
    )
    report = {}
    stickers, _ = split_scan(
        _save(img, tmp_path / "gap.png", 600), tmp_path / "out", Options(pad_mm=0), report
    )
    assert len(stickers) == 1 and report["edge_skipped"] == 1
    assert sorted([stickers[0].width_mm, stickers[0].height_mm]) == pytest.approx([18, 25], abs=1.0)


def test_fragments_of_edge_sticker_are_dropped(tmp_path):
    """A dark sticker cut off by the edge leaves bright print islands; skip them."""
    px = DPI / 25.4
    img = np.zeros((int(100 * px), int(100 * px), 3), np.uint8)
    cv2.rectangle(
        img, (int(10 * px), int(10 * px)), (int(40 * px), int(40 * px)), (255, 255, 255), -1
    )
    # Edge sticker: thin light border touching the right edge, dark interior,
    # plus a bright island of print inside it that is not connected to the border.
    # Right side at 120 mm: off-image, so the outline really is cut by the edge.
    cv2.rectangle(
        img,
        (int(55 * px), int(30 * px)),
        (int(120 * px), int(80 * px)),
        (200, 200, 200),
        int(1.5 * px),
    )
    cv2.rectangle(
        img, (int(65 * px), int(45 * px)), (int(85 * px), int(65 * px)), (0, 140, 255), -1
    )
    report = {}
    stickers, _ = split_scan(_save(img, tmp_path / "frag.png"), tmp_path / "out", Options(), report)
    assert len(stickers) == 1
    assert report == {"edge_skipped": 1, "fragments_skipped": 1}


def _black_on_black(tmp_path):
    """Real-scan conditions: mat L~17 (SD~7), black vinyl L~20, cut edge shows
    as a faint ~0.2 mm lighter rim. Colour alone cannot separate them."""
    px = 600 / 25.4
    rng = np.random.default_rng(3)
    img = np.full((int(80 * px), int(100 * px), 3), 20, np.uint8)
    box = cv2.boxPoints(((50 * px, 40 * px), (60 * px, 25 * px), 8)).astype(np.int32)
    cv2.fillPoly(img, [box], (24, 24, 24))
    cv2.polylines(img, [box], True, (60, 60, 60), max(1, int(0.2 * px)), cv2.LINE_AA)
    img = np.clip(img + rng.normal(0, 7, img.shape), 0, 255).astype(np.uint8)
    return _save(img, tmp_path / "bob.png", 600)


def test_black_on_black_needs_edges(tmp_path):
    scan = _black_on_black(tmp_path)
    without, _ = split_scan(scan, tmp_path / "a", Options(edges=False))
    assert len(without) == 0
    (s,), _ = split_scan(scan, tmp_path / "b", Options(pad_mm=0))
    assert s.deskewed and s.angle_deg == pytest.approx(8, abs=1.0)
    assert (s.width_mm, s.height_mm) == pytest.approx((60, 25), abs=1.0)


def test_glow_filled_gap_is_split_by_outlines(tmp_path):
    """Regression (real scan): two bright stickers 1.3 mm apart; scanner glow
    lifted the gap above the colour threshold, but each has a closed outline."""
    px = 600 / 25.4
    rng = np.random.default_rng(5)
    stick = np.zeros((int(80 * px), int(110 * px)), np.float32)
    stick[int(15 * px) : int(65 * px), int(10 * px) : int(50 * px)] = 220
    stick[int(15 * px) : int(65 * px), int(51.3 * px) : int(95 * px)] = 220
    # Matches the measured profile: sharp ~0.25 mm falloff plus a low plateau
    # across the gap (real gap read 19-44 raw Lab distance, 26 after blur).
    glow = (
        cv2.GaussianBlur(stick, (0, 0), 0.25 * px) * 0.25
        + cv2.GaussianBlur(stick, (0, 0), 1.5 * px) * 0.12
    )
    L = np.maximum(stick, 20 + glow)
    img = np.clip(np.repeat(L[..., None], 3, 2) + rng.normal(0, 5, L.shape + (3,)), 0, 255).astype(
        np.uint8
    )
    scan = _save(img, tmp_path / "glow.png", 600)
    merged, _ = split_scan(scan, tmp_path / "a", Options(edges=False))
    assert len(merged) == 1  # reproduces the colour-mask merge
    stickers, _ = split_scan(scan, tmp_path / "b", Options(pad_mm=0))
    assert len(stickers) == 2
    for s in stickers:
        assert s.height_mm == pytest.approx(50, abs=1.0)
        assert s.width_mm == pytest.approx(40 if s.center_px[0] < 50 * px else 43.7, abs=1.0)


def test_print_elements_inside_one_sticker_are_not_split(tmp_path):
    """A sticker whose soft outer edge gives no closed outline, with two crisp
    closed print elements inside, must stay whole (outlines cover < 80%)."""
    px = DPI / 25.4
    body = np.full((int(100 * px), int(120 * px)), 20, np.float32)
    body[int(20 * px) : int(80 * px), int(15 * px) : int(105 * px)] = 140
    body = cv2.GaussianBlur(body, (0, 0), 1.5 * px)  # soft edge: no Canny loop
    cv2.rectangle(body, (int(25 * px), int(35 * px)), (int(45 * px), int(65 * px)), 250, -1)
    cv2.rectangle(body, (int(75 * px), int(35 * px)), (int(95 * px), int(65 * px)), 250, -1)
    img = np.repeat(np.clip(body, 0, 255).astype(np.uint8)[..., None], 3, 2)
    stickers, _ = split_scan(_save(img, tmp_path / "print.png"), tmp_path / "out", Options())
    assert len(stickers) == 1
    assert stickers[0].width_mm > 85


def test_fragments_inside_dark_cut_off_sticker_are_dropped(tmp_path):
    """Regression (real scan): a dark navy sticker cut off by the edge is too
    dark for the colour mask and its outline can't close, so only its print
    islands showed up. Reject them via the open outline."""
    px = 600 / 25.4
    rng = np.random.default_rng(4)
    img = np.full((int(100 * px), int(100 * px), 3), 20, np.uint8)
    cv2.rectangle(
        img, (int(10 * px), int(10 * px)), (int(35 * px), int(35 * px)), (230, 230, 230), -1
    )
    cv2.rectangle(
        img, (int(55 * px), int(30 * px)), (int(130 * px), int(85 * px)), (30, 22, 22), -1
    )
    cv2.rectangle(
        img,
        (int(55 * px), int(30 * px)),
        (int(130 * px), int(85 * px)),
        (60, 60, 60),
        max(1, int(0.2 * px)),
        cv2.LINE_AA,
    )
    cv2.rectangle(
        img, (int(65 * px), int(45 * px)), (int(80 * px), int(60 * px)), (40, 120, 220), -1
    )
    img = np.clip(img + rng.normal(0, 6, img.shape), 0, 255).astype(np.uint8)
    report = {}
    stickers, _ = split_scan(
        _save(img, tmp_path / "dark.png", 600), tmp_path / "out", Options(), report
    )
    assert len(stickers) == 1, [(s.width_mm, s.height_mm) for s in stickers]
    assert report["fragments_skipped"] == 1


def test_downscaled_segmentation_matches_full_res(tmp_path):
    """At 600 dpi the outline is found at work_dpi=300; sizes must still be right."""
    scan = make_scan(tmp_path / "scan600.png", dpi=600)
    fast, _ = split_scan(scan, tmp_path / "a", Options(pad_mm=0))
    full, _ = split_scan(scan, tmp_path / "b", Options(pad_mm=0, work_dpi=None))
    assert len(fast) == len(full) == len(SHAPES)
    for f, g in zip(fast, full):
        assert f.width_mm == pytest.approx(g.width_mm, abs=0.5)
        assert f.height_mm == pytest.approx(g.height_mm, abs=0.5)
        assert f.angle_deg == pytest.approx(g.angle_deg, abs=0.5)
        assert f.width_px == pytest.approx(g.width_px, abs=6)  # full-res crops


def test_dpi_override_scales_mm(tmp_path):
    scan = make_scan(tmp_path / "scan.png")
    a, _ = split_scan(scan, tmp_path / "a", Options(pad_mm=0))
    b, _ = split_scan(scan, tmp_path / "b", Options(pad_mm=0, dpi=DPI * 2))
    assert b[0].width_mm == pytest.approx(a[0].width_mm / 2, abs=0.5)
