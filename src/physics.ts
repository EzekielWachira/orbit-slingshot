// Pure simulation code — no DOM. Shared by the game and scripts/verify-levels.ts.

export const WORLD_W = 1600;
export const WORLD_H = 900;
export const MAX_SPEED = 640;
export const MAX_DRAG = 190;
export const MIN_DRAG = 14;
export const PROBE_R = 6;
export const STEP = 1 / 240;
export const MAX_FLIGHT = 24;

const DENSITY = 3000;
const SOFTEN = 400;
const OUT_MARGIN = 700;

export type Vec = { x: number; y: number };

export interface Orbit {
  /** Index of the body this one circles (must appear earlier in the list). */
  around?: number;
  /** Fixed orbit centre, used when `around` is not set. */
  cx?: number;
  cy?: number;
  radius: number;
  /** Seconds per revolution; negative reverses direction. */
  period: number;
  phase: number;
}

export interface BodyDef {
  x?: number;
  y?: number;
  r: number;
  gm?: number;
  kind?: 'planet' | 'blackhole';
  hue: number;
  rings?: boolean;
  orbit?: Orbit;
}

export interface LevelDef {
  name: string;
  hint: string;
  launch: Vec;
  target: Vec & { r: number };
  bodies: BodyDef[];
}

export interface Probe {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type Outcome = 'flying' | 'crash' | 'target' | 'lost';

export function gmOf(b: BodyDef): number {
  return b.gm ?? b.r * b.r * DENSITY;
}

export function bodyPositions(level: LevelDef, t: number, out: Vec[] = []): Vec[] {
  const bodies = level.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const p = out[i] ?? (out[i] = { x: 0, y: 0 });
    if (b.orbit) {
      const o = b.orbit;
      const cx = o.around !== undefined ? out[o.around].x : o.cx!;
      const cy = o.around !== undefined ? out[o.around].y : o.cy!;
      const a = o.phase + (t / o.period) * Math.PI * 2;
      p.x = cx + Math.cos(a) * o.radius;
      p.y = cy + Math.sin(a) * o.radius;
    } else {
      p.x = b.x!;
      p.y = b.y!;
    }
  }
  out.length = bodies.length;
  return out;
}

export function launchVelocity(dragX: number, dragY: number): Vec {
  const len = Math.hypot(dragX, dragY);
  if (len < 1e-6) return { x: 0, y: 0 };
  const speed = (Math.min(len, MAX_DRAG) / MAX_DRAG) * MAX_SPEED;
  return { x: (-dragX / len) * speed, y: (-dragY / len) * speed };
}

/** Advances the probe by one fixed STEP. `pos` must hold body positions at the current time. */
export function stepProbe(level: LevelDef, p: Probe, pos: Vec[]): Outcome {
  let ax = 0;
  let ay = 0;
  const bodies = level.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = pos[i].x - p.x;
    const dy = pos[i].y - p.y;
    const d2 = dx * dx + dy * dy;
    const rr = b.r + PROBE_R;
    if (d2 < rr * rr) return 'crash';
    const inv = gmOf(b) / ((d2 + SOFTEN) * Math.sqrt(d2));
    ax += dx * inv;
    ay += dy * inv;
  }
  p.vx += ax * STEP;
  p.vy += ay * STEP;
  p.x += p.vx * STEP;
  p.y += p.vy * STEP;

  const tx = level.target.x - p.x;
  const ty = level.target.y - p.y;
  if (tx * tx + ty * ty < level.target.r * level.target.r) return 'target';

  if (p.x < -OUT_MARGIN || p.x > WORLD_W + OUT_MARGIN || p.y < -OUT_MARGIN || p.y > WORLD_H + OUT_MARGIN) {
    return 'lost';
  }
  return 'flying';
}

/** Runs a whole flight from launch time t0. Used for the aim preview and the level solver. */
export function simulate(
  level: LevelDef,
  vx: number,
  vy: number,
  t0: number,
  maxTime = MAX_FLIGHT,
  path?: Vec[],
  pathEvery = 1,
): Outcome {
  const p: Probe = { x: level.launch.x, y: level.launch.y, vx, vy };
  const pos: Vec[] = [];
  const steps = Math.round(maxTime / STEP);
  for (let i = 0; i < steps; i++) {
    bodyPositions(level, t0 + i * STEP, pos);
    const out = stepProbe(level, p, pos);
    if (path && i % pathEvery === 0) path.push({ x: p.x, y: p.y });
    if (out !== 'flying') return out;
  }
  return 'lost';
}

export function starsFor(shots: number): number {
  if (shots <= 1) return 3;
  if (shots <= 3) return 2;
  return 1;
}
