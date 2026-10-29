export type Easing = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
} satisfies Record<string, Easing>;

interface Tween {
  start: number;
  duration: number;
  easing: Easing;
  update: (k: number) => void;
  resolve: () => void;
}

/** Minimal tween runner driven by the scene's render loop (no extra animation library). */
export class Tweens {
  private items = new Set<Tween>();

  get active(): boolean {
    return this.items.size > 0;
  }

  run(duration: number, update: (k: number) => void, easing: Easing = ease.inOutCubic, now = performance.now()): Promise<void> {
    return new Promise((resolve) => {
      if (duration <= 0) {
        update(1);
        resolve();
        return;
      }
      update(0);
      this.items.add({ start: now, duration, easing, update, resolve });
    });
  }

  tick(now: number): void {
    for (const t of [...this.items]) {
      const raw = Math.min(1, (now - t.start) / t.duration);
      t.update(t.easing(Math.max(0, raw)));
      if (raw >= 1) {
        this.items.delete(t);
        t.resolve();
      }
    }
  }

  /** Jump every running tween to its end state. */
  finishAll(): void {
    for (const t of [...this.items]) {
      t.update(1);
      this.items.delete(t);
      t.resolve();
    }
  }
}

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
