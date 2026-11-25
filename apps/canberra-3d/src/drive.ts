// Street level: a car to drive and a free-flying camera. Both ride the same streamed world as the
// overhead view; the car follows the ground, water and bridge decks and stops at buildings.
import * as THREE from 'three';
import type { Cars } from './cars.ts';

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
  /** Fly only: held for a burst of speed, and the wheel's speed setting (1 is normal). */
  boost: boolean;
  gear: number;
  /** Pointer drag since the last frame, radians. */
  lookX: number;
  lookY: number;
  dragging: boolean;
}

const turn = (from: number, to: number, k: number) =>
  from + (((((to - from) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * k;

export class Car {
  readonly group: THREE.Group;
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

  constructor(kit: Cars) {
    // A hatchback from the same kit as the traffic, in a colour nothing else on the road has.
    const body = new THREE.InstancedMesh(kit.styles[1], kit.material, 1);
    body.setMatrixAt(0, new THREE.Matrix4());
    body.setColorAt(0, new THREE.Color(0xf08a24));
    body.castShadow = true;
    body.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(body);
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
    // Faster the higher it is, so a street and the whole city are both a comfortable flight; the
    // wheel sets the pace and Shift quadruples it.
    const pace = THREE.MathUtils.clamp((this.y - ground) * 1.3, 25, 700) * c.gear * (c.boost ? 4 : 1);
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
