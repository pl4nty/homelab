import * as THREE from 'three';

/** Uniforms every material shares, updated once a frame. */
export const shared = {
  night: { value: 0 },
  time: { value: 0 },
};

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Worker meshes carry sRGB bytes; three expects linear vertex colours. */
function decodeVertexColours(shader: Shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    'diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));',
  );
}

export function vertexColourMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = decodeVertexColours;
  return m;
}

/**
 * Walls draw brickwork, windows with frames and blinds, and floor lines from position along and up
 * the wall; pitched roofs draw tile courses and the odd solar array. All of it fades to its average
 * with distance, so nothing shimmers.
 */
export function buildingMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.night;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 wall;\nvarying vec4 vWall;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = wall;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec4 vWall;
        uniform float uNight;
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        // 1 where a repeating pattern is resolved on screen, 0 where a cell is under a pixel.
        float resolved(vec2 cell, float lo, float hi) { vec2 w = fwidth(cell); return 1.0 - smoothstep(lo, hi, max(w.x, w.y)); }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));
        float style = floor(vWall.z + 0.001);
        float seed = fract(vWall.z);
        vec3 lit = vec3(0.0);
        if (style > 9.5) {
          // A pitched roof: x runs along the eave, y down the slope from the ridge.
          vec2 tile = vec2(vWall.x / 0.3, vWall.y / 0.42);
          float course = smoothstep(0.0, 0.2, fract(tile.y));
          float vary = h21(floor(tile) + seed * 13.0);
          diffuseColor.rgb *= mix(1.0, (0.74 + 0.26 * course) * (0.88 + 0.24 * vary), resolved(tile, 0.4, 1.0));
          if (seed > 0.62) {
            // Solar panels: a block of 1.05 by 1.72 m modules near the ridge.
            vec2 q = (vWall.xy - vec2(mix(-3.5, 1.0, fract(seed * 7.3)), 0.7)) / vec2(1.05, 1.72);
            vec2 count = vec2(floor(2.0 + fract(seed * 3.1) * 4.0), 1.0 + step(0.82, seed));
            if (q.x > 0.0 && q.y > 0.0 && q.x < count.x && q.y < count.y) {
              vec2 pf = fract(q);
              float cell = smoothstep(0.0, 0.06, pf.x) * smoothstep(0.0, 0.06, pf.y) * (1.0 - smoothstep(0.94, 1.0, pf.x)) * (1.0 - smoothstep(0.94, 1.0, pf.y));
              cell = mix(0.85, cell, resolved(q, 0.3, 0.9));
              diffuseColor.rgb = mix(vec3(0.5, 0.53, 0.57), vec3(0.015, 0.03, 0.085), cell);
            }
          }
        } else if (style > 0.5 && vWall.y > 0.0) {
          // Brickwork on houses and some blocks: stretcher bond, each brick its own shade.
          float bricks = style < 1.5 ? 1.0 : style < 2.5 ? step(0.45, seed) * 0.7 : 0.0;
          vec2 bq = vec2(vWall.x / 0.46, vWall.y / 0.15);
          bq.x += 0.5 * mod(floor(bq.y), 2.0);
          float mortar = smoothstep(0.0, 0.1, fract(bq.x)) * smoothstep(0.0, 0.18, fract(bq.y));
          diffuseColor.rgb *= mix(1.0, (0.8 + 0.2 * mortar) * (0.88 + 0.24 * h21(floor(bq))), bricks * resolved(bq, 0.35, 0.9));
          // A darker plinth, and walls a touch brighter towards the top.
          diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.15, 0.6, vWall.y)) * (0.96 + 0.08 * clamp(vWall.y / max(vWall.w, 1.0), 0.0, 1.0));

          // Bay and storey sizes per style: house, grid, curtain glass, civic.
          vec2 size = style < 1.5 ? vec2(3.4, 2.9) : style < 2.5 ? vec2(2.6 + seed, 3.2) : style < 3.5 ? vec2(1.8, 3.6) : vec2(3.2, 4.0);
          vec2 cell = vec2(vWall.x, vWall.y) / size;
          vec2 id = floor(cell);
          vec2 f = fract(cell);
          vec2 lo = style < 1.5 ? vec2(0.3, 0.32) : style < 2.5 ? vec2(0.18, 0.28) : style < 3.5 ? vec2(0.05, 0.08) : vec2(0.3, 0.2);
          vec2 hi = style < 1.5 ? vec2(0.7, 0.74) : style < 2.5 ? vec2(0.82, 0.78) : style < 3.5 ? vec2(0.95, 0.86) : vec2(0.7, 0.85);
          // Street level of shops and offices is glazed nearly floor to ceiling.
          if (style > 1.5 && style < 3.5 && id.y < 0.5) { lo = vec2(0.06, 0.06); hi = vec2(0.94, 0.8); }
          vec2 w = fwidth(cell);
          vec2 e = smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
          vec2 fr = vec2(0.035, 0.04);
          vec2 fe = smoothstep(lo - fr - w, lo - fr + w, f) * (1.0 - smoothstep(hi + fr - w, hi + fr + w, f));
          // No window in the storey cut off by the roof line, and houses skip some bays.
          float exists = step((id.y + 1.0) * size.y, vWall.w + 0.4);
          if (style < 1.5) exists *= step(0.35, h21(id + seed * 31.0));
          float detail = 1.0 - smoothstep(0.55, 1.3, max(w.x, w.y));
          float win = e.x * e.y * exists;
          float frame = fe.x * fe.y * exists * detail;
          // Far off, replace the pattern by its average so it does not shimmer.
          float cover = (hi.x - lo.x) * (hi.y - lo.y);
          win = mix(cover * 0.8 * exists, win, detail);
          // The line of each floor slab on framed buildings.
          if (style > 1.5) diffuseColor.rgb *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 0.05, f.y), detail);
          float r = h21(id + seed * 17.0);
          // Glass reflects more sky towards the top of each pane.
          float gy = clamp((f.y - lo.y) / (hi.y - lo.y), 0.0, 1.0);
          vec3 glass = mix(vec3(0.03, 0.05, 0.085), vec3(0.15, 0.25, 0.36), r * 0.55 + gy * 0.45);
          if (style > 2.5 && style < 3.5) glass = mix(vec3(0.04, 0.1, 0.15), vec3(0.17, 0.32, 0.4), r * 0.55 + gy * 0.45);
          // Blinds drawn part-way down some windows.
          glass = mix(glass, vec3(0.62, 0.6, 0.55), step(0.8, h21(id * 3.1 + seed * 5.0)) * step(0.5 + 0.3 * r, gy) * 0.75 * detail);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.22 + 0.05, frame);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.94);
          float on = step(style < 1.5 ? 0.55 : 0.62, h21(id * 1.7 + seed * 91.0));
          lit = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.9, 1.0), step(0.8, r)) * win * on * uNight * 1.6;
        }
        // A pale coping along the top of flat-roofed walls.
        if (style > 1.5 && style < 9.5) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.25 + 0.03, smoothstep(vWall.w - 0.55, vWall.w - 0.35, vWall.y));
        `,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += lit;');
  };
  return m;
}

/** Three scales of noise in one tiling texture: grain, mottle and broad patches. */
function detailTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  let seed = 1234567;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 8) / 16777216;
  };
  // Value noise on a wrapped grid of `cells`, so the texture tiles without a seam.
  const layer = (cells: number) => {
    const grid = Float32Array.from({ length: cells * cells }, rnd);
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const gy = (y / size) * cells;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const g = (i: number, j: number) => grid[(j % cells) * cells + (i % cells)];
        out[y * size + x] =
          (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) +
          (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
      }
    }
    return out;
  };
  const fine = layer(128);
  const speck = layer(64);
  const mottle = layer(16);
  const broad = layer(5);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (fine[i] * 0.6 + speck[i] * 0.4) * 255;
    data[i * 4 + 1] = (mottle[i] * 0.7 + speck[i] * 0.3) * 255;
    data[i * 4 + 2] = broad[i] * 255;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const detail = { value: null as THREE.DataTexture | null };

function grain(shader: Shader) {
  detail.value ??= detailTexture();
  shader.uniforms.uDetail = detail;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = (modelMatrix * vec4(position, 1.0)).xz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGround;\nuniform sampler2D uDetail;')
    .replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
      // The painted ground is a metre or so a pixel; this adds the grain of grass and asphalt
      // beneath that, and uneven tone above it.
      float fine = texture2D(uDetail, vGround / 5.0).r;
      float mid = texture2D(uDetail, vGround / 41.0).g;
      float broad = texture2D(uDetail, vGround / 370.0).b;
      float close = 1.0 / (1.0 + length(vViewPosition) * 0.006);
      diffuseColor.rgb *= mix(1.0, 0.76 + fine * 0.48, close) * (0.9 + mid * 0.2) * (0.93 + broad * 0.14);`,
    );
}

/** The ground: its painted tile, with grain. */
export function groundMaterial(map: THREE.Texture): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ map });
  m.onBeforeCompile = grain;
  return m;
}

/** Tree crowns: darker inside and underneath, with each face broken into leafy patches up close. */
export function foliageMaterial(leaves: THREE.Texture): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: leaves, alphaTest: 0.3, side: THREE.DoubleSide });
  m.alphaToCoverage = true;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vLeaf;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vLeaf = vec4((modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz, position.y);
        #else
          vLeaf = vec4((modelMatrix * vec4(position, 1.0)).xyz, position.y);
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec4 vLeaf;
        float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`,
      )
      // Cards are seen from both sides but lit as part of one crown, so the back is not flipped.
      .replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'),
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        // The unit tree stands 0 to 1: shade the crown from its underside up.
        diffuseColor.rgb *= mix(0.62, 1.1, smoothstep(0.38, 0.95, vLeaf.w));
        float close = 1.0 / (1.0 + length(vViewPosition) * 0.012);
        float leaf = h31(floor(vLeaf.xyz * 2.3)) * 0.6 + h31(floor(vLeaf.xyz * 6.1)) * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.72 + leaf * 0.56, close);`,
      );
  };
  return m;
}

/** Still water with drifting ripples and a sun glint. */
export function waterMaterial(): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({
    color: 0x3d7494,
    specular: 0x1c2328,
    shininess: 60,
    transparent: true,
    opacity: 0.94,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        vec2 wp = vWorld.xz;
        float t = uTime;
        vec2 g = vec2(0.0);
        g += vec2(cos(wp.x * 0.21 + t * 1.1), sin(wp.y * 0.19 - t * 0.9)) * 0.5;
        g += vec2(cos((wp.x + wp.y) * 0.53 - t * 1.7), sin((wp.x - wp.y) * 0.47 + t * 1.3)) * 0.35;
        g += vec2(cos(wp.y * 1.3 + t * 2.3), sin(wp.x * 1.1 + t * 2.1)) * 0.2;
        // Ripples fade with distance so the far lake is calm, not noisy.
        float fade = 1.0 / (1.0 + length(vViewPosition) * 0.004);
        vec3 normal = normalize((viewMatrix * vec4(normalize(vec3(g.x * 0.06 * fade, 1.0, g.y * 0.06 * fade)), 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`,
      );
  };
  return m;
}
