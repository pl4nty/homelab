"""Find stickers that may be the same sticker scanned twice.

Candidates have the same physical size either way round. ORB keypoints are matched
and RANSAC aligns the two; then, once aligned, the outlines must overlap and the
colours must agree. Measured on the first 114 stickers:

    CrikeyCon rescan          691 inliers  IoU 0.99  dE90  6.7   duplicate
    Keycult pair              115          0.99            6.3   duplicate
    Unprompted octopus, other background   246  0.99       61    similar
    Poland CSC, glitter vs black            30  0.94       57    (below the similar bar)
    trading cards, same frame             102  0.99        69    similar
    CrikeyCon 11 vs CrikeyCon               15  0.88       89    (not matched)

A holo rescanned at another angle may differ more in colour than the CrikeyCon pair,
and then shows as similar rather than duplicate.
"""

from __future__ import annotations

from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

ORB = cv2.ORB_create(1000)
MATCH = cv2.BFMatcher(cv2.NORM_HAMMING)


def same_size(a, b, tol: float = 0.06) -> bool:
    x, y = sorted((a.w_mm, a.h_mm)), sorted((b.w_mm, b.h_mm))
    return all(abs(p - q) <= max(2.0, tol * max(p, q)) for p, q in zip(x, y))


@lru_cache(maxsize=4096)
def features(path: str):
    """Keypoints of a thumbnail (the path changes with each edit, so the cache stays valid)."""
    rgba = np.asarray(Image.open(path).convert("RGBA"))
    grey = cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)
    grey[rgba[..., 3] < 128] = 128
    kp, des = ORB.detectAndCompute(grey, None)
    return np.float32([k.pt for k in kp]), des, rgba


def compare(a: str, b: str) -> dict | None:
    (pa, da, A), (pb, db, B) = features(a), features(b)
    if da is None or db is None or len(pa) < 8 or len(pb) < 8:
        return None
    pairs = [m for m, n in (x for x in MATCH.knnMatch(db, da, k=2) if len(x) == 2) if m.distance < 0.75 * n.distance]
    if len(pairs) < 12:
        return None
    M, mask = cv2.estimateAffinePartial2D(pb[[m.queryIdx for m in pairs]], pa[[m.trainIdx for m in pairs]],
                                          method=cv2.RANSAC, ransacReprojThreshold=5)
    if M is None or not 0.9 < np.hypot(M[0, 0], M[1, 0]) < 1.1:
        return None
    inliers = int(mask.sum())
    W = cv2.warpAffine(B, M, (A.shape[1], A.shape[0]), borderValue=(0, 0, 0, 0))
    ma, mb = A[..., 3] > 127, W[..., 3] > 127
    iou = (ma & mb).sum() / max((ma | mb).sum(), 1)
    both = ma & mb
    if iou < 0.85 or both.sum() < 100:
        return None
    lab = lambda x: cv2.cvtColor(np.ascontiguousarray(x[..., :3]), cv2.COLOR_RGB2LAB)[both].astype(float)  # noqa: E731
    de90 = float(np.percentile(np.linalg.norm((lab(A) - lab(W)) * [100 / 255, 1, 1], axis=1), 90))
    kind = "duplicate" if iou > 0.9 and de90 < 25 else "similar" if inliers >= 40 else None
    return kind and {"kind": kind, "inliers": inliers, "iou": round(float(iou), 3), "de90": round(de90, 1)}
