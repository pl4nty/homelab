// Renders the scene to a float target, then one full-screen pass does the depth-of-field blur
// that makes the city read as a miniature, plus tone mapping and grading.
import * as THREE from 'three';

export class Post {
  private target: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** 0 turns the miniature blur off. */
  blur = 1;
  /** Distance from the camera that stays sharp, in metres. */
  focus = 1000;
  exposure = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: depth,
      samples: 4,
    });
    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: depth },
        texel: { value: new THREE.Vector2() },
        near: { value: 1 },
        far: { value: 1 },
        focus: { value: 1000 },
        blur: { value: 1 },
        exposure: { value: 1 },
        maxRadius: { value: 8 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tColor; uniform sampler2D tDepth;
        uniform vec2 texel; uniform float near; uniform float far; uniform float focus; uniform float blur; uniform float exposure; uniform float maxRadius;
        varying vec2 vUv;

        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          // Depth buffer value to metres in front of the camera.
          return (near * far) / (far - d * (far - near));
        }
        // Circle of confusion, 0 to 1: sharp in a band round the focus, then growing with the
        // difference in 1/distance, as a real lens does.
        float coc(float z) {
          float c = abs(1.0 - focus / z);
          return smoothstep(0.1, 0.75, c) * blur;
        }
        vec3 aces(vec3 x) {
          return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
        }
        void main() {
          float z = viewZ(vUv);
          float c = coc(z);
          vec3 col = texture2D(tColor, vUv).rgb;
          if (c > 0.02) {
            float radius = c * maxRadius;
            vec3 sum = col; float total = 1.0;
            // Golden-angle spiral: even coverage of the disc from few taps.
            for (int i = 1; i <= 28; i++) {
              float fi = float(i);
              float r = sqrt(fi / 28.0) * radius;
              float a = fi * 2.39996323;
              vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
              float sc = coc(viewZ(uv));
              // A sharp neighbour must not smear into the blur.
              float w = max(sc, 0.15);
              sum += texture2D(tColor, uv).rgb * w; total += w;
            }
            col = sum / total;
          }
          col = aces(col * exposure);
          // A little more saturation and contrast, as in a painted model.
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, 1.08);
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
          vec2 q = vUv - 0.5;
          col *= 1.0 - dot(q, q) * 0.32;
          col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setSize(w: number, h: number) {
    this.target.setSize(w, h);
    this.quad.material.uniforms.texel.value.set(1 / w, 1 / h);
    // The blur covers the same share of the picture at any resolution.
    this.quad.material.uniforms.maxRadius.value = h / 110;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const u = this.quad.material.uniforms;
    u.near.value = camera.near;
    u.far.value = camera.far;
    u.focus.value = this.focus;
    u.blur.value = this.blur;
    u.exposure.value = this.exposure;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
