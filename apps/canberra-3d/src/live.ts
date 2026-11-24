// Live vehicles. Trams follow their timetable shifted to the latest arrival prediction, so they
// move smoothly between polls; buses, when the server has a key, ease towards each reported fix.
import * as THREE from 'three';
import type { LiveFeed, LiveVehicle, Transit } from '../shared/tile.ts';

const RED = new THREE.MeshLambertMaterial({ color: 0xc8202c });
const DARK = new THREE.MeshLambertMaterial({ color: 0x1c2026 });
const PALE = new THREE.MeshLambertMaterial({ color: 0xeeeeea });
const BLUE = new THREE.MeshLambertMaterial({ color: 0x1d5fa8 });

/** A five-module low-floor tram, 33 m long, nose along -z. */
function tramModel(): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
  };
  for (let i = 0; i < 5; i++) {
    const z = (i - 2) * 6.6;
    add(new THREE.BoxGeometry(2.65, 2.3, 6.2), RED, 0, 1.75, z);
    add(new THREE.BoxGeometry(2.7, 0.95, 5.6), DARK, 0, 2.1, z);
    add(new THREE.BoxGeometry(2.5, 0.35, 5.8), PALE, 0, 3.05, z);
    if (i < 4) add(new THREE.BoxGeometry(2.3, 2.1, 0.5), DARK, 0, 1.7, z + 3.3);
  }
  add(new THREE.BoxGeometry(1.2, 0.5, 2.4), DARK, 0, 3.45, 0);
  return g;
}

function busModel(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.7, 12), BLUE);
  body.position.y = 1.75;
  body.castShadow = true;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1, 11.2), DARK);
  glass.position.y = 2.25;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.25, 11), PALE);
  roof.position.y = 3.2;
  g.add(body, glass, roof);
  return g;
}

interface Shape {
  pts: number[];
  cum: number[];
}

interface Tracked {
  object: THREE.Group;
  data: LiveVehicle;
  seen: number;
  /** Buses: where it is drawn now, easing to the reported fix. */
  x: number;
  z: number;
  heading: number;
}

export class LiveLayer {
  readonly group = new THREE.Group();
  private shapes = new Map<string, Shape>();
  private vehicles = new Map<string, Tracked>();
  private polling = false;
  private clockSkew = 0;
  stations: Transit['stations'] = [];
  status = 'Connecting to live transport';
  counts = { tram: 0, bus: 0 };
  enabled = true;
  onStatus?: () => void;

  constructor(private heightAt: (x: number, z: number) => number) {}

  async start() {
    try {
      const t = (await (await fetch('/api/transit')).json()) as Transit;
      for (const [id, pts] of Object.entries(t.shapes)) {
        const cum = [0];
        for (let i = 2; i < pts.length; i += 2)
          cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
        this.shapes.set(id, { pts, cum });
      }
      this.stations = t.stations;
    } catch {
      this.status = 'Light rail timetable unavailable';
    }
    this.poll();
    setInterval(() => this.poll(), 15000);
  }

  private async poll() {
    if (this.polling || !this.enabled || document.hidden) return;
    this.polling = true;
    try {
      const q = new URLSearchParams(location.search).get('at');
      const feed = (await (await fetch(`/api/live${q ? `?at=${q}` : ''}`)).json()) as LiveFeed;
      // Run on the server's clock: knots are in its time, and a viewer's clock may be off.
      this.clockSkew = feed.ts - Date.now() / 1000;
      const now = performance.now();
      for (const v of feed.vehicles) {
        let t = this.vehicles.get(v.id);
        if (!t) {
          const object = v.k === 'tram' ? tramModel() : busModel();
          object.visible = false;
          this.group.add(object);
          t = { object, data: v, seen: now, x: v.x ?? 0, z: -(v.y ?? 0), heading: ((v.bearing ?? 0) * Math.PI) / 180 };
          this.vehicles.set(v.id, t);
        }
        t.data = v;
        t.seen = now;
      }
      for (const [id, t] of this.vehicles) {
        if (now - t.seen > 60000) {
          this.group.remove(t.object);
          this.vehicles.delete(id);
        }
      }
      this.counts = {
        tram: feed.vehicles.filter((v) => v.k === 'tram').length,
        bus: feed.vehicles.filter((v) => v.k === 'bus').length,
      };
      const rail = feed.sources.find((s) => s.name === 'Light rail');
      const parts: string[] = [];
      if (rail?.ok)
        parts.push(
          this.counts.tram
            ? `${this.counts.tram} tram${this.counts.tram === 1 ? '' : 's'} running`
            : 'No trams running now',
        );
      else parts.push('Light rail feed unavailable');
      if (this.counts.bus) parts.push(`${this.counts.bus} buses`);
      this.status = parts.join(' · ');
    } catch {
      this.status = 'Live transport unavailable';
    } finally {
      this.polling = false;
      this.onStatus?.();
    }
  }

  /** Point and direction at a distance along a shape. */
  private along(shape: Shape, s: number, out: { x: number; z: number; heading: number }) {
    const { pts, cum } = shape;
    const d = Math.min(cum[cum.length - 1], Math.max(0, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / seg;
    const ax = pts[lo * 2];
    const ay = pts[lo * 2 + 1];
    const bx = pts[hi * 2];
    const by = pts[hi * 2 + 1];
    out.x = ax + (bx - ax) * t;
    out.z = -(ay + (by - ay) * t);
    out.heading = Math.atan2(bx - ax, by - ay);
  }

  update(dt: number) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    const now = Date.now() / 1000 + this.clockSkew;
    const p = { x: 0, z: 0, heading: 0 };
    for (const t of this.vehicles.values()) {
      const v = t.data;
      if (v.k === 'tram' && v.knots && v.shape) {
        const shape = this.shapes.get(v.shape);
        const k = v.knots;
        if (!shape || now < k[0] || now > k[k.length - 2]) {
          t.object.visible = false;
          continue;
        }
        let i = 0;
        while (i + 4 < k.length && k[i + 2] < now) i += 2;
        const span = k[i + 2] - k[i] || 1;
        // Ease in and out of each stop instead of moving at one speed.
        const u = Math.min(1, Math.max(0, (now - k[i]) / span));
        const eased = u * u * (3 - 2 * u);
        this.along(shape, k[i + 1] + (k[i + 3] - k[i + 1]) * eased, p);
        t.x = p.x;
        t.z = p.z;
        t.heading = p.heading;
      } else if (v.x != null && v.y != null) {
        const f = Math.min(1, dt * 0.6);
        t.x += (v.x - t.x) * f;
        t.z += (-v.y - t.z) * f;
        if (v.bearing != null) t.heading = (v.bearing * Math.PI) / 180;
      } else continue;
      t.object.visible = true;
      t.object.position.set(t.x, this.heightAt(t.x, t.z) + 0.15, t.z);
      t.object.rotation.y = -t.heading;
    }
  }

  /** Where the vehicles are, for the "follow a tram" control. */
  first(kind: 'tram' | 'bus'): THREE.Object3D | null {
    for (const t of this.vehicles.values()) if (t.data.k === kind && t.object.visible) return t.object;
    return null;
  }
}
