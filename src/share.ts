// Levels travel inside the URL hash, so sharing needs no server.
import { WORLD_H, WORLD_W, type BodyDef, type BodyKind, type LevelDef, type Vec } from './physics.ts';

const KINDS: BodyKind[] = ['planet', 'blackhole', 'repulsor'];
const LIMITS = { bodies: 12, wormholes: 4, dust: 8 };

function toB64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const r0 = (n: number) => Math.round(n);

export function encodeLevel(l: LevelDef): string {
  const data = {
    n: l.name,
    l: [r0(l.launch.x), r0(l.launch.y)],
    t: [r0(l.target.x), r0(l.target.y), r0(l.target.r)],
    b: l.bodies.map((b) => [
      r0(b.x ?? 0),
      r0(b.y ?? 0),
      r0(b.r),
      KINDS.indexOf(b.kind ?? 'planet'),
      r0(b.hue),
      b.rings ? 1 : 0,
      b.gm ? r0(b.gm) : 0,
      b.orbit ? [b.orbit.around ?? -1, r0(b.orbit.cx ?? 0), r0(b.orbit.cy ?? 0), r0(b.orbit.radius), r0(b.orbit.period * 100), r0(b.orbit.phase * 1000)] : 0,
    ]),
    w: (l.wormholes ?? []).map((w) => [r0(w.a.x), r0(w.a.y), r0(w.b.x), r0(w.b.y), r0(w.r)]),
    d: (l.dust ?? []).map((d) => [r0(d.x), r0(d.y)]),
  };
  return toB64(JSON.stringify(data));
}

const num = (v: unknown, min: number, max: number, fallback = min): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};
const px = (v: unknown) => num(v, -200, WORLD_W + 200);
const py = (v: unknown) => num(v, -200, WORLD_H + 200);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Parses and sanitises a shared level. Returns null if it is unusable. */
export function decodeLevel(s: string): LevelDef | null {
  try {
    const d = JSON.parse(fromB64(s));
    const l = arr(d.l);
    const t = arr(d.t);
    const bodies: BodyDef[] = arr(d.b)
      .slice(0, LIMITS.bodies)
      .map((raw, i) => {
        const b = arr(raw);
        const body: BodyDef = { x: px(b[0]), y: py(b[1]), r: num(b[2], 8, 140, 40), hue: num(b[4], 0, 360, 200) };
        const kind = KINDS[num(b[3], 0, 2, 0) | 0];
        if (kind !== 'planet') body.kind = kind;
        if (b[5]) body.rings = true;
        if (b[6]) body.gm = num(b[6], 0, 6e7);
        const o = arr(b[7]);
        if (o.length === 6) {
          const around = num(o[0], -1, i - 1, -1) | 0;
          body.orbit = {
            radius: num(o[3], 20, 600, 150),
            period: num(o[4], -3000, 3000, 600) / 100 || 6,
            phase: num(o[5], -10000, 10000, 0) / 1000,
          };
          if (around >= 0) body.orbit.around = around;
          else {
            body.orbit.cx = px(o[1]);
            body.orbit.cy = py(o[2]);
          }
        }
        return body;
      });
    // A moon must circle a body that is itself fixed in place.
    for (const b of bodies) {
      if (b.orbit?.around !== undefined && bodies[b.orbit.around]?.orbit) delete b.orbit;
    }
    const vec = (a: unknown[], i: number): Vec => ({ x: px(a[i]), y: py(a[i + 1]) });
    const level: LevelDef = {
      name: typeof d.n === 'string' ? d.n.slice(0, 40) : 'Custom level',
      hint: 'A custom level.',
      launch: vec(l, 0),
      target: { ...vec(t, 0), r: num(t[2], 16, 80, 36) },
      bodies,
      wormholes: arr(d.w)
        .slice(0, LIMITS.wormholes)
        .map((raw) => {
          const w = arr(raw);
          return { a: vec(w, 0), b: vec(w, 2), r: num(w[4], 14, 60, 28) };
        }),
      dust: arr(d.d)
        .slice(0, LIMITS.dust)
        .map((raw) => vec(arr(raw), 0)),
    };
    if (!level.wormholes!.length) delete level.wormholes;
    if (!level.dust!.length) delete level.dust;
    return level;
  } catch {
    return null;
  }
}

export function cloneLevel(l: LevelDef): LevelDef {
  return structuredClone(l);
}

// ---------------------------------------------------------------- replays

/** Which level a replay is for: a campaign index, a daily date, or an encoded custom level. */
export type LevelRef = { c: number } | { d: string } | { e: string };

export interface ReplayData {
  ref: LevelRef;
  vx: number;
  vy: number;
  /** Launch time — moving bodies make this part of the shot. */
  t0: number;
  shots: number;
}

export function encodeReplay(r: ReplayData): string {
  // Full float precision: the physics is deterministic, so the exact launch reproduces the exact flight.
  return toB64(JSON.stringify({ r: r.ref, v: [r.vx, r.vy, r.t0], s: r.shots }));
}

export function decodeReplay(s: string): ReplayData | null {
  try {
    const d = JSON.parse(fromB64(s));
    const v = arr(d.v);
    if (v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const [vx, vy, t0] = v as number[];
    if (Math.hypot(vx, vy) > 1000 || Math.abs(t0) > 1e6) return null;
    let ref: LevelRef;
    const r = d.r ?? {};
    if (typeof r.c === 'number' && Number.isInteger(r.c) && r.c >= 0) ref = { c: r.c };
    else if (typeof r.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.d)) ref = { d: r.d };
    else if (typeof r.e === 'string' && r.e.length < 4000) ref = { e: r.e };
    else return null;
    return { ref, vx, vy, t0, shots: num(d.s, 1, 999, 1) | 0 };
  } catch {
    return null;
  }
}

/** Round-trips a level through the share encoding, so play, hints and replays all see identical numbers. */
export function canonical(l: LevelDef): LevelDef {
  const c = decodeLevel(encodeLevel(l))!;
  c.hint = l.hint;
  return c;
}
