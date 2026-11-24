// Sun, sky and light for a time of day at Canberra's latitude.
import * as THREE from 'three';
import { ORIGIN } from '../shared/geo.ts';

const D2R = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Sky {
  /** Unit vector towards the sun (or the moon at night), in scene axes. */
  dir: THREE.Vector3;
  sun: THREE.Color;
  sunIntensity: number;
  skyTop: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  ambient: number;
  /** 0 by day, 1 in full dark. */
  night: number;
  elevation: number;
}

/** Solar position from local solar hour and day of year. */
export function sunAngles(hour: number, dayOfYear: number): { azimuth: number; elevation: number } {
  const dec = -23.44 * D2R * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
  const lat = ORIGIN.lat * D2R;
  const h = (hour - 12) * 15 * D2R;
  const elevation = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h));
  const azimuth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
  return { azimuth, elevation };
}

const C = (hex: number) => new THREE.Color(hex);
const DAY = { sun: C(0xfff3dc), top: C(0x3f86d8), horizon: C(0xc4dcf0), ground: C(0x7a7458) };
const DUSK = { sun: C(0xff9a52), top: C(0x4a5f9e), horizon: C(0xf6b98a), ground: C(0x6a5648) };
const NIGHT = { sun: C(0x8ea6d8), top: C(0x0a1024), horizon: C(0x27304f), ground: C(0x14171f) };

export function skyAt(hour: number, dayOfYear: number): Sky {
  const { azimuth, elevation } = sunAngles(hour, dayOfYear);
  const el = elevation / D2R;
  const night = 1 - smooth(-9, 1, el);
  const dusk = smooth(-9, 3, el) * (1 - smooth(4, 20, el));
  const mix = (k: 'sun' | 'top' | 'horizon' | 'ground') => DAY[k].clone().lerp(DUSK[k], dusk).lerp(NIGHT[k], night);
  // Keep the light off the horizon so shadows stay bounded, and swing to a high moon after dark.
  const litEl = night > 0.6 ? 50 * D2R : Math.max(elevation, 7 * D2R);
  const litAz = night > 0.6 ? azimuth + Math.PI * 0.7 : azimuth;
  const dir = new THREE.Vector3(Math.sin(litAz) * Math.cos(litEl), Math.sin(litEl), -Math.cos(litAz) * Math.cos(litEl));
  return {
    dir,
    sun: mix('sun'),
    sunIntensity: 2.5 * (1 - night) * (0.35 + 0.65 * smooth(-2, 18, el)) + 0.55 * night,
    skyTop: mix('top'),
    horizon: mix('horizon'),
    ground: mix('ground'),
    ambient: 0.95 * (1 - night) + 0.55 * night,
    night,
    elevation,
  };
}

/** A gradient dome with a sun disc. Cheap, and the horizon colour doubles as the fog colour. */
export function makeSkyDome(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      night: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float night;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(horizon, top, pow(h, 0.55));
        col = mix(col, horizon * 0.82, smoothstep(0.0, -0.25, d.y));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.28) * (1.0 - night * 0.75);
        // Stars: one bright cell in a few hundred.
        vec3 cell = floor(d * 180.0);
        float star = step(0.9965, hash(cell)) * night * smoothstep(0.02, 0.3, d.y);
        col += vec3(star);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}
