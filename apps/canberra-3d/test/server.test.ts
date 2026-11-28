import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PbfWriter } from 'pbf';
import { chainLines, treeKind } from '../server/bake.ts';
import { despike } from '../server/dem.ts';
import { decodeTripUpdates, decodeVehiclePositions, parseCsv, tramKnots } from '../server/live.ts';
import { TreeKind } from '../shared/tile.ts';

test('parseCsv handles quotes, commas and a byte order mark', () => {
  const rows = parseCsv('﻿stop_id,stop_name\r\n"8100","Gungahlin Place, Platform 1"\r\n8101,"Say ""hi"""\r\n');
  assert.deepEqual(rows, [
    { stop_id: '8100', stop_name: 'Gungahlin Place, Platform 1' },
    { stop_id: '8101', stop_name: 'Say "hi"' },
  ]);
});

test('tree register genus maps to a shape', () => {
  assert.equal(treeKind('Eucalyptus'), TreeKind.Eucalypt);
  assert.equal(treeKind('QUERCUS palustris'), TreeKind.Deciduous);
  assert.equal(treeKind('Populus'), TreeKind.Columnar);
  assert.equal(treeKind('Cedrus'), TreeKind.Conifer);
  assert.equal(treeKind(''), TreeKind.Evergreen);
});

test('chainLines joins a bridge drawn in pieces, but not across a fork', () => {
  const joined = chainLines([{ p: [10, 0, 20, 0] }, { p: [0, 0, 10, 0] }, { p: [30, 0, 20, 0] }]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].p.length, 8);
  const fork = chainLines([{ p: [0, 0, 10, 0] }, { p: [10, 0, 20, 0] }, { p: [10, 0, 10, 10] }]);
  assert.equal(fork.length, 3);
});

test('a tram is placed by shifting its timetable to the predicted arrival', () => {
  const trip = {
    stops: [
      { arr: 100, dep: 100, at: 0 },
      { arr: 220, dep: 240, at: 1000 },
      { arr: 400, dep: 400, at: 2500 },
    ],
  };
  // Predicted to arrive 60 s late: every event moves by the same amount.
  const knots = tramKnots(trip, 5000 + 400 + 60, 5000 + 300);
  assert.deepEqual(knots, [5160, 0, 5280, 1000, 5300, 1000, 5460, 2500]);
  assert.equal(tramKnots(trip, 5460, 9000), null, 'finished trips are dropped');
  assert.equal(tramKnots(trip, 5460, 4000), null, 'trips yet to start are dropped');
});

test('trip updates decode to the last stop prediction', () => {
  const w = new PbfWriter();
  w.writeMessage(
    1,
    (_: null, p: PbfWriter) => {
      p.writeStringField(1, '2.0');
      p.writeVarintField(3, 1795527482);
    },
    null,
  );
  w.writeMessage(
    2,
    (_: null, p: PbfWriter) => {
      p.writeStringField(1, 'e1');
      p.writeMessage(
        3,
        (_: null, p: PbfWriter) => {
          p.writeMessage(1, (_: null, p: PbfWriter) => p.writeStringField(1, '157'), null);
          p.writeMessage(
            2,
            (_: null, p: PbfWriter) => {
              p.writeVarintField(1, 14);
              p.writeMessage(2, (_: null, p: PbfWriter) => p.writeVarintField(2, 1795530000), null);
              p.writeStringField(4, '8129');
            },
            null,
          );
        },
        null,
      );
    },
    null,
  );
  const out = decodeTripUpdates(w.finish());
  assert.equal(out.ts, 1795527482);
  assert.deepEqual(out.updates, [{ tripId: '157', arrival: 1795530000, seq: 14 }]);
});

test('vehicle positions decode to world metres', () => {
  const w = new PbfWriter();
  w.writeMessage(
    2,
    (_: null, p: PbfWriter) => {
      p.writeStringField(1, 'e1');
      p.writeMessage(
        4,
        (_: null, p: PbfWriter) => {
          p.writeMessage(1, (_: null, p: PbfWriter) => p.writeStringField(5, 'R4'), null);
          p.writeMessage(
            2,
            (_: null, p: PbfWriter) => {
              p.writeFloatField(1, -35.3082);
              p.writeFloatField(2, 149.1244);
              p.writeFloatField(3, 90);
            },
            null,
          );
          p.writeMessage(8, (_: null, p: PbfWriter) => p.writeStringField(1, 'BUS123'), null);
        },
        null,
      );
    },
    null,
  );
  const [v] = decodeVehiclePositions(w.finish());
  assert.equal(v.id, 'BUS123');
  assert.equal(v.route, 'R4');
  assert.equal(v.bearing, 90);
  // Single-precision coordinates land within a few metres of the origin.
  assert.ok(Math.hypot(v.x!, v.y!) < 5);
});

test('despike replaces stray elevation pixels and leaves a slope alone', () => {
  const size = 32;
  const slope = () => {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = 556 + x * 3;
    return h;
  };
  const h = slope();
  h[10 * size + 10] = -1405;
  // A smeared neighbour: wrong, but still a height that could be ground.
  h[10 * size + 11] = 320;
  h[20 * size + 5] = -32768;
  assert.equal(despike(h, 60, size), 3);
  assert.ok(Math.abs(h[10 * size + 10] - (556 + 30)) < 6);
  assert.ok(Math.abs(h[10 * size + 11] - (556 + 33)) < 6);
  assert.ok(Math.abs(h[20 * size + 5] - (556 + 15)) < 6);
  assert.equal(h[4 * size + 20], 556 + 60);
  assert.equal(despike(slope(), 60, size), 0);
});

test('despike fills a cluster too large for the median, a seam, and one at the tile edge', () => {
  const size = 32;
  const h = new Float32Array(size * size).fill(600);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) h[y * size + x] = -4908;
  for (let y = 0; y < size; y++) h[y * size + 27] = -5600;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) h[y * size + x] = 9000;
  assert.equal(despike(h, 60, size), 64 + 32 + 36);
  for (const v of h) assert.equal(v, 600);
});
