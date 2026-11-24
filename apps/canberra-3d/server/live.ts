// Live public transport.
// Light rail: Canberra Metro publishes arrival predictions (GTFS-realtime trip updates) but no
// vehicle positions, so each tram is placed by running its timetable against the predicted
// arrival at the terminus.
// Buses: Transport Canberra's vehicle positions need an access key, so they are optional.
import { unzipSync } from 'fflate';
import { PbfReader } from 'pbf';
import { lonLatToWorld } from '../shared/geo.ts';
import type { LiveFeed, LiveVehicle, Transit } from '../shared/tile.ts';
import type { DiskCache } from './cache.ts';
import { fetchBuffer } from './net.ts';

const LIGHT_RAIL_RT = process.env.LIGHT_RAIL_RT_URL ?? 'http://files.transport.act.gov.au/feeds/lightrail.pb';
const LIGHT_RAIL_GTFS = process.env.LIGHT_RAIL_GTFS_URL ?? 'https://files.mobilitydatabase.org/mdb-935/latest.zip';
const BUS_RT = process.env.BUS_RT_URL ?? 'https://transport.api.act.gov.au/gtfs/data/gtfs/v2/vehicle-positions.pb';
/** "user:password" for HTTP Basic, issued by the ACT Government API portal. */
const BUS_AUTH = process.env.BUS_RT_AUTH ?? '';

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const seconds = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

interface Timetable {
  shapes: Record<string, number[]>;
  /** Cumulative metres at each shape vertex. */
  lengths: Record<string, number[]>;
  stations: Transit['stations'];
  trips: Map<
    string,
    { shape: string; headsign: string; route: string; stops: { arr: number; dep: number; at: number }[] }
  >;
}

/** Metres along a shape of the vertex nearest a point, searching forward from a floor. */
function locate(shape: number[], lengths: number[], x: number, y: number, floor: number): number {
  let best = Infinity;
  let at = floor;
  for (let i = 0; i + 3 < shape.length; i += 2) {
    const ax = shape[i];
    const ay = shape[i + 1];
    const dx = shape[i + 2] - ax;
    const dy = shape[i + 3] - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const d = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
    const s = lengths[i >> 1] + Math.sqrt(len2) * t;
    if (s >= floor - 1 && d < best) {
      best = d;
      at = s;
    }
  }
  return at;
}

export function buildTimetable(zip: Uint8Array): Timetable {
  const files = unzipSync(zip, { filter: (f) => /^(stops|stop_times|trips|shapes)\.txt$/.test(f.name) });
  const read = (name: string) => parseCsv(new TextDecoder().decode(files[name] ?? new Uint8Array()));
  const stops = new Map<string, { x: number; y: number }>();
  const stations: Transit['stations'] = [];
  for (const s of read('stops.txt')) {
    const [x, y] = lonLatToWorld(Number(s.stop_lon), Number(s.stop_lat));
    stops.set(s.stop_id, { x, y });
    if (s.location_type === '1')
      stations.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, name: s.stop_name });
  }
  const points = new Map<string, { seq: number; x: number; y: number }[]>();
  for (const p of read('shapes.txt')) {
    const [x, y] = lonLatToWorld(Number(p.shape_pt_lon), Number(p.shape_pt_lat));
    const list = points.get(p.shape_id) ?? [];
    list.push({ seq: Number(p.shape_pt_sequence), x, y });
    points.set(p.shape_id, list);
  }
  const shapes: Timetable['shapes'] = {};
  const lengths: Timetable['lengths'] = {};
  for (const [id, list] of points) {
    list.sort((a, b) => a.seq - b.seq);
    const flat: number[] = [];
    const len = [0];
    for (const p of list) {
      const n = flat.length;
      if (n) len.push(len[len.length - 1] + Math.hypot(p.x - flat[n - 2], p.y - flat[n - 1]));
      flat.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
    }
    shapes[id] = flat;
    lengths[id] = len;
  }
  const trips: Timetable['trips'] = new Map();
  for (const t of read('trips.txt')) {
    if (!shapes[t.shape_id]) continue;
    trips.set(t.trip_id, { shape: t.shape_id, headsign: t.trip_headsign, route: t.route_id, stops: [] });
  }
  const times = read('stop_times.txt').sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  for (const st of times) {
    const trip = trips.get(st.trip_id);
    const stop = stops.get(st.stop_id);
    if (!trip || !stop) continue;
    const prev = trip.stops[trip.stops.length - 1];
    trip.stops.push({
      arr: seconds(st.arrival_time),
      dep: seconds(st.departure_time || st.arrival_time),
      at: locate(shapes[trip.shape], lengths[trip.shape], stop.x, stop.y, prev?.at ?? 0),
    });
  }
  return { shapes, lengths, stations, trips };
}

interface TripUpdate {
  tripId: string;
  /** Predicted arrival at the last reported stop, unix seconds. */
  arrival: number;
  seq: number;
}

export function decodeTripUpdates(buf: Uint8Array): { ts: number; updates: TripUpdate[] } {
  const pbf = new PbfReader(buf);
  const out = { ts: 0, updates: [] as TripUpdate[] };
  const sub = () => pbf.readVarint() + pbf.pos;
  pbf.readFields((tag) => {
    if (tag === 1) {
      pbf.readFields(
        (t) => {
          if (t === 3) out.ts = pbf.readVarint();
        },
        null,
        sub(),
      );
    } else if (tag === 2) {
      pbf.readFields(
        (t) => {
          if (t !== 3) return;
          const u: TripUpdate = { tripId: '', arrival: 0, seq: 0 };
          pbf.readFields(
            (f) => {
              if (f === 1) {
                pbf.readFields(
                  (d) => {
                    if (d === 1) u.tripId = pbf.readString();
                  },
                  null,
                  sub(),
                );
              } else if (f === 2) {
                let seq = 0;
                let time = 0;
                pbf.readFields(
                  (s) => {
                    if (s === 1) seq = pbf.readVarint();
                    else if (s === 2 || s === 3) {
                      pbf.readFields(
                        (e) => {
                          if (e === 2) time = pbf.readVarint();
                        },
                        null,
                        sub(),
                      );
                    }
                  },
                  null,
                  sub(),
                );
                if (seq >= u.seq && time) {
                  u.seq = seq;
                  u.arrival = time;
                }
              }
            },
            null,
            sub(),
          );
          if (u.tripId && u.arrival) out.updates.push(u);
        },
        null,
        sub(),
      );
    }
  }, null);
  return out;
}

export function decodeVehiclePositions(buf: Uint8Array): LiveVehicle[] {
  const pbf = new PbfReader(buf);
  const out: LiveVehicle[] = [];
  const sub = () => pbf.readVarint() + pbf.pos;
  pbf.readFields((tag) => {
    if (tag !== 2) return;
    let entity = '';
    pbf.readFields(
      (t) => {
        if (t === 1) entity = pbf.readString();
        if (t !== 4) return;
        const v: LiveVehicle = { id: entity, k: 'bus', route: '' };
        let lat = 0;
        let lon = 0;
        pbf.readFields(
          (f) => {
            if (f === 1) {
              pbf.readFields(
                (d) => {
                  if (d === 5) v.route = pbf.readString();
                },
                null,
                sub(),
              );
            } else if (f === 2) {
              pbf.readFields(
                (p) => {
                  if (p === 1) lat = pbf.readFloat();
                  else if (p === 2) lon = pbf.readFloat();
                  else if (p === 3) v.bearing = Math.round(pbf.readFloat());
                },
                null,
                sub(),
              );
            } else if (f === 5) v.at = pbf.readVarint();
            else if (f === 8) {
              pbf.readFields(
                (d) => {
                  if (d === 1) v.id = pbf.readString() || v.id;
                  else if (d === 2) v.headsign = pbf.readString();
                },
                null,
                sub(),
              );
            }
          },
          null,
          sub(),
        );
        if (lat && lon) {
          const [x, y] = lonLatToWorld(lon, lat);
          v.x = Math.round(x * 10) / 10;
          v.y = Math.round(y * 10) / 10;
          out.push(v);
        }
      },
      null,
      sub(),
    );
  }, null);
  return out;
}

/** Where a trip is at each timetable event, shifted so it reaches its last stop at the predicted time. */
export function tramKnots(
  trip: { stops: { arr: number; dep: number; at: number }[] },
  arrival: number,
  now: number,
): number[] | null {
  const stops = trip.stops;
  if (stops.length < 2) return null;
  const shift = arrival - stops[stops.length - 1].arr;
  if (now < stops[0].dep + shift - 60 || now > arrival + 30) return null;
  const knots: number[] = [];
  for (const s of stops) {
    knots.push(s.arr + shift, Math.round(s.at));
    if (s.dep > s.arr) knots.push(s.dep + shift, Math.round(s.at));
  }
  // Keep the stretch around now: enough for the client to animate until its next poll.
  const out: number[] = [];
  for (let i = 0; i < knots.length; i += 2) {
    const before = i + 2 < knots.length && knots[i + 2] < now - 60;
    const after = i >= 2 && knots[i - 2] > now + 300;
    if (!before && !after) out.push(knots[i], knots[i + 1]);
  }
  return out.length >= 4 ? out : null;
}

export class Live {
  private timetable: Promise<Timetable> | null = null;
  private timetableAt = 0;
  private feed: Promise<LiveFeed> | null = null;
  private feedAt = 0;

  constructor(private disk: DiskCache) {}

  private loadTimetable(): Promise<Timetable> {
    // The timetable changes a few times a year; a weekly refresh is plenty.
    if (!this.timetable || Date.now() - this.timetableAt > 7 * 86400e3) {
      this.timetableAt = Date.now();
      const week = Math.floor(Date.now() / (7 * 86400e3));
      this.timetable = this.disk
        .getOrBuild(`gtfs/light-rail-${week}.zip`, () => fetchBuffer(LIGHT_RAIL_GTFS))
        .then((zip) => buildTimetable(zip));
      this.timetable.catch(() => {
        this.timetable = null;
      });
    }
    return this.timetable;
  }

  async transit(): Promise<Transit> {
    const t = await this.loadTimetable();
    return { shapes: t.shapes, stations: t.stations };
  }

  /** `at` replays today's predictions at another unix time, for checking the tram layer out of hours. */
  current(at?: number): Promise<LiveFeed> {
    if (at) return this.poll(at);
    if (!this.feed || Date.now() - this.feedAt > 10000) {
      this.feedAt = Date.now();
      this.feed = this.poll();
    }
    return this.feed;
  }

  private async poll(at?: number): Promise<LiveFeed> {
    const now = at ?? Math.floor(Date.now() / 1000);
    const out: LiveFeed = { ts: now, vehicles: [], sources: [] };
    try {
      const [table, raw] = await Promise.all([this.loadTimetable(), fetchBuffer(LIGHT_RAIL_RT, {}, 2, 10000)]);
      const { ts, updates } = decodeTripUpdates(raw);
      for (const u of updates) {
        const trip = table.trips.get(u.tripId);
        if (!trip) continue;
        const knots = tramKnots(trip, u.arrival, now);
        if (knots)
          out.vehicles.push({
            id: `tram-${u.tripId}`,
            k: 'tram',
            route: '1',
            headsign: trip.headsign,
            shape: trip.shape,
            knots,
          });
      }
      const stale = !at && now - ts > 300;
      out.sources.push({
        name: 'Light rail',
        ok: !stale,
        note: stale ? 'feed is stale' : 'placed from arrival predictions',
      });
    } catch (e) {
      out.sources.push({ name: 'Light rail', ok: false, note: (e as Error).message });
    }
    if (BUS_AUTH) {
      try {
        const headers = { authorization: `Basic ${Buffer.from(BUS_AUTH).toString('base64')}` };
        const buses = decodeVehiclePositions(await fetchBuffer(BUS_RT, { headers }, 2, 10000));
        out.vehicles.push(...buses.filter((b) => !b.at || now - b.at < 300));
        out.sources.push({ name: 'Buses', ok: true });
      } catch (e) {
        out.sources.push({ name: 'Buses', ok: false, note: (e as Error).message });
      }
    } else {
      out.sources.push({ name: 'Buses', ok: false, note: 'needs an ACT Government API key' });
    }
    return out;
  }
}
