// Procedural daily level: the date seeds the generator, and the solver rejects
// candidates until one is solvable (but not trivial). Stardust is then placed along
// the most forgiving solution so a perfect run is always possible.
import {
  WORLD_H,
  WORLD_W,
  hasMovingBodies,
  simulate,
  type BodyDef,
  type LevelDef,
  type PathPt,
  type Vec,
  type Wormhole,
} from './physics.ts';
import { solve } from './solver.ts';
import { hashString, mulberry32 } from './rng.ts';

const ADJ = ['Crimson', 'Silent', 'Hollow', 'Amber', 'Drifting', 'Frozen', 'Velvet', 'Shattered', 'Golden', 'Electric', 'Distant', 'Burning', 'Quiet', 'Wandering', 'Pale', 'Violet'];
const NOUN = ['Drift', 'Reach', 'Expanse', 'Passage', 'Corridor', 'Veil', 'Rift', 'Halo', 'Tide', 'Gate', 'Cradle', 'Spiral', 'Basin', 'Crossing', 'Shore', 'Abyss'];

export function dateKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function candidate(rng: () => number): LevelDef {
  const r = (a: number, b: number) => a + rng() * (b - a);
  const ri = (a: number, b: number) => Math.round(r(a, b));

  const launch = { x: ri(120, 260), y: ri(120, 780) };
  const target = { x: ri(1320, 1480), y: ri(120, 780), r: ri(32, 42) };
  const bodies: BodyDef[] = [];
  const wormholes: Wormhole[] = [];
  // Clearance radius used when placing things, so nothing overlaps.
  const reach: number[] = [];

  const isClear = (p: Vec, rad: number) =>
    dist(p, launch) > rad + 130 &&
    dist(p, target) > rad + target.r + 90 &&
    bodies.every((b, i) => b.orbit || dist(p, { x: b.x!, y: b.y! }) > rad + reach[i] + 50) &&
    wormholes.every((w) => dist(p, w.a) > rad + w.r + 40 && dist(p, w.b) > rad + w.r + 40);

  const count = 2 + Math.floor(rng() * 3);
  let hasHole = false;
  let hasRepulsor = false;
  for (let tries = 0; tries < 300 && bodies.length < count; tries++) {
    const roll = rng();
    const p = { x: ri(420, 1180), y: ri(110, 790) };
    let body: BodyDef;
    let clearance: number;
    if (roll < 0.12 && !hasHole) {
      body = { ...p, r: 16, gm: Math.round(r(2e7, 3.3e7)), kind: 'blackhole', hue: ri(0, 360) };
      clearance = 70;
    } else if (roll < 0.3 && !hasRepulsor) {
      const rad = ri(30, 48);
      body = { ...p, r: rad, gm: Math.round(r(7e6, 1.4e7)), kind: 'repulsor', hue: ri(160, 220) };
      clearance = rad;
    } else {
      const rad = ri(35, 105);
      body = { ...p, r: rad, hue: ri(0, 360), rings: rad > 65 && rng() < 0.4 };
      clearance = rad;
    }
    if (!isClear(p, clearance)) continue;
    if (body.kind === 'blackhole') hasHole = true;
    if (body.kind === 'repulsor') hasRepulsor = true;
    bodies.push(body);
    reach.push(clearance);
  }

  // Sometimes a moon around one of the bigger planets.
  const parentIdx = bodies.findIndex((b) => !b.kind && b.r >= 50);
  if (parentIdx >= 0 && rng() < 0.3) {
    const parent = bodies[parentIdx];
    const pc = { x: parent.x!, y: parent.y! };
    const moonR = ri(14, 24);
    const radius = ri(parent.r + 45, parent.r + 100);
    const fits =
      bodies.every((b, i) => i === parentIdx || Math.abs(dist(pc, { x: b.x!, y: b.y! }) - radius) > reach[i] + moonR + 25) &&
      dist(pc, launch) > radius + 90 &&
      dist(pc, target) > radius + 90;
    if (fits) {
      bodies.push({
        r: moonR,
        hue: ri(0, 360),
        orbit: { around: parentIdx, radius, period: (rng() < 0.5 ? -1 : 1) * Math.round(r(5, 10)), phase: Math.round(r(0, 6.28) * 100) / 100 },
      });
      reach.push(0);
    }
  }

  if (rng() < 0.25) {
    const a = { x: ri(300, 600), y: ri(120, 780) };
    const b = { x: ri(1000, 1300), y: ri(120, 780) };
    if (isClear(a, 28) && isClear(b, 28)) wormholes.push({ a, b, r: 28 });
  }

  const level: LevelDef = { name: '', hint: '', launch, target, bodies, wormholes: wormholes.length ? wormholes : undefined };

  if (rng() < 0.5) {
    // Mirror horizontally so the route doesn't always run left to right.
    const fx = (p: Vec) => {
      p.x = WORLD_W - p.x;
    };
    fx(level.launch);
    fx(level.target);
    level.bodies.forEach((b) => {
      if (b.x !== undefined) b.x = WORLD_W - b.x;
      if (b.orbit) b.orbit.period = -b.orbit.period;
      if (b.orbit) b.orbit.phase = Math.PI - b.orbit.phase;
    });
    level.wormholes?.forEach((w) => {
      fx(w.a);
      fx(w.b);
    });
  }
  return level;
}

function placeDust(level: LevelDef, path: PathPt[], count: number): Vec[] {
  const out: Vec[] = [];
  for (let f = 0.25; f < 0.9 && out.length < count; f += 0.05) {
    const p = path[Math.floor(path.length * f)];
    if (!p) continue;
    const onScreen = p.x > 40 && p.x < WORLD_W - 40 && p.y > 40 && p.y < WORLD_H - 40;
    const clearOfBodies = level.bodies.every((b) => b.orbit || dist(p, { x: b.x!, y: b.y! }) > b.r + 30);
    const spaced = out.every((q) => dist(p, q) > 180) && dist(p, level.launch) > 150;
    if (onScreen && clearOfBodies && spaced && dist(p, level.target) > level.target.r + 30) {
      out.push({ x: Math.round(p.x), y: Math.round(p.y) });
    }
  }
  return out;
}

export function generateDaily(key: string): LevelDef {
  const seed = hashString('orbit-daily:' + key);
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(seed + attempt * 7919);
    const level = candidate(rng);
    const moving = hasMovingBodies(level);
    const t0s = moving ? [0, 2, 4] : [0];
    const report = solve(level, { t0s, samples: moving ? 1200 : 2400, want: 30, maxTime: 16, seed: seed ^ attempt });
    const rate = report.hits / report.tried;
    if (report.solutions.length < 4 || rate > 0.05 || report.hitT0s.length < t0s.length) continue;
    const best = [...report.solutions].sort((a, b) => b.score - a.score)[0];
    if (best.score < 2) continue;

    const path: PathPt[] = [];
    simulate(level, best.vx, best.vy, best.t0, { path, maxTime: 16 });
    const dust = placeDust(level, path, rng() < 0.5 ? 3 : 2);
    if (dust.length) level.dust = dust;
    level.name = `${ADJ[Math.floor(rng() * ADJ.length)]} ${NOUN[Math.floor(rng() * NOUN.length)]}`;
    level.hint = `Daily challenge · ${key}`;
    return level;
  }
  // Practically unreachable, but never leave the player without a level.
  return {
    name: 'Quiet Passage',
    hint: `Daily challenge · ${key}`,
    launch: { x: 180, y: 600 },
    target: { x: 1420, y: 300, r: 40 },
    bodies: [{ x: 800, y: 500, r: 70, hue: 200 }],
  };
}
