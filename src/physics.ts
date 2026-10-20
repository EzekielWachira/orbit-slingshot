// Pure simulation code — no DOM. Shared by the game, the solver worker and scripts/verify-levels.ts.

export const WORLD_W = 1600;
export const WORLD_H = 900;
export const MAX_SPEED = 640;
export const MAX_DRAG = 190;
export const MIN_DRAG = 14;
export const PROBE_R = 6;
export const DUST_R = 16;
export const STEP = 1 / 240;
export const MAX_FLIGHT = 24;

const DENSITY = 3000;
const SOFTEN = 400;
const OUT_MARGIN = 700;

export type Vec = { x: number; y: number };
/** A path point; `brk` marks the first point after a wormhole jump. */
export type PathPt = Vec & { brk?: boolean };

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

export type BodyKind = 'planet' | 'blackhole' | 'repulsor';

export interface BodyDef {
  x?: number;
  y?: number;
  r: number;
  /** Gravitational strength. Defaults from radius; repulsors always push. */
  gm?: number;
  kind?: BodyKind;
  hue: number;
  rings?: boolean;
  orbit?: Orbit;
}

export interface Wormhole {
  a: Vec;
  b: Vec;
  r: number;
}

export interface LevelDef {
  name: string;
  hint: string;
  launch: Vec;
  target: Vec & { r: number };
  bodies: BodyDef[];
  wormholes?: Wormhole[];
  dust?: Vec[];
}

export interface Probe {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type Outcome = 'flying' | 'warp' | 'crash' | 'target' | 'lost';

export function gmOf(b: BodyDef): number {
  const g = b.gm ?? b.r * b.r * DENSITY;
  return b.kind === 'repulsor' ? -Math.abs(g) : g;
}

export function hasMovingBodies(level: LevelDef): boolean {
  return level.bodies.some((b) => b.orbit);
}

/** Time after which every moving body is back where it started, or null if there's no short cycle. */
export function systemPeriod(level: LevelDef): number | null {
  const halves: number[] = [];
  for (const b of level.bodies) {
    if (!b.orbit) continue;
    const h = Math.abs(b.orbit.period) * 2;
    if (Math.abs(h - Math.round(h)) > 1e-6) return null;
    halves.push(Math.round(h));
  }
  if (!halves.length) return null;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lcm = halves.reduce((a, b) => (a * b) / gcd(a, b));
  return lcm / 2 <= 120 ? lcm / 2 : null;
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

/** Inverse of launchVelocity: the drag vector that produces velocity (vx, vy). */
export function dragFor(vx: number, vy: number): Vec {
  const k = MAX_DRAG / MAX_SPEED;
  return { x: -vx * k, y: -vy * k };
}

function tryWarp(p: Probe, from: Vec, to: Vec, r: number): boolean {
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  if (dx * dx + dy * dy >= r * r) return false;
  const sp = Math.hypot(p.vx, p.vy) || 1;
  p.x = to.x + (p.vx / sp) * (r + 4);
  p.y = to.y + (p.vy / sp) * (r + 4);
  return true;
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

  const whs = level.wormholes;
  if (whs) {
    for (const w of whs) {
      if (tryWarp(p, w.a, w.b, w.r) || tryWarp(p, w.b, w.a, w.r)) return 'warp';
    }
  }

  const tx = level.target.x - p.x;
  const ty = level.target.y - p.y;
  if (tx * tx + ty * ty < level.target.r * level.target.r) return 'target';

  if (p.x < -OUT_MARGIN || p.x > WORLD_W + OUT_MARGIN || p.y < -OUT_MARGIN || p.y > WORLD_H + OUT_MARGIN) {
    return 'lost';
  }
  return 'flying';
}

/** Index of an uncollected stardust the probe is touching, or -1. */
export function dustHit(level: LevelDef, p: Vec, got: Uint8Array): number {
  const d = level.dust;
  if (!d) return -1;
  const rr = DUST_R + PROBE_R;
  for (let i = 0; i < d.length; i++) {
    if (got[i]) continue;
    const dx = d[i].x - p.x;
    const dy = d[i].y - p.y;
    if (dx * dx + dy * dy < rr * rr) return i;
  }
  return -1;
}

export interface SimOptions {
  maxTime?: number;
  path?: PathPt[];
  pathEvery?: number;
}

export interface SimResult {
  outcome: Outcome;
  dust: number;
  time: number;
}

/** Runs a whole flight from launch time t0. Used for the aim preview, hints and the solver. */
export function simulate(level: LevelDef, vx: number, vy: number, t0: number, opts: SimOptions = {}): SimResult {
  const maxTime = opts.maxTime ?? MAX_FLIGHT;
  const every = opts.pathEvery ?? 1;
  const path = opts.path;
  const p: Probe = { x: level.launch.x, y: level.launch.y, vx, vy };
  const pos: Vec[] = [];
  const got = new Uint8Array(level.dust?.length ?? 0);
  let dust = 0;
  const steps = Math.round(maxTime / STEP);
  for (let i = 0; i < steps; i++) {
    bodyPositions(level, t0 + i * STEP, pos);
    const out = stepProbe(level, p, pos);
    if (got.length) {
      const k = dustHit(level, p, got);
      if (k >= 0) {
        got[k] = 1;
        dust++;
      }
    }
    if (path) {
      if (out === 'warp') path.push({ x: p.x, y: p.y, brk: true });
      else if (i % every === 0) path.push({ x: p.x, y: p.y });
    }
    if (out !== 'flying' && out !== 'warp') return { outcome: out, dust, time: i * STEP };
  }
  return { outcome: 'lost', dust, time: maxTime };
}

export function starsFor(shots: number, missedDust = false, hinted = false): number {
  let s = shots <= 1 ? 3 : shots <= 3 ? 2 : 1;
  if (missedDust) s--;
  if (hinted) s = Math.min(s, 2);
  return Math.max(1, s);
}
