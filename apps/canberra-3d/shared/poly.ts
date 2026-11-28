// Planar geometry on flat [x0, y0, x1, y1, ...] rings.
export type Ring = number[];
export type BBox = [number, number, number, number];

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

export function ringBBox(r: Ring, out: BBox = [Infinity, Infinity, -Infinity, -Infinity]): BBox {
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < out[0]) out[0] = r[i];
    if (r[i] > out[2]) out[2] = r[i];
    if (r[i + 1] < out[1]) out[1] = r[i + 1];
    if (r[i + 1] > out[3]) out[3] = r[i + 1];
  }
  return out;
}

export function pointInRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, n = r.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i];
    const yi = r[i + 1];
    const xj = r[j];
    const yj = r[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, rings: Ring[]): boolean {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) return false;
  return true;
}

/** Drops the closing vertex and repeated points. */
export function cleanRing(r: Ring, eps = 0.01): Ring {
  const out: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - r[i]) < eps && Math.abs(out[n - 1] - r[i + 1]) < eps) continue;
    out.push(r[i], r[i + 1]);
  }
  const n = out.length;
  if (n >= 4 && Math.abs(out[0] - out[n - 2]) < eps && Math.abs(out[1] - out[n - 1]) < eps) out.length = n - 2;
  return out;
}

/** Sutherland-Hodgman clip of a ring to a box. Concave rings leave edges along the box, which fill correctly. */
export function clipRing(r: Ring, b: BBox): Ring {
  let cur = r;
  for (let side = 0; side < 4 && cur.length; side++) {
    const out: number[] = [];
    const axis = side & 1; // 0: x, 1: y
    const lim = b[side];
    const keepGreater = side < 2;
    const n = cur.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const a = cur[i + axis];
      const c = cur[j + axis];
      const ain = keepGreater ? a >= lim : a <= lim;
      const cin = keepGreater ? c >= lim : c <= lim;
      if (ain) out.push(cur[i], cur[i + 1]);
      if (ain !== cin) {
        const t = (lim - a) / (c - a);
        out.push(cur[i] + (cur[j] - cur[i]) * t, cur[i + 1] + (cur[j + 1] - cur[i + 1]) * t);
      }
    }
    cur = out;
  }
  return cur;
}

export function clipPolygon(rings: Ring[], b: BBox): Ring[] {
  const out: Ring[] = [];
  for (let i = 0; i < rings.length; i++) {
    const c = cleanRing(clipRing(rings[i], b));
    if (c.length >= 6 && Math.abs(ringArea(c)) > 0.05) out.push(c);
    else if (i === 0) return [];
  }
  return out;
}

/** Liang-Barsky clip of a polyline to a box; one input line can leave as several pieces. */
export function clipLine(p: number[], b: BBox): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i + 3 < p.length; i += 2) {
    let x0 = p[i];
    let y0 = p[i + 1];
    let x1 = p[i + 2];
    let y1 = p[i + 3];
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    const ps = [-dx, dx, -dy, dy];
    const qs = [x0 - b[0], b[2] - x0, y0 - b[1], b[3] - y0];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (ps[k] === 0) {
        if (qs[k] < 0) ok = false;
      } else {
        const t = qs[k] / ps[k];
        if (ps[k] < 0) {
          if (t > t1) ok = false;
          else if (t > t0) t0 = t;
        } else {
          if (t < t0) ok = false;
          else if (t < t1) t1 = t;
        }
      }
    }
    if (!ok) {
      if (cur.length >= 4) out.push(cur);
      cur = [];
      continue;
    }
    const nx0 = x0 + dx * t0;
    const ny0 = y0 + dy * t0;
    x1 = x0 + dx * t1;
    y1 = y0 + dy * t1;
    x0 = nx0;
    y0 = ny0;
    if (!cur.length || t0 > 0) {
      if (cur.length >= 4) out.push(cur);
      cur = [x0, y0];
    }
    cur.push(x1, y1);
    if (t1 < 1) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

export function lineLength(p: number[]): number {
  let len = 0;
  for (let i = 0; i + 3 < p.length; i += 2) len += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  return len;
}

/** The part of a polyline between two fractions of its length. */
export function sliceLine(p: number[], a: number, b: number): number[] {
  const total = lineLength(p);
  const from = a * total;
  const to = b * total;
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const seg = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
    const s0 = acc;
    const s1 = acc + seg;
    acc = s1;
    if (s1 < from || s0 > to || seg === 0) continue;
    const t0 = Math.max(0, (from - s0) / seg);
    const t1 = Math.min(1, (to - s0) / seg);
    if (!out.length) out.push(p[i] + (p[i + 2] - p[i]) * t0, p[i + 1] + (p[i + 3] - p[i + 1]) * t0);
    out.push(p[i] + (p[i + 2] - p[i]) * t1, p[i + 1] + (p[i + 3] - p[i + 1]) * t1);
  }
  return out;
}

/** Douglas-Peucker on an open polyline. */
export function simplifyLine(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n <= 2) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    const ax = p[lo * 2];
    const ay = p[lo * 2 + 1];
    const dx = p[hi * 2] - ax;
    const dy = p[hi * 2 + 1] - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push(lo, at, at, hi);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

/** Simplifies a closed ring, keeping at least a triangle. */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length <= 8) return r;
  // Split at the vertex farthest from the first so both halves have fixed ends.
  let far = 0;
  let best = -1;
  for (let i = 2; i < r.length; i += 2) {
    const d = (r[i] - r[0]) ** 2 + (r[i + 1] - r[1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplifyLine(r.slice(0, far + 2), tol);
  const b = simplifyLine([...r.slice(far), r[0], r[1]], tol);
  const out = [...a.slice(0, -2), ...b.slice(0, -2)];
  return out.length >= 6 ? out : r;
}
