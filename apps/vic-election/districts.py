import json, sys, math
src, dst, tol = sys.argv[1], sys.argv[2], float(sys.argv[3])
def dp(pts, eps):
    n = len(pts)
    if n < 3: return pts
    keep = [False]*n; keep[0] = keep[-1] = True
    stack = [(0, n-1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx-ax, by-ay; L = math.hypot(dx, dy)
        md, mi = -1, -1
        for i in range(a+1, b):
            px, py = pts[i]
            d = abs(dy*px - dx*py + bx*ay - by*ax)/L if L else math.hypot(px-ax, py-ay)
            if d > md: md, mi = d, i
        if md > eps:
            keep[mi] = True; stack += [(a, mi), (mi, b)]
    return [p for p, k in zip(pts, keep) if k]
def area(r):
    return abs(sum(r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1] for i in range(len(r)-1)))/2
d = json.load(open(src))
out = []
for f in d['features']:
    g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    big = max(area(p[0]) for p in polys)
    np_ = []
    for p in polys:
        if area(p[0]) < max(big*0.002, 2e-6): continue
        rings = []
        for i, r in enumerate(p):
            if i and area(r) < 2e-6: continue
            s = dp(r, tol)
            if len(s) >= 4: rings.append([[round(x, 4), round(y, 4)] for x, y in s])
        if rings: np_.append(rings)
    name = f['properties']['district_label'].replace(' District', '')
    out.append({'type': 'Feature', 'properties': {'name': name}, 'geometry': {'type': 'MultiPolygon', 'coordinates': np_}})
json.dump({'type': 'FeatureCollection', 'features': out}, open(dst, 'w'), separators=(',', ':'))
