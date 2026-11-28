# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Facade textures from Mapillary street photos, for one tile of the Canberra model.

A research pipeline, run offline. For each wall of the tile it:

1. finds the photos that look at the wall (Mapillary graph API);
2. keeps only the pixels Mapillary's own segmentation calls building, so trees, cars and sky drop out;
3. registers Mapillary's 3D mesh of each photo onto the model's footprints, because the published
   pose is only as good as a phone's GPS, and drops photos that will not fit;
4. drops the parts of a wall another building hides from the camera, and any texel whose distance
   in that mesh is not the wall's;
5. blends the photos that agree, texel by texel;
6. packs the walls that came out well into one atlas with an index.

Usage: MAPILLARY_TOKEN=... uv run build.py --server http://localhost:8080 --out data/facades 29958/19819
"""

import argparse
import base64
import gzip
import io
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# The model's world frame: Web Mercator scaled to metres at Capital Hill (see shared/geo.ts).
EARTH_R = 6378137.0
LAT0, LON0 = -35.3082, 149.1244
K = math.cos(math.radians(LAT0))
HALF = math.pi * EARTH_R
TILE = 2 * HALF / 2**15
VERSION = 1


def merc_x(lon: float) -> float:
    return EARTH_R * math.radians(lon)


def merc_y(lat: float) -> float:
    return EARTH_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def world(lon: float, lat: float) -> tuple[float, float]:
    return (merc_x(lon) - merc_x(LON0)) * K, (merc_y(lat) - merc_y(LAT0)) * K


def lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees((x / K + merc_x(LON0)) / EARTH_R)
    lat = math.degrees(2 * math.atan(math.exp((y / K + merc_y(LAT0)) / EARTH_R)) - math.pi / 2)
    return lon, lat


def tile_origin(tx: int, ty: int) -> tuple[float, float]:
    return (tx * TILE - HALF - merc_x(LON0)) * K, (HALF - (ty + 1) * TILE - merc_y(LAT0)) * K


TILE_M = TILE * K


def fetch(url: str, tries: int = 4) -> bytes:
    headers = {}
    token = os.environ.get("MAPILLARY_TOKEN")
    if token and "graph.mapillary.com" in url:
        headers["Authorization"] = f"OAuth {token}"
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=90
            ) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def cached(cache: Path, name: str, load) -> bytes:
    """Photos and their segmentation never change; keep them so a rerun costs nothing."""
    path = cache / name
    if path.exists():
        return path.read_bytes()
    data = load()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def rodrigues(r) -> np.ndarray:
    r = np.asarray(r, float)
    theta = float(np.linalg.norm(r))
    if theta < 1e-9:
        return np.eye(3)
    k = r / theta
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(theta) * kx + (1 - math.cos(theta)) * kx @ kx


def yaw(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


@dataclass
class Photo:
    id: str
    x: float
    y: float
    z: float
    rot: np.ndarray  # world (east, north, up) to camera (right, down, forward)
    focal: float
    k1: float
    k2: float
    width: int
    height: int
    pano: bool
    year: float
    url: str
    user: str
    mesh: str = ""  # where Mapillary's reconstruction of what this photo sees can be fetched
    shift: tuple[float, float, float] = (0.0, 0.0, 0.0)  # refined east, north, yaw
    fit: float = 0.0
    scale: float = 1.0  # what the mesh's distances must be multiplied by to be metres

    def centre(self) -> np.ndarray:
        return np.array([self.x + self.shift[0], self.y + self.shift[1], self.z])

    def rotation(self) -> np.ndarray:
        # Turning the camera about the vertical is a world rotation applied before the pose.
        return self.rot @ yaw(self.shift[2]).T

    def project(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """World points to normalised image coordinates (0 to 1, y down) and depth along the ray."""
        cam = (pts - self.centre()) @ self.rotation().T
        x, y, z = cam[..., 0], cam[..., 1], cam[..., 2]
        if self.pano:
            lon = np.arctan2(x, z)
            lat = np.arctan2(-y, np.hypot(x, z))
            return lon / (2 * math.pi) + 0.5, 0.5 - lat / math.pi, np.linalg.norm(cam, axis=-1)
        ok = z > 0.3
        zs = np.where(ok, z, 1.0)
        xn, yn = x / zs, y / zs
        r2 = xn * xn + yn * yn
        d = 1 + self.k1 * r2 + self.k2 * r2 * r2
        m = max(self.width, self.height)
        u = (self.focal * d * xn * m + self.width / 2) / self.width
        v = (self.focal * d * yn * m + self.height / 2) / self.height
        return np.where(ok, u, -1.0), np.where(ok, v, -1.0), z


@dataclass
class Wall:
    key: str
    a: tuple[float, float]  # the lexicographically smaller end, where texture u starts
    b: tuple[float, float]
    length: float
    normal: tuple[float, float]  # pointing out of the building
    height: float
    name: str
    photos: list = field(default_factory=list)


def harvest(box: tuple[float, float, float, float]) -> list[Photo]:
    """Every posed photo in a world-metre box, asked for in cells small enough not to hit the result cap."""
    fields = (
        "id,captured_at,is_pano,camera_type,computed_geometry,computed_rotation,computed_altitude,"
        "camera_parameters,width,height,creator,thumb_1024_url,mesh"
    )
    lon0, lat0 = lonlat(box[0], box[1])
    lon1, lat1 = lonlat(box[2], box[3])
    step = 0.0018
    found: dict[str, dict] = {}
    lat = lat0
    while lat < lat1:
        lon = lon0
        while lon < lon1:
            bbox = f"{lon:.6f},{lat:.6f},{min(lon + step, lon1):.6f},{min(lat + step, lat1):.6f}"
            query = urllib.parse.urlencode({"bbox": bbox, "limit": 2000, "fields": fields})
            for item in json.loads(fetch(f"https://graph.mapillary.com/images?{query}")).get(
                "data", []
            ):
                found[item["id"]] = item
            lon += step
        lat += step
    photos = []
    for i in found.values():
        if (
            "computed_geometry" not in i
            or "computed_rotation" not in i
            or "thumb_1024_url" not in i
        ):
            continue
        pano = bool(i.get("is_pano")) or i.get("camera_type") in ("spherical", "equirectangular")
        if not pano and i.get("camera_type") != "perspective":
            continue
        x, y = world(*i["computed_geometry"]["coordinates"])
        params = (i.get("camera_parameters") or [0.85, 0, 0]) + [0, 0]
        alt = i.get("computed_altitude")
        photos.append(
            Photo(
                id=i["id"],
                x=x,
                y=y,
                # The published altitude is height above the ground when it is sane at all.
                z=alt if alt is not None and 0.8 < alt < 4 else 1.8,
                rot=rodrigues(i["computed_rotation"]),
                focal=params[0],
                k1=params[1],
                k2=params[2],
                width=i["width"],
                height=i["height"],
                pano=pano,
                year=1970 + i["captured_at"] / 1000 / 31557600,
                url=i["thumb_1024_url"],
                user=i.get("creator", {}).get("username", ""),
                mesh=i.get("mesh", {}).get("url", ""),
            )
        )
    return photos


def load_walls(server: str, tx: int, ty: int, min_len: float, min_height: float) -> list[Wall]:
    raw = fetch(f"{server}/api/tile/15/{tx}/{ty}")
    tile = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    ox, oy = tile_origin(tx, ty)
    walls = []
    for b in tile["buildings"]:
        if b["h"] < min_height or b.get("mh"):
            continue
        ring = b["p"][0]
        pts = [(ring[k], ring[k + 1]) for k in range(0, len(ring), 2)]
        area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1], strict=True))
        if area < 0:
            pts.reverse()
        for p, q in zip(pts, pts[1:] + pts[:1], strict=True):
            length = math.hypot(q[0] - p[0], q[1] - p[1]) / 10
            if length < min_len:
                continue
            # Outward for a counter-clockwise ring, in metres.
            normal = ((q[1] - p[1]) / 10 / length, -(q[0] - p[0]) / 10 / length)
            lo, hi = sorted((p, q))
            walls.append(
                Wall(
                    # The client rebuilds this key from the same integers, whichever way it walks the ring.
                    key=f"{lo[0]},{lo[1]},{hi[0]},{hi[1]}",
                    a=(ox + lo[0] / 10, oy + lo[1] / 10),
                    b=(ox + hi[0] / 10, oy + hi[1] / 10),
                    length=length,
                    normal=normal,
                    height=b["h"],
                    name=b.get("name", ""),
                )
            )
    return walls


def varint(b: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        c = b[i]
        i += 1
        result |= (c & 127) << shift
        shift += 7
        if c < 128:
            return result, i


def proto(b: bytes):
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        kind = key & 7
        if kind == 0:
            value, i = varint(b, i)
        elif kind == 2:
            n, i = varint(b, i)
            value = b[i : i + n]
            i += n
        else:
            n = 4 if kind == 5 else 8
            value = b[i : i + n]
            i += n
        yield key >> 3, value


def segment_rings(geometry: str) -> list[list[tuple[float, float]]]:
    """A detection's outline: a one-feature vector tile, as rings in 0 to 1 image coordinates."""
    rings = []
    for tag, layer in proto(base64.b64decode(geometry)):
        if tag != 3:
            continue
        extent = next((v for t, v in proto(layer) if t == 5), 4096)
        for t, feature in proto(layer):
            if t != 2:
                continue
            for ft, packed in proto(feature):
                if ft != 4:
                    continue
                cmds, i = [], 0
                while i < len(packed):
                    c, i = varint(packed, i)
                    cmds.append(c)
                x = y = k = 0
                ring: list[tuple[float, float]] = []
                while k < len(cmds):
                    op, count = cmds[k] & 7, cmds[k] >> 3
                    k += 1
                    if op == 7:
                        continue
                    for _ in range(count):
                        x += (cmds[k] >> 1) ^ -(cmds[k] & 1)
                        y += (cmds[k + 1] >> 1) ^ -(cmds[k + 1] & 1)
                        k += 2
                        if op == 1 and ring:
                            rings.append(ring)
                            ring = []
                        ring.append((x / extent, y / extent))
                if ring:
                    rings.append(ring)
    return rings


MASK_W = 256


def building_mask(cache: Path, photo: Photo) -> np.ndarray | None:
    """Where Mapillary's segmentation sees a building, at low resolution; None when it has none."""
    raw = cached(
        cache,
        f"seg/{photo.id}.json",
        lambda: fetch(f"https://graph.mapillary.com/{photo.id}/detections?fields=value,geometry"),
    )
    detections = json.loads(raw).get("data", [])
    if not detections:
        return None
    h = max(1, round(MASK_W * photo.height / photo.width))
    img = Image.new("L", (MASK_W, h), 0)
    draw = ImageDraw.Draw(img)
    for d in detections:
        if d["value"] != "construction--structure--building":
            continue
        for ring in segment_rings(d["geometry"]):
            if len(ring) >= 3:
                draw.polygon([(x * MASK_W, y * h) for x, y in ring], fill=255)
    return np.asarray(img) > 0


def load_mesh(cache: Path, photo: Photo) -> tuple[np.ndarray, np.ndarray] | None:
    """Mapillary's reconstruction of what a photo sees: a few hundred vertices in the camera's own
    frame (x right, y down, z forward) and the triangles between them. None for panoramas, whose
    mesh would need wrapping at the seam, and for photos without one."""
    if photo.pano or not photo.mesh:
        return None
    raw = cached(cache, f"mesh/{photo.id}.bin", lambda: fetch(photo.mesh))
    verts: list[float] = []
    faces: list[int] = []
    for tag, value in proto(raw):
        if tag == 1 and isinstance(value, bytes):
            verts.extend(struct.unpack(f"<{len(value) // 4}f", value))
        elif tag == 2 and isinstance(value, int):
            faces.append(value)
        elif tag == 2:
            i = 0
            while i < len(value):
                index, i = varint(value, i)
                faces.append(index)
    if len(verts) < 9 or len(faces) < 3:
        return None
    v = np.array(verts, np.float32).reshape(-1, 3)
    f = np.array(faces).reshape(-1, 3)
    return v, f[(f < len(v)).all(axis=1)]


def mesh_pixels(
    photo: Photo, v: np.ndarray, shape: tuple[int, int]
) -> tuple[np.ndarray, np.ndarray]:
    """Where each mesh vertex falls in an image of the given size."""
    h, w = shape
    m = max(photo.width, photo.height)
    z = np.maximum(v[:, 2], 0.1)
    px = (photo.focal * v[:, 0] / z * m + photo.width / 2) / photo.width * w
    py = (photo.focal * v[:, 1] / z * m + photo.height / 2) / photo.height * h
    return px, py


def depth_map(photo: Photo, mesh: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    """Metres from the camera to whatever each part of the photo shows."""
    v, f = mesh
    h = max(1, round(MASK_W * photo.height / photo.width))
    px, py = mesh_pixels(photo, v, (h, MASK_W))
    img = Image.new("F", (MASK_W, h), 0.0)
    draw = ImageDraw.Draw(img)
    depth = v[:, 2][f].mean(axis=1)
    # Far faces first, so a nearer one painted later wins.
    for k in np.argsort(-depth):
        a, b, c = f[k]
        if v[a, 2] <= 0.1 or v[b, 2] <= 0.1 or v[c, 2] <= 0.1:
            continue
        draw.polygon([(px[a], py[a]), (px[b], py[b]), (px[c], py[c])], fill=float(depth[k]))
    return np.asarray(img) * photo.scale


def nearest_on_walls(pts: np.ndarray, segments: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For 2D points, the closest point on any wall and the distance to it."""
    a, d = segments[:, :2], segments[:, 2:] - segments[:, :2]
    t = ((pts[:, None, :] - a[None]) * d[None]).sum(-1) / np.maximum((d * d).sum(-1), 1e-9)[None]
    close = a[None] + d[None] * t.clip(0, 1)[..., None]
    dist = np.linalg.norm(close - pts[:, None, :], axis=-1)
    best = dist.argmin(axis=1)
    rows = np.arange(len(pts))
    return close[rows, best], dist[rows, best]


def refine(
    photo: Photo, mask: np.ndarray, mesh: tuple[np.ndarray, np.ndarray], segments: np.ndarray
) -> None:
    """Registers the photo's own 3D mesh onto the model's footprints.

    The published pose is GPS-grade, and the mesh's scale drifts. Every mesh vertex the
    segmentation calls building should lie on a wall in plan, so the camera is slid, turned and
    the mesh rescaled until they do (iterated closest point, in two dimensions). `fit` is left
    as the share of those vertices within 1.5 m of a wall.
    """
    v, _ = mesh
    px, py = mesh_pixels(photo, v, mask.shape)
    inside = (
        (v[:, 2] > 2)
        & (v[:, 2] < 90)
        & (px >= 0)
        & (px < mask.shape[1])
        & (py >= 0)
        & (py < mask.shape[0])
    )
    on_building = np.zeros(len(v), bool)
    on_building[inside] = mask[py[inside].astype(int), px[inside].astype(int)]
    cam = v[on_building].astype(float)
    if len(cam) < 12 or len(segments) == 0:
        photo.fit = 0.0
        return
    # Rays in the world for the published pose; the unknowns then act on these in plan.
    rays = (cam @ photo.rot)[:, :2]
    centre, angle, scale = np.array([photo.x, photo.y]), 0.0, 1.0

    def placed() -> np.ndarray:
        c, s = math.cos(angle), math.sin(angle)
        return centre + scale * rays @ np.array([[c, s], [-s, c]])

    for reach in (14.0, 10.0, 7.0, 5.0, 3.5, 2.5, 2.0, 2.0):
        pts = placed()
        target, dist = nearest_on_walls(pts, segments)
        use = dist < reach
        if use.sum() < 10:
            break
        p, q = pts[use], target[use]
        mp, mq = p.mean(0), q.mean(0)
        cov = (q - mq).T @ (p - mp) / len(p)
        turn = math.atan2(cov[1, 0] - cov[0, 1], cov[0, 0] + cov[1, 1])
        grow = (
            math.cos(turn) * (cov[0, 0] + cov[1, 1]) + math.sin(turn) * (cov[1, 0] - cov[0, 1])
        ) / max(((p - mp) ** 2).sum(1).mean(), 1e-9)
        # A mesh half or twice its claimed size is not a refinement, it is a wrong match.
        if not 0.6 < scale * grow < 1.7:
            grow = 1.0
        c, s = math.cos(turn), math.sin(turn)
        r = np.array([[c, -s], [s, c]])
        centre = grow * (r @ centre) + (mq - grow * (r @ mp))
        angle += turn
        scale *= grow
    moved = float(np.hypot(*(centre - np.array([photo.x, photo.y]))))
    _, dist = nearest_on_walls(placed(), segments)
    # A camera that had to move further than GPS error allows has latched on to the wrong street.
    if moved > 30 or abs(angle) > math.radians(25):
        photo.fit = 0.0
        return
    photo.shift = (float(centre[0] - photo.x), float(centre[1] - photo.y), angle)
    photo.scale = scale
    photo.fit = float((dist < 1.5).mean())


def hidden(photo: Photo, wall: Wall, s: np.ndarray, others: np.ndarray) -> np.ndarray:
    """For points along a wall, whether another wall stands between them and the camera."""
    cx, cy = photo.centre()[:2]
    ux, uy = (wall.b[0] - wall.a[0]) / wall.length, (wall.b[1] - wall.a[1]) / wall.length
    # Stop just short of the wall, so it does not hide itself or meet its neighbours at a corner.
    px = wall.a[0] + ux * s + wall.normal[0] * 0.4
    py = wall.a[1] + uy * s + wall.normal[1] * 0.4
    dx, dy = px[:, None] - cx, py[:, None] - cy
    ax, ay = others[None, :, 0], others[None, :, 1]
    ex, ey = others[None, :, 2] - ax, others[None, :, 3] - ay
    denom = dx * ey - dy * ex
    denom = np.where(np.abs(denom) < 1e-9, 1e-9, denom)
    t = ((ax - cx) * ey - (ay - cy) * ex) / denom
    u = ((ax - cx) * dy - (ay - cy) * dx) / denom
    return ((t > 0.02) & (t < 1) & (u > 0) & (u < 1)).any(axis=1)


def texture(cache: Path, wall: Wall, others: np.ndarray, masks: dict, depths: dict, ppm: float):
    """Blends the wall's photos texel by texel. Returns RGBA, coverage, and the photos used."""
    nu, nv = max(2, round(wall.length * ppm)), max(2, round(wall.height * ppm))
    s = (np.arange(nu) + 0.5) / ppm
    t = wall.height - (np.arange(nv) + 0.5) / ppm
    ux, uy = (wall.b[0] - wall.a[0]) / wall.length, (wall.b[1] - wall.a[1]) / wall.length
    ss, tt = np.meshgrid(s, t)
    pts = np.stack([wall.a[0] + ux * ss, wall.a[1] + uy * ss, tt], -1)
    colours, weights, used = [], [], []
    for photo in wall.photos:
        mask = masks.get(photo.id)
        if mask is None:
            continue
        u, v, depth = photo.project(pts)
        ok = (u > 0.01) & (u < 0.99) & (v > 0.01) & (v < 0.99)
        ok &= ~hidden(photo, wall, s, others)[None, :]
        mh, mw = mask.shape
        ok &= mask[(v.clip(0, 0.999) * mh).astype(int), (u.clip(0, 0.999) * mw).astype(int)]
        # The segmentation says "a building", not which one. Mapillary's mesh says how far away
        # the surface in the photo is: keep a texel only where that matches the wall's distance.
        seen = depths.get(photo.id)
        if seen is not None:
            dh, dw = seen.shape
            there = seen[(v.clip(0, 0.999) * dh).astype(int), (u.clip(0, 0.999) * dw).astype(int)]
            ok &= (there > 0) & (np.abs(there - depth) < np.maximum(3.0, 0.25 * depth))
        elif not photo.pano:
            continue
        if ok.mean() < 0.03:
            continue
        img = np.asarray(
            Image.open(
                io.BytesIO(cached(cache, f"img/{photo.id}.jpg", lambda p=photo: fetch(p.url)))
            ).convert("RGB")
        )
        ih, iw = img.shape[:2]
        rgb = img[(v.clip(0, 0.999) * ih).astype(int), (u.clip(0, 0.999) * iw).astype(int)].astype(
            np.float32
        )
        # Square-on and close is worth most: weight by how squarely the ray meets the wall, over distance.
        ray = pts - photo.centre()
        cos = -(ray[..., 0] * wall.normal[0] + ray[..., 1] * wall.normal[1]) / np.linalg.norm(
            ray, axis=-1
        )
        w = np.where(ok & (cos > 0.2), cos.clip(0, 1) ** 2 / np.maximum(depth, 4.0), 0.0).astype(
            np.float32
        )
        colours.append(rgb)
        weights.append(w)
        used.append(photo)
    if not colours:
        return None, 0.0, []
    c, w = np.stack(colours), np.stack(weights)
    # Views that disagree with the middle one are showing something in front of the wall.
    grey = np.where(w > 0, c.mean(-1), np.nan)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        # A texel no photo saw is all NaN, and stays unseen.
        warnings.simplefilter("ignore", RuntimeWarning)
        middle = np.nanmedian(grey, axis=0) if len(c) > 2 else None
    if middle is not None:
        w = np.where(np.abs(grey - middle) > 45, 0.0, w)
    # One photo alone is believed only if its camera lined up well with the model; otherwise a
    # texel needs two photos behind it.
    views = (w > 0).sum(0)
    trusted = np.stack([np.full(w.shape[1:], p.fit >= 0.6) for p in used])
    w = np.where((views[None] >= 2) | trusted, w, 0.0)
    total = w.sum(0)
    rgb = (c * w[..., None]).sum(0) / np.maximum(total, 1e-6)[..., None]
    seen = total > 0
    out = np.dstack([rgb.clip(0, 255), np.where(seen, 255, 0)]).astype(np.uint8)
    return out, float(seen.mean()), used


def pack(items: list[tuple[str, np.ndarray]], size: int):
    """Shelf packing, tallest first. Returns the atlas, the rectangle of each key, and what did not fit."""
    atlas = np.zeros((size, size, 4), np.uint8)
    rects, left = {}, []
    x = y = shelf = 0
    for key, img in sorted(items, key=lambda it: -it[1].shape[0]):
        h, w = img.shape[:2]
        if w + 2 > size:
            left.append(key)
            continue
        if x + w + 2 > size:
            x, y, shelf = 0, y + shelf + 2, 0
        if y + h + 2 > size:
            left.append(key)
            continue
        atlas[y : y + h, x : x + w] = img
        rects[key] = [x, y, w, h]
        x += w + 2
        shelf = max(shelf, h)
    return atlas, rects, left


def build(args, tx: int, ty: int) -> None:
    cache = Path(args.cache)
    ox, oy = tile_origin(tx, ty)
    walls = load_walls(args.server, tx, ty, args.min_length, args.min_height)
    # Buildings just over the tile's edge still stand in photos and in the way: they shape the
    # silhouette cameras are aligned to and block lines of sight, though only this tile's walls are textured.
    around = [
        w
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        if dx or dy
        for w in load_walls(args.server, tx + dx, ty + dy, 4, 3)
    ]
    everything = walls + around
    segments = np.array([[*w.a, *w.b] for w in everything], float).reshape(-1, 4)
    photos = harvest((ox - 60, oy - 60, ox + TILE_M + 60, oy + TILE_M + 60))
    found = len(photos)
    # An old photo may show whatever stood there before the building in the model.
    photos = [p for p in photos if p.year >= args.since]
    print(
        f"{tx}/{ty}: {len(walls)} walls, {len(photos)} of {found} photos since {args.since:g}",
        flush=True,
    )

    for w in walls:
        mid = ((w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2)
        ranked = []
        for p in photos:
            dx, dy = p.x - mid[0], p.y - mid[1]
            out = dx * w.normal[0] + dy * w.normal[1]
            if not 4 < out < 60:
                continue
            along = abs(dx * (w.b[0] - w.a[0]) + dy * (w.b[1] - w.a[1])) / w.length
            if along > w.length / 2 + 25:
                continue
            dist = math.hypot(dx, dy)
            if p.pano:
                facing = out / dist
            else:
                fwd = p.rot.T @ np.array([0, 0, 1.0])
                # Looking towards the wall's middle, not merely standing in front of it.
                facing = -(fwd[0] * dx + fwd[1] * dy) / dist
                if facing < 0.3:
                    continue
            ranked.append((facing * (out / dist) / max(dist, 10), p))
        w.photos = [p for _, p in sorted(ranked, key=lambda r: -r[0])[: args.views]]

    wanted = {p.id: p for w in walls for p in w.photos}

    # Downloads dominate a first run, so fetch everything the walls will need at once.
    def prefetch(p: Photo) -> None:
        try:
            cached(cache, f"img/{p.id}.jpg", lambda: fetch(p.url))
            cached(
                cache,
                f"seg/{p.id}.json",
                lambda: fetch(
                    f"https://graph.mapillary.com/{p.id}/detections?fields=value,geometry"
                ),
            )
            if p.mesh and not p.pano:
                cached(cache, f"mesh/{p.id}.bin", lambda: fetch(p.mesh))
        except Exception as e:
            print(f"  could not fetch {p.id}: {e}", flush=True)

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(prefetch, wanted.values()))
    masks: dict[str, np.ndarray | None] = {}
    depths: dict[str, np.ndarray | None] = {}
    mids = (segments[:, :2] + segments[:, 2:]) / 2
    fits = []
    for n, p in enumerate(wanted.values()):
        masks[p.id] = building_mask(cache, p)
        mesh = load_mesh(cache, p)
        if p.pano:
            continue
        if masks[p.id] is None or not masks[p.id].any() or mesh is None:
            masks[p.id] = None
            continue
        refine(p, masks[p.id], mesh, segments[np.hypot(mids[:, 0] - p.x, mids[:, 1] - p.y) < 150])
        fits.append(p.fit)
        # A photo whose buildings will not sit on the model's is left out altogether.
        if p.fit < args.min_fit:
            masks[p.id] = None
        else:
            depths[p.id] = depth_map(p, mesh)
        if n % 200 == 199:
            print(f"  {n + 1}/{len(wanted)} photos masked and aligned", flush=True)
    kept = sum(1 for f in fits if f >= args.min_fit)
    print(
        f"  {len(wanted)} photos wanted, {len(fits)} with mesh and segmentation, {kept} aligned; "
        f"median fit {float(np.median(fits)) if fits else 0:.2f}",
        flush=True,
    )

    done, credits, stats = [], set(), []
    for w in walls:
        if not w.photos:
            continue
        rgba, cover, used = texture(
            cache, w, segments[[o is not w for o in everything]], masks, depths, args.ppm
        )
        stats.append(cover)
        if rgba is None or cover < args.min_cover:
            continue
        done.append((w.key, rgba))
        credits.update(p.user for p in used if p.user)
    atlas, rects, left = pack(done, args.atlas)
    out = Path(args.out) / str(tx)
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(atlas).save(out / f"{ty}.webp", quality=82, method=4)
    index = {
        "v": VERSION,
        "size": args.atlas,
        "ppm": args.ppm,
        "walls": rects,
        # CC BY-SA 4.0: the photographers must be named wherever the textures are shown.
        "credits": sorted(credits),
    }
    (out / f"{ty}.json").write_text(json.dumps(index, separators=(",", ":")))
    length = sum(w.length for w in walls) or 1
    kept = sum(w.length for w in walls if w.key in rects)
    print(
        f"  textured {len(rects)} walls, {kept / length * 100:.0f}% of wall length; "
        f"{len(left)} did not fit the atlas; {sum(1 for s in stats if s < args.min_cover)} too patchy",
        flush=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tiles", nargs="+", help="tiles to build, as x/y at zoom 15")
    ap.add_argument(
        "--server",
        default="http://localhost:8080",
        help="the canberra-3d server to read walls from",
    )
    ap.add_argument(
        "--out",
        default="data/facades",
        help="where to write atlases; the server's DATA_DIR/facades",
    )
    ap.add_argument("--cache", default=".facade-cache", help="downloaded photos and segmentation")
    ap.add_argument("--ppm", type=float, default=6, help="texture pixels per metre of wall")
    ap.add_argument("--views", type=int, default=5, help="photos blended per wall")
    ap.add_argument("--atlas", type=int, default=4096, help="atlas side in pixels")
    ap.add_argument("--min-length", type=float, default=8, help="shortest wall to texture, metres")
    ap.add_argument(
        "--min-height", type=float, default=5, help="lowest building to texture, metres"
    )
    ap.add_argument(
        "--min-fit",
        type=float,
        default=0.4,
        help="share of a photo's building points that must land on walls",
    )
    ap.add_argument(
        "--since", type=float, default=2023, help="ignore photos taken before this year"
    )
    ap.add_argument(
        "--min-cover", type=float, default=0.45, help="share of a wall that must be seen to keep it"
    )
    args = ap.parse_args()
    for tile in args.tiles:
        tx, ty = (int(v) for v in tile.split("/"))
        build(args, tx, ty)


if __name__ == "__main__":
    sys.exit(main())
