import { MAX_SPEED, simulate, type LevelDef } from './physics.ts';
import { mulberry32 } from './rng.ts';

export interface Solution {
  vx: number;
  vy: number;
  t0: number;
  /** How many of 6 nearby aims also hit (0–6): higher is easier to reproduce. */
  score: number;
  dust: number;
}

export interface SolveOptions {
  t0s: number[];
  /** Random shots tried per launch time. */
  samples: number;
  /** Stop collecting after this many hits. */
  want?: number;
  /** Stop sampling as soon as `want` hits are found (fast hints) instead of measuring the hit rate. */
  stopEarly?: boolean;
  maxTime?: number;
  seed?: number;
}

export interface SolveReport {
  solutions: Solution[];
  hits: number;
  tried: number;
  hitT0s: number[];
}

const NEIGHBOURS = [
  [0.012, 0],
  [-0.012, 0],
  [0.024, 0],
  [-0.024, 0],
  [0, 0.025],
  [0, -0.025],
];

export function solve(level: LevelDef, o: SolveOptions): SolveReport {
  const rng = mulberry32(o.seed ?? 12345);
  const want = o.want ?? 24;
  const maxTime = o.maxTime ?? 18;
  const raw: { ang: number; pow: number; t0: number; dust: number }[] = [];
  const hitT0s = new Set<number>();
  let hits = 0;
  let tried = 0;

  outer: for (const t0 of o.t0s) {
    for (let i = 0; i < o.samples; i++) {
      const ang = rng() * Math.PI * 2;
      const pow = 0.15 + rng() * 0.85;
      tried++;
      const r = simulate(level, Math.cos(ang) * pow * MAX_SPEED, Math.sin(ang) * pow * MAX_SPEED, t0, { maxTime });
      if (r.outcome !== 'target') continue;
      hits++;
      hitT0s.add(t0);
      if (raw.length < want) raw.push({ ang, pow, t0, dust: r.dust });
      if (o.stopEarly && raw.length >= want) break outer;
    }
  }

  const solutions = raw.map((s) => {
    let score = 0;
    for (const [da, dp] of NEIGHBOURS) {
      const a = s.ang + da;
      const p = Math.min(1, Math.max(0.05, s.pow + dp));
      if (simulate(level, Math.cos(a) * p * MAX_SPEED, Math.sin(a) * p * MAX_SPEED, s.t0, { maxTime }).outcome === 'target') score++;
    }
    return { vx: Math.cos(s.ang) * s.pow * MAX_SPEED, vy: Math.sin(s.ang) * s.pow * MAX_SPEED, t0: s.t0, score, dust: s.dust };
  });
  solutions.sort((a, b) => b.dust - a.dust || b.score - a.score);
  return { solutions, hits, tried, hitT0s: [...hitT0s] };
}
