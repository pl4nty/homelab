// Place names as HTML over the canvas: the highest-ranked few that fit without overlapping.
import * as THREE from 'three';
import type { Label } from './gen/types.ts';

interface Item extends Label {
  wx: number;
  wz: number;
}

const MAX = 14;

export class Labels {
  private sets = new Map<string, Item[]>();
  private pool: HTMLDivElement[] = [];
  private v = new THREE.Vector3();
  private last = 0;
  enabled = true;

  constructor(private root: HTMLElement) {
    for (let i = 0; i < MAX; i++) {
      const el = document.createElement('div');
      el.className = 'label';
      el.hidden = true;
      root.appendChild(el);
      this.pool.push(el);
    }
  }

  set(key: string, labels: Label[] | null, origin: [number, number]) {
    if (!labels) this.sets.delete(key);
    else
      this.sets.set(
        key,
        labels.map((l) => ({ ...l, wx: l.x + origin[0], wz: l.z + origin[1] })),
      );
  }

  private showing: Item[] = [];

  /**
   * Labels are chosen eight times a second, but placed every frame, so they hold still on their
   * buildings while the camera moves. `range` stands in for the camera distance at street level.
   */
  update(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, w: number, h: number, range?: number) {
    this.root.hidden = !this.enabled;
    if (!this.enabled) return;
    const now = performance.now();
    if (now - this.last >= 120) {
      this.last = now;
      this.choose(camera, focus, w, h, range ?? camera.position.distanceTo(focus));
    }
    for (let i = 0; i < MAX; i++) {
      const el = this.pool[i];
      const item = this.showing[i];
      if (!item) {
        el.hidden = true;
        continue;
      }
      this.v.set(item.wx, item.y, item.wz).project(camera);
      // Behind the camera or off the edge: hide until the next choice replaces it.
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      if (el.textContent !== item.name) el.textContent = item.name;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  private choose(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, w: number, h: number, dist: number) {
    const shown: { x: number; y: number; w: number; item: Item }[] = [];
    const candidates: { item: Item; score: number }[] = [];
    const seen = new Set<string>();
    // A label already up gets a head start, so two rivals do not swap places every pass.
    const current = new Set(this.showing);
    for (const list of this.sets.values()) {
      for (const item of list) {
        const d = Math.hypot(item.wx - focus.x, item.wz - focus.z);
        // Only things near the middle of the view, and big enough for this zoom.
        if (d > dist * 0.7 || item.rank * 13 < dist) continue;
        candidates.push({ item, score: item.rank - d * 0.02 + (current.has(item) ? 25 : 0) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (shown.length >= MAX) break;
      if (seen.has(c.item.name)) continue;
      this.v.set(c.item.wx, c.item.y, c.item.wz).project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 0.95 || Math.abs(this.v.y) > 0.9) continue;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      const width = c.item.name.length * 6.6 + 16;
      if (shown.some((o) => Math.abs(o.x - x) < (o.w + width) / 2 + 24 && Math.abs(o.y - y) < 40)) continue;
      seen.add(c.item.name);
      shown.push({ x, y, w: width, item: c.item });
    }
    // Keep each label in the element it already has, so its text does not hop between elements.
    const next: Item[] = new Array(MAX);
    const fresh: Item[] = [];
    for (const o of shown) {
      const slot = this.showing.indexOf(o.item);
      if (slot >= 0) next[slot] = o.item;
      else fresh.push(o.item);
    }
    for (let i = 0; i < MAX && fresh.length; i++) if (!next[i]) next[i] = fresh.shift()!;
    this.showing = next;
  }
}
