// Movement of one agent between spots: stand up from a seat → walk the A* path → sit down. Pure (no THREE),
// so walking through walls/furniture can be unit-tested. Only backend state chooses the destination.
import { findPath, type NavGrid } from "./nav";
import type { Seat } from "./plan";

type XZ = [number, number];

/** A place an agent can be: seated at (x, z) facing `yaw`, or standing at its approach point (ax, az). */
export interface Spot {
  key: string;
  x: number;
  z: number;
  ax: number;
  az: number;
  yaw: number;
  sit: boolean;
}

export const seatSpot = (key: string, s: Seat, sit: boolean): Spot => ({ key: `${key}:${sit ? "sit" : "stand"}`, x: s.x, z: s.z, ax: s.ax, az: s.az, yaw: s.face, sit });

export type MotionState = "still" | "rising" | "walking" | "sitting";

export const WALK_SPEED = 1.3; // m/s
const TRANSITION = 0.45; // s to stand up / sit down

const angleTo = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export class ActorMotion {
  x: number;
  z: number;
  yaw: number;
  state: MotionState = "still";
  spot: Spot;
  path: XZ[] = [];
  private seg = 0;
  private tt = 0;
  private from: XZ = [0, 0];

  constructor(spot: Spot) {
    this.spot = spot;
    [this.x, this.z] = spot.sit ? [spot.x, spot.z] : [spot.ax, spot.az];
    this.yaw = spot.yaw;
  }

  get seated() {
    return this.state === "still" && this.spot.sit;
  }

  /** Head to a new spot (no-op if already there or on the way). */
  goTo(spot: Spot, grid: NavGrid) {
    if (spot.key === this.spot.key) return;
    const leavingSeat = this.state === "still" && this.spot.sit;
    const start: XZ = leavingSeat ? [this.spot.ax, this.spot.az] : [this.x, this.z];
    this.spot = spot;
    this.path = findPath(grid, start, [spot.ax, spot.az]) ?? [start, [spot.ax, spot.az]];
    this.seg = 1;
    if (leavingSeat) {
      this.state = "rising";
      this.tt = 0;
      this.from = [this.x, this.z];
    } else this.state = "walking";
  }

  /** Advance by dt seconds. */
  step(dt: number) {
    if (this.state === "rising") {
      this.tt += dt;
      const k = Math.min(1, this.tt / TRANSITION);
      const [tx, tz] = this.path[0];
      this.x = this.from[0] + (tx - this.from[0]) * k;
      this.z = this.from[1] + (tz - this.from[1]) * k;
      if (k >= 1) this.state = "walking";
      return;
    }
    if (this.state === "walking") {
      let left = WALK_SPEED * dt;
      while (left > 0 && this.seg < this.path.length) {
        const [tx, tz] = this.path[this.seg];
        const dx = tx - this.x, dz = tz - this.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-4) {
          const heading = Math.atan2(dx, dz);
          this.yaw += angleTo(this.yaw, heading) * Math.min(1, dt * 10);
        }
        if (d <= left) {
          this.x = tx;
          this.z = tz;
          left -= d;
          this.seg++;
        } else {
          this.x += (dx / d) * left;
          this.z += (dz / d) * left;
          left = 0;
        }
      }
      if (this.seg >= this.path.length) {
        if (this.spot.sit) {
          this.state = "sitting";
          this.tt = 0;
          this.from = [this.x, this.z];
        } else this.state = "still";
      }
      return;
    }
    if (this.state === "sitting") {
      this.tt += dt;
      const k = Math.min(1, this.tt / TRANSITION);
      this.x = this.from[0] + (this.spot.x - this.from[0]) * k;
      this.z = this.from[1] + (this.spot.z - this.from[1]) * k;
      this.yaw += angleTo(this.yaw, this.spot.yaw) * Math.min(1, dt * 8);
      if (k >= 1) {
        this.state = "still";
        this.yaw = this.spot.yaw;
      }
      return;
    }
    this.yaw += angleTo(this.yaw, this.spot.yaw) * Math.min(1, dt * 6);
  }
}
