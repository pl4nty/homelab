import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lonLatToWorld,
  ORIGIN,
  TILE_SIZE,
  TILE_Z,
  tileBoundsWorld,
  tileInExtent,
  worldToLonLat,
  worldToTile,
} from '../shared/geo.ts';
import { clipLine, clipPolygon, pointInPolygon, ringArea, simplifyRing, sliceLine } from '../shared/poly.ts';

test('the origin maps to zero and back', () => {
  const [x, y] = lonLatToWorld(ORIGIN.lon, ORIGIN.lat);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
  const [lon, lat] = worldToLonLat(1234.5, -987.6);
  const [x2, y2] = lonLatToWorld(lon, lat);
  assert.ok(Math.abs(x2 - 1234.5) < 1e-6 && Math.abs(y2 + 987.6) < 1e-6);
});

test('world metres are within half a percent of true metres', () => {
  // 0.01 degrees of latitude is 1109.4 m on the ellipsoid at 35 degrees south; spherical Mercator stretches it slightly.
  const [, y] = lonLatToWorld(ORIGIN.lon, ORIGIN.lat + 0.01);
  assert.ok(Math.abs(y / 1109.4 - 1) < 0.005, `got ${y}`);
  // 0.01 degrees of longitude is 912.2 m there.
  const [x] = lonLatToWorld(ORIGIN.lon + 0.01, ORIGIN.lat);
  assert.ok(Math.abs(x / 912.2 - 1) < 0.005, `got ${x}`);
});

test('a point lies in the tile worldToTile names', () => {
  const [tx, ty] = worldToTile(3000, -4500);
  const b = tileBoundsWorld(TILE_Z, tx, ty);
  assert.ok(b[0] <= 3000 && 3000 < b[2] && b[1] <= -4500 && -4500 < b[3]);
  assert.ok(Math.abs(b[2] - b[0] - TILE_SIZE) < 1e-6);
  assert.ok(tileInExtent(tx, ty));
  assert.ok(!tileInExtent(tx + 500, ty));
});

test('clipPolygon cuts a square to the box', () => {
  const out = clipPolygon([[-5, -5, 5, -5, 5, 5, -5, 5]], [0, 0, 10, 10]);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(Math.abs(ringArea(out[0])) - 25) < 1e-9);
  assert.deepEqual(clipPolygon([[20, 20, 30, 20, 30, 30]], [0, 0, 10, 10]), []);
});

test('clipLine splits a line that leaves and returns', () => {
  const parts = clipLine([-5, 5, 5, 5, 5, 15, 8, 15, 8, 5], [0, 0, 10, 10]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], [0, 5, 5, 5, 5, 10]);
  assert.deepEqual(parts[1], [8, 10, 8, 5]);
});

test('sliceLine takes fractions of length', () => {
  assert.deepEqual(sliceLine([0, 0, 10, 0, 10, 10], 0.25, 0.75), [5, 0, 10, 0, 10, 5]);
});

test('pointInPolygon respects holes', () => {
  const rings = [
    [0, 0, 10, 0, 10, 10, 0, 10],
    [4, 4, 4, 6, 6, 6, 6, 4],
  ];
  assert.ok(pointInPolygon(1, 1, rings));
  assert.ok(!pointInPolygon(5, 5, rings));
});

test('simplifyRing keeps corners and drops points on an edge', () => {
  const r = simplifyRing([0, 0, 5, 0.01, 10, 0, 10, 10, 5, 10.01, 0, 10], 0.1);
  assert.equal(r.length, 8);
});
