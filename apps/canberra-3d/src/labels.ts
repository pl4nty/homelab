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

  /** `range` stands in for the camera distance when the camera is at street level. */
  update(camera: THREE.PerspectiveCamera, focus: THREE.Vector3, w: number, h: number, range?: number) {
    const now = performance.now();
    if (now - this.last < 120) return;
    this.last = now;
    this.root.hidden = !this.enabled;
    if (!this.enabled) return;
    const dist = range ?? camera.position.distanceTo(focus);
    const shown: { x: number; y: number; w: number; item: Item; score: number }[] = [];
    const candidates: { item: Item; score: number }[] = [];
    const seen = new Set<string>();
    for (const list of this.sets.values()) {
      for (const item of list) {
        const d = Math.hypot(item.wx - focus.x, item.wz - focus.z);
        // Only things near the middle of the view, and big enough for this zoom.
        if (d > dist * 0.7 || item.rank * 13 < dist) continue;
        candidates.push({ item, score: item.rank - d * 0.02 });
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
      if (shown.some((s) => Math.abs(s.x - x) < (s.w + width) / 2 + 24 && Math.abs(s.y - y) < 40)) continue;
      seen.add(c.item.name);
      shown.push({ x, y, w: width, item: c.item, score: c.score });
    }
    for (let i = 0; i < MAX; i++) {
      const el = this.pool[i];
      const s = shown[i];
      if (!s) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      if (el.textContent !== s.item.name) el.textContent = s.item.name;
      el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
    }
  }
}
