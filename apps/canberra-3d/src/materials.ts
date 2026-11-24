import * as THREE from 'three';

/** Uniforms every material shares, updated once a frame. */
export const shared = {
  night: { value: 0 },
  time: { value: 0 },
  /** Colour of the sky near the horizon, which water reflects at a low angle. */
  sky: { value: new THREE.Color(0xc4dcf0) },
  /** How much of the aerial photograph shows: 0 for drawn colours only. */
  photo: { value: 1 },
};

/** Stands in where a tile has no photograph: fully transparent, so nothing is blended. */
export const noPhoto = new THREE.DataTexture(new Uint8Array(4), 1, 1);
noPhoto.needsUpdate = true;

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
export function buildingMaterial(photo: THREE.Texture, tileSize: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  // One material per tile, all sharing a program: each has its own photograph.
  m.userData.photo = { value: photo };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.night;
    shader.uniforms.uPhoto = m.userData.photo;
    shader.uniforms.uPhotoMix = shared.photo;
    shader.uniforms.uTile = { value: tileSize };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 wall;\nvarying vec4 vWall;\nvarying vec2 vPlan;\nuniform float uTile;',
      )
      // A roof seen from above lies at its plan position in the tile's photograph, north at the top.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWall = wall;\nvPlan = vec2(position.x / uTile, 1.0 + position.z / uTile);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec4 vWall;
        varying vec2 vPlan;
        uniform float uNight; uniform float uPhotoMix; uniform sampler2D uPhoto;
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
        // Roofs take the aerial photograph where there is one; the drawn roof shows through faintly as relief.
        vec4 real = style > 9.5 ? texture2D(uPhoto, vPlan) : vec4(0.0);
        float photo = real.a * uPhotoMix;
        vec3 drawn = diffuseColor.rgb;
        if (style > 19.5) {
          // A flat roof, in metres: laid in sheets, each weathered a little differently, with broad stains.
          vec2 sheet = seed > 0.5 ? vec2(vWall.x / 1.8, vWall.y / 7.5) : vec2(vWall.y / 1.8, vWall.x / 7.5);
          float seam = smoothstep(0.0, 0.07, fract(sheet.x)) * smoothstep(0.0, 0.02, fract(sheet.y));
          diffuseColor.rgb *= mix(1.0, (0.84 + 0.16 * seam) * (0.9 + 0.2 * h21(floor(sheet) + seed * 9.0)), resolved(sheet, 0.35, 1.0));
          vec2 stain = vWall.xy / 6.0;
          diffuseColor.rgb *= mix(1.0, 0.9 + 0.2 * h21(floor(stain) + seed * 3.0), resolved(stain, 0.5, 1.6));
        } else if (style > 9.5) {
          // A pitched roof: x runs along the eave, y down the slope from the ridge.
          // Sheets or rows of tiles weather in streaks down the slope, and the ridge is capped.
          vec2 run = vec2(vWall.x / 0.9);
          diffuseColor.rgb *= mix(1.0, 0.88 + 0.24 * h21(vec2(floor(run.x), seed * 7.0)), resolved(run, 0.5, 1.4));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.3 + 0.03, (1.0 - smoothstep(0.1, 0.28, vWall.y)) * resolved(vec2(vWall.y / 0.3), 0.6, 1.8));
          vec2 tile = vec2(vWall.x / 0.3, vWall.y / 0.42);
          float course = smoothstep(0.0, 0.2, fract(tile.y));
          float vary = h21(floor(tile) + seed * 13.0);
          diffuseColor.rgb *= mix(1.0, (0.74 + 0.26 * course) * (0.88 + 0.24 * vary), resolved(tile, 0.4, 1.0));
          // Drawn solar panels only where no photograph shows the real ones.
          if (seed > 0.62 && photo < 0.5) {
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
        if (style > 9.5) diffuseColor.rgb = mix(diffuseColor.rgb, real.rgb * (0.82 + 0.18 * dot(diffuseColor.rgb, vec3(0.333)) / max(dot(drawn, vec3(0.333)), 0.02)), photo * 0.92);
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

/** A tiling canvas texture centred on mid grey, so multiplying by twice its value leaves colour unchanged on average. */
function surfaceTexture(
  draw: (ctx: CanvasRenderingContext2D, size: number, rnd: () => number) => void,
): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, size, size);
  let seed = 99;
  draw(ctx, size, () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Draws at a point and at its wrapped copies, so marks that cross an edge continue on the other side. */
function wrapped(size: number, x: number, y: number, fn: (x: number, y: number) => void) {
  for (const ox of [0, -size]) for (const oy of [0, -size]) fn(x + ox, y + oy);
}

/** Grass: thousands of short blades in the greens, yellows and shadows of a lawn. */
const grassTexture = () =>
  surfaceTexture((ctx, size, rnd) => {
    const tints = [
      'rgba(92,116,78,0.6)',
      'rgba(108,128,84,0.6)',
      'rgba(152,164,108,0.55)',
      'rgba(166,158,104,0.5)',
      'rgba(126,146,98,0.6)',
      'rgba(78,100,70,0.5)',
    ];
    for (let i = 0; i < 9000; i++) {
      const len = 3 + rnd() * 6;
      const a = -Math.PI / 2 + (rnd() - 0.5) * 1.5;
      ctx.strokeStyle = tints[Math.floor(rnd() * tints.length)];
      ctx.lineWidth = 0.8 + rnd() * 0.8;
      wrapped(size, rnd() * size, rnd() * size, (x, y) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      });
    }
  });

/** Asphalt: aggregate speckle, darker repairs and the odd crack. */
const asphaltTexture = () =>
  surfaceTexture((ctx, size, rnd) => {
    for (let i = 0; i < 14; i++) {
      const r = 14 + rnd() * 34;
      ctx.fillStyle = `rgba(${rnd() > 0.5 ? '70,70,74' : '160,160,156'},0.12)`;
      wrapped(size, rnd() * size, rnd() * size, (x, y) => {
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.4 + rnd() * 0.6), rnd() * 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    for (let i = 0; i < 16000; i++) {
      const v = 78 + Math.floor(rnd() * 104);
      ctx.fillStyle = `rgba(${v},${v},${v + 2},0.6)`;
      ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd(), 1 + rnd());
    }
    ctx.strokeStyle = 'rgba(52,52,56,0.45)';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 5; i++) {
      let x = rnd() * size;
      let y = rnd() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 9; k++) {
        x += (rnd() - 0.5) * 30;
        y += rnd() * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

/** Paving: square slabs, each its own shade, with dark joints and a little grit. */
const pavingTexture = () =>
  surfaceTexture((ctx, size, rnd) => {
    const n = 8;
    const w = size / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = 114 + Math.floor(rnd() * 30);
        ctx.fillStyle = `rgb(${v + 2},${v},${v - 3})`;
        ctx.fillRect(i * w, j * w, w, w);
      }
    }
    for (let i = 0; i < 5000; i++) {
      const v = 96 + Math.floor(rnd() * 64);
      ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
    }
    ctx.strokeStyle = 'rgb(82,82,80)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      ctx.moveTo(i * w, 0);
      ctx.lineTo(i * w, size);
      ctx.moveTo(0, i * w);
      ctx.lineTo(size, i * w);
    }
    ctx.stroke();
  });

const surfaces = {
  grass: { value: null as THREE.Texture | null },
  asphalt: { value: null as THREE.Texture | null },
  paving: { value: null as THREE.Texture | null },
};

/**
 * The ground: its painted tile, textured by what each part is made of. The mask says how much of
 * a point is asphalt (red), paving (green) or vegetation (blue); what is left is bare earth.
 */
export function groundMaterial(
  map: THREE.Texture,
  mask: THREE.Texture,
  photo: THREE.Texture,
): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ map });
  // Held on the material so a repaint can swap the mask without recompiling.
  m.userData.mask = { value: mask };
  m.userData.photo = { value: photo };
  m.onBeforeCompile = (shader) => {
    detail.value ??= detailTexture();
    surfaces.grass.value ??= grassTexture();
    surfaces.asphalt.value ??= asphaltTexture();
    surfaces.paving.value ??= pavingTexture();
    shader.uniforms.uDetail = detail;
    shader.uniforms.uGrass = surfaces.grass;
    shader.uniforms.uAsphalt = surfaces.asphalt;
    shader.uniforms.uPaving = surfaces.paving;
    shader.uniforms.uMask = m.userData.mask;
    shader.uniforms.uPhoto = m.userData.photo;
    shader.uniforms.uPhotoMix = shared.photo;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vGround;\nuniform sampler2D uDetail; uniform sampler2D uGrass; uniform sampler2D uAsphalt; uniform sampler2D uPaving; uniform sampler2D uMask; uniform sampler2D uPhoto; uniform float uPhotoMix;',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        vec3 kind = texture2D(uMask, vMapUv).rgb;
        float bare = clamp(1.0 - kind.r - kind.g - kind.b, 0.0, 1.0);
        // The photograph gives real lawns, paddocks and bare ground their colour. Roads and paving
        // keep mostly their drawn colour, so markings stay crisp and photographed cars stay faint.
        vec4 real = texture2D(uPhoto, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, real.rgb, real.a * uPhotoMix * (0.62 * kind.b + 0.7 * bare + 0.22 * kind.r + 0.34 * kind.g));
        float away = smoothstep(30.0, 240.0, length(vViewPosition));
        // Each surface at two scales: its own grain up close, a looser repeat that still reads from the air.
        vec3 grass = mix(texture2D(uGrass, vGround / 5.5).rgb, texture2D(uGrass, vGround / 47.0).rgb, away);
        vec3 road = mix(texture2D(uAsphalt, vGround / 5.0).rgb, texture2D(uAsphalt, vGround / 59.0).rgb, away);
        vec3 pave = mix(texture2D(uPaving, vGround / 4.8).rgb, vec3(0.5), away * 0.6);
        float soil = mix(texture2D(uDetail, vGround / 4.0).r, texture2D(uDetail, vGround / 31.0).r, away);
        diffuseColor.rgb *= 2.0 * (grass * kind.b + road * kind.r + pave * kind.g + vec3(0.36 + soil * 0.28) * bare);
        // Uneven tone at the scale of a paddock, strongest on vegetation.
        float mid = texture2D(uDetail, vGround / 41.0).g;
        float broad = texture2D(uDetail, vGround / 370.0).b;
        float amount = 0.1 + 0.26 * kind.b;
        diffuseColor.rgb *= 1.0 + (mid - 0.5) * amount * 1.5 + (broad - 0.5) * amount;`,
      );
  };
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

/** Water: wind ripples that catch the light, a tone that varies with them, and sky at a low angle. */
export function waterMaterial(): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({
    color: 0x3f7896,
    specular: 0x566068,
    shininess: 55,
    transparent: true,
    opacity: 0.95,
  });
  m.onBeforeCompile = (shader) => {
    detail.value ??= detailTexture();
    shader.uniforms.uTime = shared.time;
    shader.uniforms.uDetail = detail;
    shader.uniforms.uSky = shared.sky;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWorld;
        uniform float uTime; uniform sampler2D uDetail; uniform vec3 uSky;
        // Two sets of ripples crossing at different sizes and speeds.
        float swell(vec2 p) {
          return texture2D(uDetail, p / 11.0 + vec2(uTime * 0.021, uTime * 0.013)).g * 0.6
            + texture2D(uDetail, p / 3.7 - vec2(uTime * 0.034, -uTime * 0.027)).g * 0.4;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float calm = 1.0 / (1.0 + length(vViewPosition) * 0.0018);
        float wave = swell(vWorld.xz);
        diffuseColor.rgb *= 1.0 + (wave - 0.5) * 0.5 * calm;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        vec2 slope = vec2(swell(vWorld.xz + vec2(0.3, 0.0)) - swell(vWorld.xz - vec2(0.3, 0.0)), swell(vWorld.xz + vec2(0.0, 0.3)) - swell(vWorld.xz - vec2(0.0, 0.3)));
        // Ripples fade with distance so the far lake is calm, not noisy.
        vec3 normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x * 5.0 * calm, 1.0, -slope.y * 5.0 * calm)), 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        float graze = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 4.0);
        totalEmissiveRadiance += uSky * graze * 0.32;`,
      );
  };
  return m;
}
