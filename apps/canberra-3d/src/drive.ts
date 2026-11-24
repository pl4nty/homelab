// Street level: a car to drive and a free-flying camera. Both ride the same streamed world as the
// overhead view; the car follows the ground, water and bridge decks and stops at buildings.
import * as THREE from 'three';

export interface Ground {
  surfaceAt(x: number, z: number, y?: number): number;
  blockedAt(x: number, z: number): boolean;
}

/** One frame of input, from keys, touch stick and pointer drags. */
export interface Input {
  /** Forward and back, -1 to 1. */
  throttle: number;
  /** Right and left, -1 to 1. */
  steer: number;
  /** Fly only: up and down, and sideways. */
  lift: number;
  strafe: number;
  brake: boolean;
  /** Pointer drag since the last frame, radians. */
  lookX: number;
  lookY: number;
  dragging: boolean;
}

const lambert = (hex: number, emissive = 0) => new THREE.MeshLambertMaterial({ color: hex, emissive });

/** A small hatchback, nose along -z. */
function carModel(): { group: THREE.Group; wheels: THREE.Mesh[] } {
  const group = new THREE.Group();
  const paint = lambert(0xf08a24);
  const glass = lambert(0x1b232c);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(1.78, 0.52, 4.1), paint, 0, 0.62, 0);
  add(new THREE.BoxGeometry(1.7, 0.2, 3.9), lambert(0x2a2d31), 0, 0.3, 0);
  // Cabin: a box pinched at the top, set back from the nose.
  const cabin = new THREE.BoxGeometry(1.6, 0.56, 2.3);
  const p = cabin.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * 0.86);
      p.setZ(i, p.getZ(i) * 0.74 + 0.12);
    }
  }
  cabin.computeVertexNormals();
  add(cabin, glass, 0, 1.16, 0.3);
  add(new THREE.BoxGeometry(1.36, 0.06, 1.6), paint, 0, 1.46, 0.42);
  for (const x of [-0.62, 0.62]) {
    add(new THREE.BoxGeometry(0.36, 0.14, 0.06), lambert(0xfff4d6, 0xfff0c0), x, 0.7, -2.06);
    add(new THREE.BoxGeometry(0.4, 0.14, 0.06), lambert(0x7a1010, 0xc01818), x, 0.72, 2.06);
  }
  const wheels: THREE.Mesh[] = [];
  const tyre = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12).rotateZ(Math.PI / 2);
  for (const [x, z] of [
    [-0.86, -1.3],
    [0.86, -1.3],
    [-0.86, 1.3],
    [0.86, 1.3],
  ])
    wheels.push(add(tyre, lambert(0x17191c), x, 0.33, z));
  return { group, wheels };
}

const turn = (from: number, to: number, k: number) =>
  from + (((((to - from) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * k;

export class Car {
  readonly group: THREE.Group;
  private wheels: THREE.Mesh[];
  x = 0;
  y = 0;
  z = 0;
  /** Radians clockwise from north. */
  heading = 0;
  /** Metres a second; negative in reverse. */
  speed = 0;
  firstPerson = false;
  private steer = 0;
  private pitch = 0;
  private roll = 0;
  private camHeading = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private eye = new THREE.Vector3();
  private aimAt = new THREE.Vector3();

  constructor() {
    const m = carModel();
    this.group = m.group;
    this.wheels = m.wheels;
    this.group.rotation.order = 'YXZ';
    this.group.visible = false;
  }

  place(x: number, z: number, heading: number, g: Ground) {
    this.x = x;
    this.z = z;
    this.heading = this.camHeading = heading;
    this.speed = 0;
    this.lookYaw = this.lookPitch = 0;
    this.y = g.surfaceAt(x, z);
    this.group.visible = true;
  }

  update(dt: number, c: Input, g: Ground) {
    this.steer += (c.steer - this.steer) * Math.min(1, dt * 7);
    const top = 42;
    if (c.brake) this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 32 * dt);
    else if (c.throttle > 0) this.speed += (this.speed < 0 ? 24 : 11 * (1 - this.speed / top)) * c.throttle * dt;
    else if (c.throttle < 0) this.speed += (this.speed > 0.4 ? 24 : this.speed > -9 ? 6 : 0) * c.throttle * dt;
    else {
      const drag = (Math.abs(this.speed) * 0.3 + 1.4) * dt;
      this.speed = Math.abs(this.speed) <= drag ? 0 : this.speed - Math.sign(this.speed) * drag;
    }
    // Less lock at speed, so a held key is a lane change on the parkway and a U-turn in a car park.
    const lock = 0.62 / (1 + Math.abs(this.speed) * 0.1);
    this.heading += ((this.speed * Math.tan(this.steer * lock)) / 2.6) * dt;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const nx = this.x + sin * this.speed * dt;
    const nz = this.z - cos * this.speed * dt;
    const lead = this.speed >= 0 ? 2.2 : -2.2;
    if (g.blockedAt(nx + sin * lead, nz - cos * lead)) this.speed *= -0.3;
    else {
      this.x = nx;
      this.z = nz;
    }
    const ground = g.surfaceAt(this.x, this.z, this.y);
    this.y += (ground - this.y) * Math.min(1, dt * 14);
    const front = g.surfaceAt(this.x + sin * 1.4, this.z - cos * 1.4, this.y);
    const back = g.surfaceAt(this.x - sin * 1.4, this.z + cos * 1.4, this.y);
    const right = g.surfaceAt(this.x + cos * 0.8, this.z + sin * 0.8, this.y);
    const left = g.surfaceAt(this.x - cos * 0.8, this.z - sin * 0.8, this.y);
    const ease = Math.min(1, dt * 9);
    this.pitch += (THREE.MathUtils.clamp(Math.atan2(front - back, 2.8), -0.5, 0.5) - this.pitch) * ease;
    this.roll += (THREE.MathUtils.clamp(Math.atan2(right - left, 1.6), -0.5, 0.5) - this.roll) * ease;
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(this.pitch, -this.heading, this.roll);
    for (const w of this.wheels) w.rotation.x -= (this.speed * dt) / 0.33;
  }

  /** Puts the camera behind the car, or at the driver's eye. */
  aim(camera: THREE.PerspectiveCamera, dt: number, c: Input, g: Ground) {
    if (c.dragging) {
      this.lookYaw += c.lookX;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + c.lookY, -0.5, 0.7);
    } else {
      // Let go and the view swings back to the road ahead.
      this.lookYaw *= Math.max(0, 1 - dt * 2.5);
      this.lookPitch *= Math.max(0, 1 - dt * 2.5);
    }
    this.group.visible = !this.firstPerson;
    if (this.firstPerson) {
      // The driver sits on the right, as in Australia.
      this.group.updateMatrix();
      this.eye.set(0.36, 1.22, 0.1).applyMatrix4(this.group.matrix);
      camera.position.copy(this.eye);
      const yaw = this.heading + this.lookYaw;
      const tilt = this.pitch * 0.7 + this.lookPitch;
      this.aimAt.set(Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)).add(this.eye);
      camera.lookAt(this.aimAt);
      return;
    }
    this.camHeading = turn(this.camHeading, this.heading, Math.min(1, dt * 3.5));
    const a = this.camHeading + this.lookYaw;
    const backOff = 9 + Math.abs(this.speed) * 0.1;
    const cx = this.x - Math.sin(a) * backOff;
    const cz = this.z + Math.cos(a) * backOff;
    const cy = Math.max(this.y + 3.3 + this.lookPitch * 6, g.surfaceAt(cx, cz, this.y + 4) + 1.2);
    this.eye.set(cx, cy, cz);
    camera.position.lerp(this.eye, Math.min(1, dt * 10));
    this.aimAt.set(this.x + Math.sin(this.heading) * 3, this.y + 1.4, this.z - Math.cos(this.heading) * 3);
    camera.lookAt(this.aimAt);
  }
}

/** A camera that flies where it looks. */
export class Drone {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  private tilt = -0.15;
  private vel = new THREE.Vector3();
  private want = new THREE.Vector3();
  private aimAt = new THREE.Vector3();
  speed = 0;

  place(x: number, y: number, z: number, heading: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
    this.tilt = -0.15;
    this.vel.set(0, 0, 0);
  }

  update(dt: number, c: Input, g: Ground) {
    this.heading += c.steer * 1.2 * dt + c.lookX;
    this.tilt = THREE.MathUtils.clamp(this.tilt + c.lookY, -1.4, 1.2);
    const ground = g.surfaceAt(this.x, this.z);
    // Faster the higher it is, so both a street and the whole city are a comfortable flight.
    const pace = THREE.MathUtils.clamp((this.y - ground) * 0.9, 14, 280);
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const ct = Math.cos(this.tilt);
    this.want
      .set(sin * ct, Math.sin(this.tilt), -cos * ct)
      .multiplyScalar(c.throttle)
      .add(this.aimAt.set(cos, 0, sin).multiplyScalar(c.strafe))
      .add(this.aimAt.set(0, c.lift, 0))
      .multiplyScalar(pace);
    this.vel.lerp(this.want, Math.min(1, dt * 4));
    this.x += this.vel.x * dt;
    this.y += this.vel.y * dt;
    this.z += this.vel.z * dt;
    const floor = g.surfaceAt(this.x, this.z) + 2;
    if (this.y < floor) this.y = floor;
    this.speed = this.vel.length();
  }

  aim(camera: THREE.PerspectiveCamera) {
    camera.position.set(this.x, this.y, this.z);
    const ct = Math.cos(this.tilt);
    this.aimAt.set(
      this.x + Math.sin(this.heading) * ct,
      this.y + Math.sin(this.tilt),
      this.z - Math.cos(this.heading) * ct,
    );
    camera.lookAt(this.aimAt);
  }
}

/** A thumb stick for touch screens: drag from where the thumb lands. */
export class TouchStick {
  x = 0;
  y = 0;
  private id = -1;
  private ox = 0;
  private oy = 0;
  private knob: HTMLElement;

  constructor(el: HTMLElement) {
    this.knob = document.createElement('i');
    el.append(this.knob);
    el.addEventListener('pointerdown', (e) => {
      this.id = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.id) return;
      const r = 46;
      this.x = THREE.MathUtils.clamp((e.clientX - this.ox) / r, -1, 1);
      this.y = THREE.MathUtils.clamp((this.oy - e.clientY) / r, -1, 1);
      this.knob.style.transform = `translate(${this.x * r}px, ${-this.y * r}px)`;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.id) return;
      this.id = -1;
      this.x = this.y = 0;
      this.knob.style.transform = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
