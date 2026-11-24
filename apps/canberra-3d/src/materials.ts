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

/** Walls draw their own windows from position along and up the wall, lit at night. */
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
        float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));
        float style = floor(vWall.z + 0.001);
        float seed = fract(vWall.z);
        vec3 lit = vec3(0.0);
        if (style > 0.5 && vWall.y > 0.0) {
          // Bay and storey sizes per style: house, grid, curtain glass, civic.
          vec2 size = style < 1.5 ? vec2(3.4, 2.9) : style < 2.5 ? vec2(2.6 + seed, 3.2) : style < 3.5 ? vec2(1.8, 3.6) : vec2(3.2, 4.0);
          vec2 cell = vec2(vWall.x, vWall.y) / size;
          vec2 id = floor(cell);
          vec2 f = fract(cell);
          vec2 lo = style < 1.5 ? vec2(0.3, 0.32) : style < 2.5 ? vec2(0.18, 0.28) : style < 3.5 ? vec2(0.05, 0.08) : vec2(0.3, 0.2);
          vec2 hi = style < 1.5 ? vec2(0.7, 0.74) : style < 2.5 ? vec2(0.82, 0.78) : style < 3.5 ? vec2(0.95, 0.86) : vec2(0.7, 0.85);
          vec2 w = fwidth(cell);
          vec2 e = smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
          float win = e.x * e.y;
          // No window in the storey cut off by the roof line, and houses skip some bays.
          win *= step((id.y + 1.0) * size.y, vWall.w + 0.4);
          if (style < 1.5) win *= step(0.35, h21(id + seed * 31.0));
          // Far off, replace the pattern by its average so it does not shimmer.
          float cover = (hi.x - lo.x) * (hi.y - lo.y);
          float detail = 1.0 - smoothstep(0.55, 1.3, max(w.x, w.y));
          win = mix(cover * 0.8, win, detail);
          float r = h21(id + seed * 17.0);
          vec3 glass = mix(vec3(0.035, 0.06, 0.1), vec3(0.12, 0.22, 0.32), r);
          if (style > 2.5 && style < 3.5) glass = mix(vec3(0.05, 0.12, 0.17), vec3(0.16, 0.3, 0.36), r);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.92);
          float on = step(style < 1.5 ? 0.55 : 0.62, h21(id * 1.7 + seed * 91.0));
          lit = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.9, 1.0), step(0.8, r)) * win * on * uNight * 1.6;
        }
        // A pale coping along the top of flat-roofed walls.
        if (style > 1.5) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.25 + 0.03, smoothstep(vWall.w - 0.55, vWall.w - 0.35, vWall.y));
        `,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += lit;');
  };
  return m;
}

/** Still water with drifting ripples and a sun glint. */
export function waterMaterial(): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({
    color: 0x34647f,
    specular: 0x9fb4c0,
    shininess: 70,
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
        float fade = 1.0 / (1.0 + length(vViewPosition) * 0.0016);
        vec3 normal = normalize((viewMatrix * vec4(normalize(vec3(g.x * 0.09 * fade, 1.0, g.y * 0.09 * fade)), 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`,
      );
  };
  return m;
}
