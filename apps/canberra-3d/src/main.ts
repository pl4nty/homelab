import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { lonLatToWorld, worldToLonLat } from '../shared/geo.ts';
import { makeSkyDome, skyAt } from './atmosphere.ts';
import { Far } from './far.ts';
import { Labels } from './labels.ts';
import { Landmarks, type Place } from './landmarks.ts';
import { LiveLayer } from './live.ts';
import { shared } from './materials.ts';
import { Post } from './post.ts';
import { TileManager } from './tiles.ts';
import { TreeFactory } from './trees.ts';
import { buildUi, canberraNow } from './ui.ts';
import './style.css';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 5, 90000);
const post = new Post(renderer);

const sky = makeSkyDome();
scene.add(sky);
scene.fog = new THREE.Fog(0xc4dcf0, 2000, 30000);
const hemi = new THREE.HemisphereLight(0xffffff, 0x888866, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

const trees = new TreeFactory();
const tiles = new TileManager(trees, Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
tiles.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
scene.add(tiles.group);
const far = new Far();
far.load(tiles).then(
  (m) => scene.add(m),
  (e) => console.warn('far terrain', e),
);
const groundAt = (x: number, z: number) => tiles.heightAt(x, z) ?? far.heightAt(x, z);

const landmarks = new Landmarks();
scene.add(landmarks.group);
const labels = new Labels(document.getElementById('labels')!);
tiles.onLabels = (key, list, origin) => labels.set(key, list, origin);
tiles.onChange = () => landmarks.unsettle();
const live = new LiveLayer(groundAt);
scene.add(live.group);

const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.zoomToCursor = true;
controls.minDistance = 60;
controls.maxDistance = 16000;
controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
controls.screenSpacePanning = false;

const state = { hour: 15.5, day: canberraNow().day };

/** View as lat, lon, distance, bearing, tilt in the URL hash, so a view can be shared. */
function readHash(): boolean {
  const p = location.hash.slice(1).split(',').map(Number);
  if (p.length < 5 || p.some((v) => !Number.isFinite(v))) return false;
  const [lat, lon, dist, bearing, tilt] = p;
  const [x, y] = lonLatToWorld(lon, lat);
  setView(x, -y, dist, bearing, tilt);
  if (Number.isFinite(p[5])) state.hour = p[5];
  return true;
}
function setView(x: number, z: number, dist: number, bearing: number, tilt: number) {
  const ground = groundAt(x, z);
  controls.target.set(x, ground, z);
  const polar = THREE.MathUtils.degToRad(Math.min(84, Math.max(1, tilt)));
  const az = THREE.MathUtils.degToRad(bearing);
  // Bearing is the compass direction the camera looks along.
  camera.position.set(
    x - Math.sin(az) * Math.sin(polar) * dist,
    ground + Math.cos(polar) * dist,
    z + Math.cos(az) * Math.sin(polar) * dist,
  );
  camera.lookAt(controls.target);
  controls.update();
}
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const [lon, lat] = worldToLonLat(controls.target.x, -controls.target.z);
    const d = camera.position.distanceTo(controls.target);
    const off = camera.position.clone().sub(controls.target);
    const tilt = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, off.y / d)));
    const bearing = (THREE.MathUtils.radToDeg(Math.atan2(-off.x, off.z)) + 360) % 360;
    history.replaceState(
      null,
      '',
      `#${lat.toFixed(5)},${lon.toFixed(5)},${d.toFixed(0)},${bearing.toFixed(0)},${tilt.toFixed(0)},${state.hour.toFixed(1)}`,
    );
  }, 400);
}
controls.addEventListener('change', writeHash);
if (!readHash())
  setView(...(([x, y]) => [x, -y] as [number, number])(lonLatToWorld(149.1287, -35.2975)), 2600, 205, 58);
window.addEventListener('hashchange', readHash);

/** The current view as target, distance, bearing and tilt. */
function getView() {
  const off = camera.position.clone().sub(controls.target);
  const dist = off.length();
  return {
    x: controls.target.x,
    z: controls.target.z,
    dist,
    bearing: (THREE.MathUtils.radToDeg(Math.atan2(-off.x, off.z)) + 360) % 360,
    tilt: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, off.y / dist))),
  };
}
let flight: { from: ReturnType<typeof getView>; to: ReturnType<typeof getView>; t: number; time: number } | null = null;
let following: THREE.Object3D | null = null;
function flyTo(p: Place) {
  const [x, y] = lonLatToWorld(p.lon, p.lat);
  const from = getView();
  const to = { x, z: -y, dist: p.dist, bearing: p.bearing, tilt: p.tilt };
  // Turn the short way round.
  to.bearing = from.bearing + ((((to.bearing - from.bearing) % 360) + 540) % 360) - 180;
  const far = Math.hypot(to.x - from.x, to.z - from.z);
  flight = { from, to, t: 0, time: THREE.MathUtils.clamp(far / 2500, 1.4, 4) };
  following = null;
}
canvas.addEventListener('pointerdown', () => {
  flight = null;
  following = null;
});
canvas.addEventListener(
  'wheel',
  () => {
    flight = null;
  },
  { passive: true },
);

const ui = buildUi(
  document.getElementById('ui')!,
  {
    flyTo,
    setHour: (h) => {
      state.hour = h;
      writeHash();
    },
    setBlur: (on) => {
      post.blur = on ? 1 : 0;
    },
    setLabels: (on) => {
      labels.enabled = on;
    },
    setAutumn: (on) => {
      trees.season = on ? 'autumn' : 'summer';
      tiles.refreshTrees();
    },
    setLive: (on) => {
      live.enabled = on;
    },
    followTram: () => {
      following = live.first('tram');
      if (following) {
        const v = getView();
        setView(following.position.x, following.position.z, Math.min(v.dist, 420), v.bearing, Math.max(v.tilt, 62));
      }
      return following != null;
    },
  },
  state,
);
live.onStatus = () => ui.setLive(live.status, live.counts.tram);
live.start();

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
/** Arrow keys or WASD move, Q and E turn, R and F tilt, plus and minus zoom. */
function keyboard(dt: number) {
  if (!keys.size) return;
  const v = getView();
  const az = THREE.MathUtils.degToRad(v.bearing);
  const step = v.dist * dt * 0.9;
  let fwd = 0;
  let side = 0;
  if (keys.has('w') || keys.has('arrowup')) fwd += 1;
  if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
  if (keys.has('d') || keys.has('arrowright')) side += 1;
  if (keys.has('a') || keys.has('arrowleft')) side -= 1;
  let { bearing, tilt, dist } = v;
  if (keys.has('q')) bearing -= 60 * dt;
  if (keys.has('e')) bearing += 60 * dt;
  if (keys.has('r')) tilt -= 40 * dt;
  if (keys.has('f')) tilt += 40 * dt;
  if (keys.has('=') || keys.has('+')) dist *= 1 - dt * 1.2;
  if (keys.has('-') || keys.has('_')) dist *= 1 + dt * 1.2;
  if (!fwd && !side && bearing === v.bearing && tilt === v.tilt && dist === v.dist) return;
  flight = null;
  const x = v.x + (Math.sin(az) * fwd + Math.cos(az) * side) * step;
  const z = v.z + (-Math.cos(az) * fwd + Math.sin(az) * side) * step;
  setView(
    x,
    z,
    THREE.MathUtils.clamp(dist, controls.minDistance, controls.maxDistance),
    bearing,
    THREE.MathUtils.clamp(tilt, 2, 84),
  );
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  post.setSize(size.x, size.y);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function applySky() {
  const s = skyAt(state.hour, state.day);
  sun.color.copy(s.sun);
  sun.intensity = s.sunIntensity;
  hemi.color.copy(s.skyTop).lerp(s.horizon, 0.55);
  hemi.groundColor.copy(s.ground);
  hemi.intensity = s.ambient;
  const u = sky.material.uniforms;
  u.top.value.copy(s.skyTop);
  u.horizon.value.copy(s.horizon);
  u.sunDir.value.copy(s.dir);
  u.sunColor.value.copy(s.sun);
  u.night.value = s.night;
  (scene.fog as THREE.Fog).color.copy(s.horizon);
  shared.night.value = s.night;
  tiles.lampMat.opacity = s.night;
  post.exposure = 1 - s.night * 0.1;
  return s;
}

let lastFrame = performance.now();
let lastTileUpdate = 0;
function frame() {
  const dt = Math.min(0.1, (performance.now() - lastFrame) / 1000);
  lastFrame = performance.now();
  shared.time.value += dt;
  if (flight) {
    flight.t = Math.min(1, flight.t + dt / flight.time);
    const k = flight.t * flight.t * (3 - 2 * flight.t);
    const { from: a, to: b } = flight;
    const mix = (p: number, q: number) => p + (q - p) * k;
    // Rise in the middle of a long hop, so the ground does not rush past.
    const hop = Math.sin(Math.PI * k) * Math.min(2500, Math.hypot(b.x - a.x, b.z - a.z) * 0.35);
    setView(mix(a.x, b.x), mix(a.z, b.z), mix(a.dist, b.dist) + hop, mix(a.bearing, b.bearing), mix(a.tilt, b.tilt));
    if (flight.t >= 1) flight = null;
  } else if (following?.visible) {
    const v = getView();
    setView(following.position.x, following.position.z, v.dist, v.bearing, v.tilt);
  } else {
    keyboard(dt);
    controls.update();
  }

  // Keep the pivot on the ground as the terrain streams in underneath it.
  const ground = groundAt(controls.target.x, controls.target.z);
  const lift = (ground - controls.target.y) * Math.min(1, dt * 4);
  controls.target.y += lift;
  camera.position.y += lift;
  const floor = groundAt(camera.position.x, camera.position.z) + 8;
  if (camera.position.y < floor) camera.position.y = floor;

  const dist = camera.position.distanceTo(controls.target);
  const now = performance.now();
  if (now - lastTileUpdate > 250) {
    lastTileUpdate = now;
    const radius = THREE.MathUtils.clamp(dist * 1.5, 1800, 6500);
    tiles.update(controls.target.x, controls.target.z, radius, THREE.MathUtils.clamp(dist * 0.9, 900, 1700));
  }

  const s = applySky();
  landmarks.settle(
    (x, z) => tiles.heightAt(x, z),
    (x, z) => far.heightAt(x, z),
  );
  landmarks.update(shared.time.value, state.hour, s.night);
  live.update(dt);
  labels.update(camera, controls.target, window.innerWidth, window.innerHeight);
  const waiting = tiles.loading;
  ui.setStatus(
    waiting
      ? `Loading ${waiting} ${waiting === 1 ? 'tile' : 'tiles'}`
      : tiles.missing.size
        ? `Some data is unavailable: ${[...tiles.missing].join(', ')}`
        : 'Drag, scroll and explore',
  );
  // Fit the shadow map to what is in view, and snap it to whole texels so shadows do not crawl.
  const extent = THREE.MathUtils.clamp(dist * 0.9, 250, 2600);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -extent;
  cam.right = cam.top = extent;
  cam.near = 100;
  cam.far = 9000;
  cam.updateProjectionMatrix();
  const texel = (extent * 2) / sun.shadow.mapSize.x;
  const tx = Math.round(controls.target.x / texel) * texel;
  const tz = Math.round(controls.target.z / texel) * texel;
  sun.target.position.set(tx, controls.target.y, tz);
  sun.position.copy(sun.target.position).addScaledVector(s.dir, 4500);
  sun.target.updateMatrixWorld();

  camera.near = Math.max(3, dist * 0.02);
  camera.far = Math.max(40000, dist * 12);
  camera.updateProjectionMatrix();
  const fog = scene.fog as THREE.Fog;
  fog.near = Math.max(2500, dist * 1.6);
  fog.far = Math.max(16000, dist * 9);
  sky.position.copy(camera.position);
  sky.scale.setScalar(camera.far * 0.9);
  post.focus = dist;
  post.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handles for the console and for automated screenshots.
Object.assign(window, { app: { scene, camera, controls, tiles, state, setView, post, renderer, live, flyTo } });
