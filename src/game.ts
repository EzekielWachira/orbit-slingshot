import {
  DUST_R,
  MAX_DRAG,
  MAX_FLIGHT,
  MAX_SPEED,
  MIN_DRAG,
  PROBE_R,
  STEP,
  WORLD_H,
  WORLD_W,
  bodyPositions,
  dragFor,
  dustHit,
  gmOf,
  hasMovingBodies,
  launchVelocity,
  simulate,
  systemPeriod,
  stepProbe,
  type BodyDef,
  type LevelDef,
  type Outcome,
  type PathPt,
  type Probe,
  type Vec,
  type Wormhole,
} from './physics.ts';
import { sfx } from './audio.ts';
import { music } from './music.ts';
import { mulberry32 } from './rng.ts';

type Phase = 'idle' | 'aiming' | 'flying' | 'resolving' | 'won';
type Mode = 'play' | 'edit' | 'attract' | 'replay';

export type Selection =
  | { type: 'launch' }
  | { type: 'target' }
  | { type: 'body'; index: number }
  | { type: 'worm'; index: number; end: 'a' | 'b' }
  | { type: 'dust'; index: number };

export interface Launch {
  vx: number;
  vy: number;
  t0: number;
}

export interface WinInfo {
  shots: number;
  dust: number;
  dustTotal: number;
  hinted: boolean;
  launch: Launch;
}

export interface Settings {
  assist: boolean;
  shake: boolean;
  grid: boolean;
  bestRoute: boolean;
  music: boolean;
}

/** glow: soft additive blob · spark: additive streak along its velocity · smoke: dark puff that swells as it fades */
type ParticleKind = 'glow' | 'spark' | 'smoke';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  hue: number;
  light: number;
  kind: ParticleKind;
  /** Velocity damping per second. */
  drag: number;
}

/** A scorch glow on a body's surface, stored relative to the body so it follows moving moons. */
interface Impact {
  body: number;
  ox: number;
  oy: number;
  age: number;
}

interface Wave {
  x: number;
  y: number;
  age: number;
  max: number;
  size: number;
  hue: number;
}

interface Hint extends Launch {
  path: PathPt[];
  /** Static levels replay the ghost on a loop; moving ones fly it at t0 (and every period after). */
  loop: boolean;
  period: number | null;
  start: number;
}

export interface GameHooks {
  onShot(shots: number): void;
  onMessage(text: string): void;
  onWin(info: WinInfo): void;
  onDust(got: number, total: number): void;
  onFlightChange(flying: boolean): void;
  onSelect(sel: Selection | null): void;
  onEdit(): void;
  /** A replay didn't reach the beacon (only possible if a level changed since it was recorded). */
  onReplayFail(): void;
}

const TRAIL_MAX = 700;
const GRID = 50;
const GRID_PAD = 150;
export const WORM_HUES = [275, 190, 330, 95];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class Game {
  active = false;
  settings: Settings = { assist: false, shake: true, grid: true, bestRoute: true, music: true };
  /** Fast-forward multiplier toggle for long flights. */
  ff = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hooks: GameHooks;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private fit = 1;
  private cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
  private bg = document.createElement('canvas');
  private bgSeed = 0;
  private vignette: CanvasGradient | null = null;
  private twinkles: { x: number; y: number; s: number; p: number; f: number }[] = [];

  private level!: LevelDef;
  private mode: Mode = 'play';
  private phase: Phase = 'idle';
  private clock = 0;
  private anim = 0;
  private acc = 0;
  private probe: Probe = { x: 0, y: 0, vx: 0, vy: 0 };
  private flightTime = 0;
  private stepCount = 0;
  private trail: PathPt[] = [];
  private ghosts: PathPt[][] = [];
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private impacts: Impact[] = [];
  /** Full-screen crash flash, 1 fading to 0. */
  private flash = 0;
  private pos: Vec[] = [];
  private preview: PathPt[] = [];
  private previewOutcome: Outcome = 'flying';
  private shots = 0;
  private dustGot = new Uint8Array(0);
  private dustCount = 0;
  private hint: Hint | null = null;
  private hinted = false;
  private bestPath: PathPt[] | null = null;
  private lastLaunch: Launch = { vx: 0, vy: 0, t0: 0 };
  private timeScale = 1;
  private shake = 0;
  private resolveTimer = 0;
  private beepTimer = 0;
  /** 1 on each proximity beep, fading to 0: flashes the beacon in time with the sound. */
  private targetPing = 0;
  private winTimer = 0;
  private winFired = false;
  private drag: { sx: number; sy: number; x: number; y: number; id: number } | null = null;
  private sel: Selection | null = null;
  private editDrag: { id: number; ox: number; oy: number } | null = null;
  /** Keyboard aim, in launch-direction radians (canvas coords) and 0–1 power. */
  private kbAim: { angle: number; power: number } | null = null;
  private lastAim: { angle: number; power: number } | null = null;
  private replayShot: (Launch & { lead: number }) | null = null;
  private gx: Float32Array;
  private gy: Float32Array;
  private gridCols = Math.ceil((WORLD_W + GRID_PAD * 2) / GRID) + 1;
  private gridRows = Math.ceil((WORLD_H + GRID_PAD * 2) / GRID) + 1;
  private last = 0;

  constructor(canvas: HTMLCanvasElement, hooks: GameHooks) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.ctx = canvas.getContext('2d')!;
    this.gx = new Float32Array(this.gridCols * this.gridRows);
    this.gy = new Float32Array(this.gridCols * this.gridRows);
    for (let i = 0; i < 140; i++) {
      this.twinkles.push({ x: Math.random(), y: Math.random(), s: rand(0.5, 1.7), p: rand(0, 6.28), f: rand(0.6, 2.2) });
    }

    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelPointer());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- public API

  loadLevel(level: LevelDef, opts: { seed: number; best?: Launch | null }) {
    this.mode = 'play';
    this.level = level;
    this.bgSeed = opts.seed;
    this.clock = 0;
    this.shots = 0;
    this.ghosts = [];
    this.particles = [];
    this.waves = [];
    this.impacts = [];
    this.flash = 0;
    this.hint = null;
    this.hinted = false;
    this.ff = false;
    this.kbAim = null;
    this.lastAim = null;
    this.replayShot = null;
    this.preview.length = 0;
    this.sel = null;
    this.cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
    this.timeScale = 1;
    this.bestPath = null;
    if (opts.best) {
      const path: PathPt[] = [];
      simulate(level, opts.best.vx, opts.best.vy, opts.best.t0, { path, pathEvery: 3 });
      this.bestPath = path;
    }
    this.resetProbe();
    this.renderBackground();
    this.hooks.onShot(0);
  }

  /** Title-screen mode: a probe circling a planet forever, relaunched when it falls. */
  startAttract(level: LevelDef) {
    this.loadLevel(level, { seed: 424242 });
    this.mode = 'attract';
    this.launchAttract();
  }

  startEditor(level: LevelDef) {
    this.loadLevel(level, { seed: 99 });
    this.mode = 'edit';
    this.active = true;
  }

  /** Replays a recorded launch: the probe winds up for `lead` seconds, then fires at exactly t0. */
  playReplay(level: LevelDef, shot: Launch, seed: number) {
    this.loadLevel(level, { seed });
    this.mode = 'replay';
    this.active = true;
    const lead = 1.6;
    this.replayShot = { ...shot, lead };
    this.clock = shot.t0 - lead;
  }

  /** Arrow-key aiming. Starts from the last shot (or straight at the beacon) for fine-tuning. */
  nudgeAim(dAngle: number, dPower: number): boolean {
    if (!this.active || this.mode !== 'play') return false;
    if (this.phase === 'idle') {
      const { launch: l, target: t } = this.level;
      this.kbAim = { ...(this.lastAim ?? { angle: Math.atan2(t.y - l.y, t.x - l.x), power: 0.5 }) };
      this.phase = 'aiming';
    } else if (this.phase !== 'aiming' || !this.kbAim) {
      return false;
    }
    this.kbAim.angle = (this.kbAim.angle + dAngle + Math.PI * 4) % (Math.PI * 2);
    this.kbAim.power = clamp(Math.round((this.kbAim.power + dPower) * 1000) / 1000, 0.08, 1);
    return true;
  }

  fireKeyboardAim(): boolean {
    if (this.phase !== 'aiming' || !this.kbAim) return false;
    const d = this.aimVec();
    this.kbAim = null;
    this.launch(d);
    return true;
  }

  cancelKeyboardAim(): boolean {
    if (this.phase !== 'aiming' || !this.kbAim) return false;
    this.kbAim = null;
    this.phase = 'idle';
    return true;
  }

  get isFlying() {
    return this.phase === 'flying';
  }

  get currentLevel() {
    return this.level;
  }

  get currentClock() {
    return this.clock;
  }

  recall() {
    if (this.phase === 'flying' && this.mode === 'play') this.resolve('lost', 'Probe recalled');
  }

  /** Shows a solver-found shot as a gold ghost. Using one caps the level at two stars. */
  showHint(l: Launch) {
    const loop = !hasMovingBodies(this.level);
    const t0 = loop ? this.clock : l.t0;
    const path: PathPt[] = [];
    simulate(this.level, l.vx, l.vy, t0, { path, pathEvery: 2 });
    this.hint = { vx: l.vx, vy: l.vy, t0, path, loop, period: systemPeriod(this.level), start: this.anim };
    this.hinted = true;
  }

  get hintUsed() {
    return this.hinted;
  }

  // ---------------------------------------------------------------- editor API

  get selection() {
    return this.sel;
  }

  select(sel: Selection | null) {
    this.sel = sel;
    this.hooks.onSelect(sel);
  }

  /** World position of the selected thing (for placing new items nearby). */
  selectionPos(): Vec | null {
    return this.sel ? this.posOf(this.sel) : null;
  }

  private posOf(sel: Selection): Vec {
    const l = this.level;
    switch (sel.type) {
      case 'launch':
        return l.launch;
      case 'target':
        return l.target;
      case 'body':
        return this.pos[sel.index] ?? { x: l.bodies[sel.index].x ?? 0, y: l.bodies[sel.index].y ?? 0 };
      case 'worm':
        return l.wormholes![sel.index][sel.end];
      case 'dust':
        return l.dust![sel.index];
    }
  }

  /** Modes where a real flight is happening (as opposed to the title backdrop or the editor). */
  private get live() {
    return this.mode === 'play' || this.mode === 'replay';
  }

  // ---------------------------------------------------------------- input

  private screenToWorld(sx: number, sy: number): Vec {
    const S = this.fit * this.cam.zoom;
    return { x: (sx - this.cw / 2) / S + this.cam.x, y: (sy - this.ch / 2) / S + this.cam.y };
  }

  private dragScale() {
    const screenMax = Math.min(230, Math.max(110, MAX_DRAG * this.fit * 1.2));
    return MAX_DRAG / screenMax;
  }

  /** The current aim as a drag vector in world units, from the pointer or the keyboard. */
  private aimVec(): Vec {
    if (this.kbAim) {
      const len = this.kbAim.power * MAX_DRAG;
      return { x: -Math.cos(this.kbAim.angle) * len, y: -Math.sin(this.kbAim.angle) * len };
    }
    if (!this.drag) return { x: 0, y: 0 };
    const k = this.dragScale();
    let x = (this.drag.x - this.drag.sx) * k;
    let y = (this.drag.y - this.drag.sy) * k;
    const len = Math.hypot(x, y);
    if (len > MAX_DRAG) {
      x *= MAX_DRAG / len;
      y *= MAX_DRAG / len;
    }
    return { x, y };
  }

  private onDown(e: PointerEvent) {
    sfx.unlock();
    if (!this.active) return;
    if (this.mode === 'edit') return this.editDown(e);
    if (this.mode !== 'play') return;
    // A pointer drag takes over from a keyboard aim in progress.
    if (this.phase === 'aiming' && this.kbAim) this.kbAim = null;
    else if (this.phase !== 'idle') return;
    this.drag = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId };
    this.phase = 'aiming';
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (this.mode === 'edit') return this.editMove(e);
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  }

  private onUp(e: PointerEvent) {
    if (this.mode === 'edit') {
      if (this.editDrag?.id === e.pointerId) {
        this.editDrag = null;
        this.hooks.onEdit();
      }
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const d = this.aimVec();
    this.drag = null;
    if (Math.hypot(d.x, d.y) >= MIN_DRAG && this.phase === 'aiming') this.launch(d);
    else this.phase = 'idle';
  }

  private cancelPointer() {
    this.drag = null;
    this.editDrag = null;
    if (this.phase === 'aiming' && !this.kbAim) this.phase = 'idle';
  }

  private hitTest(w: Vec): Selection | null {
    const l = this.level;
    const near = (p: Vec, r: number) => Math.hypot(p.x - w.x, p.y - w.y) < r;
    const dust = l.dust ?? [];
    for (let i = dust.length - 1; i >= 0; i--) if (near(dust[i], DUST_R + 10)) return { type: 'dust', index: i };
    const whs = l.wormholes ?? [];
    for (let i = whs.length - 1; i >= 0; i--) {
      if (near(whs[i].a, whs[i].r + 8)) return { type: 'worm', index: i, end: 'a' };
      if (near(whs[i].b, whs[i].r + 8)) return { type: 'worm', index: i, end: 'b' };
    }
    if (near(l.launch, 28)) return { type: 'launch' };
    if (near(l.target, l.target.r + 8)) return { type: 'target' };
    for (let i = l.bodies.length - 1; i >= 0; i--) {
      const b = l.bodies[i];
      const r = b.kind === 'blackhole' ? b.r * 2.4 : Math.max(b.r, 14);
      if (near(this.pos[i], r + 8)) return { type: 'body', index: i };
    }
    return null;
  }

  private editDown(e: PointerEvent) {
    const w = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.hitTest(w);
    this.select(hit);
    if (!hit) return;
    const p = this.posOf(hit);
    this.editDrag = { id: e.pointerId, ox: w.x - p.x, oy: w.y - p.y };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private editMove(e: PointerEvent) {
    const w = this.screenToWorld(e.clientX, e.clientY);
    this.canvas.style.cursor = this.editDrag ? 'grabbing' : this.hitTest(w) ? 'grab' : 'default';
    if (!this.editDrag || e.pointerId !== this.editDrag.id || !this.sel) return;
    const x = clamp(w.x - this.editDrag.ox, 20, WORLD_W - 20);
    const y = clamp(w.y - this.editDrag.oy, 20, WORLD_H - 20);
    const l = this.level;
    const s = this.sel;
    if (s.type === 'body' && l.bodies[s.index].orbit) {
      // Dragging a moon sets its orbit radius and starting angle.
      const o = l.bodies[s.index].orbit!;
      const c = o.around !== undefined ? this.pos[o.around] : { x: o.cx!, y: o.cy! };
      o.radius = Math.round(clamp(Math.hypot(x - c.x, y - c.y), 40, 450));
      o.phase = Math.round(Math.atan2(y - c.y, x - c.x) * 1000) / 1000;
      return;
    }
    const p = this.posOf(s);
    if (s.type === 'body') {
      const b = l.bodies[s.index];
      b.x = Math.round(x);
      b.y = Math.round(y);
    } else {
      p.x = Math.round(x);
      p.y = Math.round(y);
    }
  }

  private onWheel(e: WheelEvent) {
    if (this.mode !== 'edit' || !this.sel) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    const l = this.level;
    const s = this.sel;
    if (s.type === 'body') {
      const b = l.bodies[s.index];
      if (b.kind === 'blackhole') b.gm = clamp((b.gm ?? 2.5e7) + delta * 1e6, 8e6, 5e7);
      else b.r = clamp(b.r + delta * 3, 12, 130);
    } else if (s.type === 'target') l.target.r = clamp(l.target.r + delta * 2, 20, 70);
    else if (s.type === 'worm') l.wormholes![s.index].r = clamp(l.wormholes![s.index].r + delta * 2, 18, 50);
    this.hooks.onSelect(s);
    this.hooks.onEdit();
  }

  // ---------------------------------------------------------------- gameplay

  private resetProbe() {
    const { x, y } = this.level.launch;
    this.probe = { x, y, vx: 0, vy: 0 };
    this.trail = [];
    this.phase = 'idle';
    this.dustGot = new Uint8Array(this.level.dust?.length ?? 0);
    this.dustCount = 0;
    this.hooks.onDust(0, this.dustGot.length);
    this.hooks.onFlightChange(false);
  }

  private beginFlight(vx: number, vy: number) {
    const { x, y } = this.level.launch;
    this.probe = { x, y, vx, vy };
    this.phase = 'flying';
    this.acc = 0;
    this.flightTime = 0;
    this.stepCount = 0;
    this.trail = [{ x, y }];
    this.lastLaunch = { vx, vy, t0: this.clock };
    if (this.live) this.hooks.onFlightChange(true);
  }

  private launch(d: Vec) {
    const v = launchVelocity(d.x, d.y);
    this.lastAim = { angle: Math.atan2(v.y, v.x), power: Math.min(1, Math.hypot(d.x, d.y) / MAX_DRAG) };
    this.fire(v.x, v.y);
  }

  /** Launches with an exact velocity (replays must not round-trip through a drag vector). */
  private fire(vx: number, vy: number) {
    const power = Math.hypot(vx, vy) / MAX_SPEED;
    this.beginFlight(vx, vy);
    this.shots++;
    this.hooks.onShot(this.shots);
    sfx.launch(power);
    const ang = Math.atan2(-vy, -vx);
    for (let i = 0; i < 26; i++) {
      const a = ang + rand(-0.6, 0.6);
      const s = rand(60, 260) * (0.5 + power);
      this.spawn(this.probe.x, this.probe.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.7), rand(1, 2.6), rand(180, 210), 75);
    }
    this.waves.push({ x: this.probe.x, y: this.probe.y, age: 0, max: 0.5, size: 50, hue: 195 });
  }

  private launchAttract() {
    const b = this.level.bodies[0];
    const r = Math.hypot(this.level.launch.x - b.x!, this.level.launch.y - b.y!);
    const v = Math.sqrt(gmOf(b) / r) * rand(0.97, 1.05);
    this.beginFlight(v, 0);
  }

  private onWarp(from: Vec, to: Vec, hue: number) {
    for (const p of [from, to]) {
      this.waves.push({ x: p.x, y: p.y, age: 0, max: 0.5, size: 70, hue });
      for (let i = 0; i < 24; i++) {
        const a = rand(0, Math.PI * 2);
        const s = rand(40, 200);
        this.spawn(p.x, p.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.7), rand(1, 2.4), hue, 72);
      }
    }
    if (this.live) sfx.warp();
  }

  private collectDust(i: number) {
    const d = this.level.dust![i];
    this.dustGot[i] = 1;
    this.dustCount++;
    this.hooks.onDust(this.dustCount, this.dustGot.length);
    sfx.dust(this.dustCount);
    this.waves.push({ x: d.x, y: d.y, age: 0, max: 0.45, size: 46, hue: 45 });
    for (let k = 0; k < 18; k++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(40, 180);
      this.spawn(d.x, d.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.8), rand(1, 2.2), rand(38, 55), 72);
    }
  }

  private resolve(out: Outcome, reason?: string) {
    this.hooks.onFlightChange(false);
    if (out === 'target') {
      this.phase = 'won';
      this.winTimer = 0;
      this.winFired = false;
      this.hint = null;
      const { x, y } = this.level.target;
      for (let i = 0; i < 160; i++) {
        const a = rand(0, Math.PI * 2);
        const s = rand(40, 460);
        const hue = Math.random() < 0.75 ? rand(150, 200) : rand(270, 310);
        this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.8, 2), rand(1.2, 3.6), hue, 70);
      }
      this.waves.push({ x, y, age: 0, max: 1.2, size: 260, hue: 170 });
      this.waves.push({ x, y, age: -0.15, max: 1.2, size: 160, hue: 290 });
      sfx.win();
      return;
    }

    if (this.trail.length > 4 && this.mode === 'play') {
      this.ghosts.push(this.trail.filter((p, i) => p.brk || i % 3 === 0));
      if (this.ghosts.length > 3) this.ghosts.shift();
    }
    this.phase = 'resolving';
    const quiet = !this.live;

    if (out === 'crash') {
      const hit = this.nearestBody();
      const hitHole = hit?.body.kind === 'blackhole';
      this.explode(this.probe.x, this.probe.y, hit);
      this.shake = !this.settings.shake ? 0 : hitHole ? 8 : 24;
      this.resolveTimer = 1.1;
      if (!quiet) {
        sfx.crash();
        this.hooks.onMessage(hitHole ? 'Swallowed by the black hole' : 'Crashed!');
      }
    } else {
      this.resolveTimer = 0.8;
      if (!quiet) {
        if (!reason) sfx.lost();
        this.hooks.onMessage(reason ?? 'Lost in deep space');
      }
    }
  }

  private nearestBody(): { body: BodyDef; index: number } | undefined {
    let best: { body: BodyDef; index: number } | undefined;
    let bestD = Infinity;
    this.level.bodies.forEach((b, i) => {
      const d = Math.hypot(this.pos[i].x - this.probe.x, this.pos[i].y - this.probe.y) - b.r;
      if (d < bestD) {
        bestD = d;
        best = { body: b, index: i };
      }
    });
    return best;
  }

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    hue: number,
    light: number,
    kind: ParticleKind = 'glow',
    drag = 1.8,
  ) {
    if (this.particles.length > 1400) return;
    this.particles.push({ x, y, vx, vy, life, max: life, size, hue, light, kind, drag });
  }

  private explode(x: number, y: number, hit?: { body: BodyDef; index: number }) {
    // A moment of hit-stop sells the impact; the time scale eases back on its own.
    this.timeScale = 0.25;
    const bp = hit ? this.pos[hit.index] : null;

    if (hit?.body.kind === 'blackhole') {
      // Spaghettified: debris spirals inward instead of blasting out.
      const hue = hit.body.hue;
      for (let i = 0; i < 70; i++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(30, 110);
        const px = bp!.x + Math.cos(a) * d;
        const py = bp!.y + Math.sin(a) * d;
        const swirl = d * 4;
        const vx = -Math.cos(a) * d * 2.6 - Math.sin(a) * swirl;
        const vy = -Math.sin(a) * d * 2.6 + Math.cos(a) * swirl;
        this.spawn(px, py, vx, vy, rand(0.3, 0.55), rand(1, 2.2), hue + rand(-20, 20), 75, 'spark', 0.5);
      }
      this.waves.push({ x: bp!.x, y: bp!.y, age: 0, max: 0.5, size: 90, hue });
      this.flash = 0.45;
      return;
    }

    // Blast away from the surface that was hit.
    let out = rand(0, Math.PI * 2);
    let cone = Math.PI;
    if (hit && bp) {
      out = Math.atan2(y - bp.y, x - bp.x);
      cone = 1.5;
      this.impacts.push({ body: hit.index, ox: x - bp.x, oy: y - bp.y, age: 0 });
    }
    const fireHue = hit?.body.kind === 'repulsor' ? 225 : 28;
    const dir = (spread: number) => out + rand(-spread, spread);

    // White-hot core.
    this.spawn(x, y, 0, 0, 0.26, 120, fireHue + 20, 96);
    this.spawn(x, y, 0, 0, 0.6, 70, fireHue, 72);
    // Fireball.
    for (let i = 0; i < 70; i++) {
      const a = dir(cone);
      const s = rand(40, 420);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.5, 1.2), rand(6, 17), fireHue + rand(-15, 22), rand(52, 70), 'glow', 3.2);
    }
    // Sparks and hot debris, streaking.
    for (let i = 0; i < 60; i++) {
      const a = dir(cone + 0.2);
      const s = rand(300, 1000);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.4, 1.1), rand(1.5, 3.2), fireHue + rand(10, 30), 82, 'spark', 1.4);
    }
    for (let i = 0; i < 16; i++) {
      const a = dir(cone - 0.2);
      const s = rand(150, 520);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(1, 1.9), rand(3, 5), hit ? hit.body.hue : fireHue, 58, 'spark', 0.7);
    }
    // Smoke left hanging in space.
    for (let i = 0; i < 20; i++) {
      const a = dir(cone + 0.3);
      const s = rand(20, 170);
      this.spawn(x + Math.cos(a) * 8, y + Math.sin(a) * 8, Math.cos(a) * s, Math.sin(a) * s, rand(1.3, 2.6), rand(12, 26), 225, rand(10, 18), 'smoke', 2.4);
    }
    this.waves.push({ x, y, age: 0, max: 0.8, size: 260, hue: fireHue });
    this.waves.push({ x, y, age: -0.08, max: 0.65, size: 140, hue: fireHue + 25 });
    this.flash = 1;
  }

  // ---------------------------------------------------------------- loop

  private frame(now: number) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    if (this.level) {
      this.update(dt);
      this.render();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private update(dt: number) {
    const lvl = this.level;
    const t = lvl.target;
    const distT = Math.hypot(this.probe.x - t.x, this.probe.y - t.y);
    const nearTarget = this.phase === 'flying' && this.live && distT < t.r * 4.5;

    let goalScale = 1;
    if (nearTarget) goalScale = 0.3;
    if (this.phase === 'won') goalScale = this.winTimer < 0.7 ? 0.25 : 1;
    this.timeScale += (goalScale - this.timeScale) * (1 - Math.exp(-dt * 10));

    const fast = this.ff && this.phase === 'flying' && !nearTarget ? 3 : 1;
    const sdt = dt * this.timeScale * fast;
    this.anim += dt * this.timeScale;

    const rs = this.replayShot;
    if (rs && this.phase === 'idle' && this.clock + sdt >= rs.t0) {
      // Fire at exactly the recorded time so the flight is identical.
      this.clock = rs.t0;
      this.replayShot = null;
      this.fire(rs.vx, rs.vy);
    }

    if (this.phase === 'flying') {
      this.acc += sdt;
      while (this.acc >= STEP && this.phase === 'flying') {
        this.acc -= STEP;
        bodyPositions(lvl, this.clock, this.pos);
        const before = { x: this.probe.x, y: this.probe.y };
        const out = stepProbe(lvl, this.probe, this.pos);
        this.clock += STEP;
        this.flightTime += STEP;
        this.stepCount++;
        if (out === 'warp') {
          const w = this.wormholeNear(before);
          if (w) this.onWarp(before, this.probe, WORM_HUES[w.index % WORM_HUES.length]);
          this.trail.push({ x: this.probe.x, y: this.probe.y, brk: true });
        } else if (this.stepCount % 2 === 0) {
          this.trail.push({ x: this.probe.x, y: this.probe.y });
        }
        if (this.trail.length > TRAIL_MAX) this.trail.shift();
        if (this.dustGot.length && this.live) {
          const k = dustHit(lvl, this.probe, this.dustGot);
          if (k >= 0) this.collectDust(k);
        }
        if (out !== 'flying' && out !== 'warp') this.resolve(out);
        else if (this.flightTime > MAX_FLIGHT && this.live) this.resolve('lost', 'Trapped in orbit');
      }
      if (this.phase === 'flying' && Math.random() < 0.6) {
        const p = this.probe;
        this.spawn(p.x, p.y, -p.vx * 0.15 + rand(-20, 20), -p.vy * 0.15 + rand(-20, 20), rand(0.2, 0.5), rand(0.8, 1.6), rand(185, 215), 80);
      }
    } else if (this.mode !== 'edit') {
      this.clock += sdt;
    }
    bodyPositions(lvl, this.clock, this.pos);

    if (this.phase === 'aiming') {
      const d = this.aimVec();
      this.preview.length = 0;
      if (Math.hypot(d.x, d.y) >= MIN_DRAG) {
        const v = launchVelocity(d.x, d.y);
        const r = simulate(lvl, v.x, v.y, this.clock, { maxTime: this.settings.assist ? 3.2 : 1.2, path: this.preview, pathEvery: 6 });
        this.previewOutcome = r.outcome;
      }
    }

    if (this.phase === 'resolving') {
      this.resolveTimer -= dt;
      if (this.resolveTimer <= 0) {
        this.resetProbe();
        if (this.mode === 'attract') this.launchAttract();
        if (this.mode === 'replay') this.hooks.onReplayFail();
      }
    }

    if (this.phase === 'won') {
      this.winTimer += dt;
      if (this.winTimer > 1.6 && !this.winFired) {
        this.winFired = true;
        this.hooks.onWin({
          shots: this.shots,
          dust: this.dustCount,
          dustTotal: this.dustGot.length,
          hinted: this.hinted,
          launch: this.lastLaunch,
        });
      }
    }

    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= sdt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      const drag = Math.exp(-sdt * p.drag);
      p.vx *= drag;
      p.vy *= drag;
    }
    this.waves = this.waves.filter((w) => (w.age += sdt) < w.max);
    this.impacts = this.impacts.filter((m) => (m.age += dt) < 1.4);
    this.flash = Math.max(0, this.flash - dt * 4);
    this.shake *= Math.exp(-dt * 9);

    this.updateBeeps(dt, distT);

    let mood = this.live ? 0.25 : 0.15;
    if (this.phase === 'flying' && this.live) mood = 0.45 + 0.55 * clamp(1 - (distT - t.r) / 500, 0, 1);
    if (this.phase === 'won') mood = this.winTimer < 3 ? 1 : 0.4;
    music.setIntensity(mood);

    // Camera: frame the arrival, then push in on a win.
    let goal = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
    if (this.phase === 'won') goal = { x: t.x, y: t.y, zoom: 1.7 };
    else if (nearTarget) goal = { x: (this.probe.x + t.x) / 2, y: (this.probe.y + t.y) / 2, zoom: 1.35 };
    const k = 1 - Math.exp(-dt * (this.phase === 'won' ? 2.5 : 4));
    this.cam.x += (goal.x - this.cam.x) * k;
    this.cam.y += (goal.y - this.cam.y) * k;
    this.cam.zoom += (goal.zoom - this.cam.zoom) * k;
  }

  /** Parking-sensor beeps: faster and higher as the probe closes in on the beacon. Real time, so slow-mo doesn't drag them out. */
  private updateBeeps(dt: number, distT: number) {
    this.targetPing = Math.max(0, this.targetPing - dt * 5);
    const t = this.level.target;
    const p = this.probe;
    const range = Math.max(320, t.r * 9);
    const approaching = (t.x - p.x) * p.vx + (t.y - p.y) * p.vy > 0;
    if (this.phase !== 'flying' || !this.live || distT > range || !approaching) {
      this.beepTimer = 0;
      return;
    }
    const close = 1 - clamp((distT - t.r) / (range - t.r), 0, 1);
    this.beepTimer -= dt;
    if (this.beepTimer <= 0) {
      sfx.beep(close);
      this.targetPing = 1;
      this.beepTimer = 0.42 - 0.34 * close;
    }
  }

  private wormholeNear(p: Vec): { w: Wormhole; index: number } | null {
    const whs = this.level.wormholes ?? [];
    let best: { w: Wormhole; index: number } | null = null;
    let bestD = Infinity;
    whs.forEach((w, index) => {
      const d = Math.min(Math.hypot(p.x - w.a.x, p.y - w.a.y), Math.hypot(p.x - w.b.x, p.y - w.b.y));
      if (d < bestD) {
        bestD = d;
        best = { w, index };
      }
    });
    return best;
  }

  // ---------------------------------------------------------------- rendering

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cw = this.canvas.clientWidth;
    this.ch = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    const vMargin = this.ch < 520 ? 70 : 130;
    this.fit = Math.min((this.cw * 0.96) / WORLD_W, (this.ch - vMargin) / WORLD_H);
    const c = this.ctx;
    this.vignette = c.createRadialGradient(this.cw / 2, this.ch / 2, Math.min(this.cw, this.ch) * 0.3, this.cw / 2, this.ch / 2, Math.hypot(this.cw, this.ch) * 0.6);
    this.vignette.addColorStop(0, 'rgba(0,0,0,0)');
    this.vignette.addColorStop(1, 'rgba(0,0,8,0.6)');
    if (this.level) this.renderBackground();
  }

  private renderBackground() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.bg.width = w;
    this.bg.height = h;
    const c = this.bg.getContext('2d')!;
    const rng = mulberry32(1000 + this.bgSeed * 7919);

    const base = c.createLinearGradient(0, 0, w * 0.3, h);
    base.addColorStop(0, '#05061a');
    base.addColorStop(0.6, '#080520');
    base.addColorStop(1, '#03030c');
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);

    c.globalCompositeOperation = 'lighter';
    const baseHue = rng() * 360;
    for (let i = 0; i < 7; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const r = (0.25 + rng() * 0.45) * Math.max(w, h);
      const hue = (baseHue + rng() * 120 - 60 + 360) % 360;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${hue}, 80%, 45%, ${0.06 + rng() * 0.08})`);
      g.addColorStop(0.5, `hsla(${hue + 30}, 80%, 35%, ${0.03 + rng() * 0.04})`);
      g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }

    const starCount = Math.round((w * h) / 2600);
    for (let i = 0; i < starCount; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const s = rng() < 0.97 ? rng() * 1.1 * this.dpr : (1.2 + rng() * 1.2) * this.dpr;
      const hue = rng() < 0.5 ? 220 : 40;
      c.fillStyle = `hsla(${hue}, 70%, 90%, ${0.15 + rng() * 0.6})`;
      c.beginPath();
      c.arc(x, y, s, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  private render() {
    const c = this.ctx;
    const { dpr, cw, ch } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.bg, 0, 0, cw, ch);

    // Twinkling foreground stars with a touch of parallax.
    const px = (this.cam.x - WORLD_W / 2) * 0.03;
    const py = (this.cam.y - WORLD_H / 2) * 0.03;
    for (const s of this.twinkles) {
      const a = 0.25 + 0.75 * Math.abs(Math.sin(this.anim * s.f + s.p));
      c.fillStyle = `rgba(220, 230, 255, ${a})`;
      c.beginPath();
      c.arc((((s.x * cw - px) % cw) + cw) % cw, (((s.y * ch - py) % ch) + ch) % ch, s.s, 0, Math.PI * 2);
      c.fill();
    }

    const S = this.fit * this.cam.zoom;
    const shx = (Math.random() - 0.5) * this.shake;
    const shy = (Math.random() - 0.5) * this.shake;
    c.setTransform(dpr * S, 0, 0, dpr * S, dpr * (cw / 2 - this.cam.x * S + shx), dpr * (ch / 2 - this.cam.y * S + shy));

    const editing = this.mode === 'edit';
    if (editing) this.drawBounds(S);
    if (this.settings.grid || editing) this.drawGrid(S);
    if (this.mode === 'play') {
      if (this.settings.bestRoute && this.bestPath) this.drawPath(this.bestPath, S, 'hsla(45, 100%, 65%, 0.28)', [2, 7]);
      this.ghosts.forEach((g, gi) => this.drawPath(g, S, `hsla(225, 70%, 75%, ${0.1 + gi * 0.06})`, [6, 6]));
    }
    if (editing) this.drawEditGuides(S);
    this.drawWormholes();
    if (this.mode !== 'attract') this.drawTarget();
    this.drawDust();
    this.level.bodies.forEach((b, i) => {
      if (b.kind === 'blackhole') this.drawBlackHole(b, this.pos[i]);
      else if (b.kind === 'repulsor') this.drawRepulsor(b, this.pos[i]);
      else this.drawPlanet(b, this.pos[i], i);
    });
    if (this.mode !== 'attract') this.drawLauncher();
    if (this.hint && this.mode === 'play') this.drawHint(S);
    this.drawAim(S);
    this.drawTrail();
    if (!editing) this.drawProbe();
    this.drawEffects();
    if (editing) this.drawSelection(S);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (this.vignette) {
      c.fillStyle = this.vignette;
      c.fillRect(0, 0, cw, ch);
    }
    if (this.flash > 0 && this.settings.shake) {
      c.fillStyle = `rgba(255, 214, 170, ${this.flash * 0.22})`;
      c.fillRect(0, 0, cw, ch);
    }
  }

  private drawBounds(S: number) {
    const c = this.ctx;
    c.strokeStyle = 'rgba(150, 170, 255, 0.35)';
    c.lineWidth = 1.5 / S;
    c.setLineDash([8 / S, 6 / S]);
    c.strokeRect(0, 0, WORLD_W, WORLD_H);
    c.setLineDash([]);
  }

  private drawGrid(S: number) {
    const c = this.ctx;
    const { gx, gy, gridCols: cols, gridRows: rows } = this;
    const bodies = this.level.bodies;
    const gms = bodies.map(gmOf);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const x0 = -GRID_PAD + col * GRID;
        const y0 = -GRID_PAD + r * GRID;
        let dx = 0;
        let dy = 0;
        for (let i = 0; i < bodies.length; i++) {
          const bx = this.pos[i].x - x0;
          const by = this.pos[i].y - y0;
          const d2 = bx * bx + by * by;
          const d = Math.sqrt(d2) + 1e-3;
          const raw = (gms[i] / (d2 + 3000)) * 0.025;
          const m = Math.sign(raw) * Math.min(Math.abs(raw), d * 0.8);
          dx += (bx / d) * m;
          dy += (by / d) * m;
        }
        gx[r * cols + col] = x0 + dx;
        gy[r * cols + col] = y0 + dy;
      }
    }
    c.lineWidth = 1 / S;
    c.strokeStyle = 'rgba(110, 140, 255, 0.11)';
    c.beginPath();
    for (let r = 0; r < rows; r++) {
      c.moveTo(gx[r * cols], gy[r * cols]);
      for (let col = 1; col < cols; col++) c.lineTo(gx[r * cols + col], gy[r * cols + col]);
    }
    for (let col = 0; col < cols; col++) {
      c.moveTo(gx[col], gy[col]);
      for (let r = 1; r < rows; r++) c.lineTo(gx[r * cols + col], gy[r * cols + col]);
    }
    c.stroke();
  }

  private drawPath(path: PathPt[], S: number, style: string, dash: number[]) {
    const c = this.ctx;
    c.lineWidth = 1.5 / S;
    c.setLineDash(dash.map((d) => d / S));
    c.strokeStyle = style;
    c.beginPath();
    path.forEach((p, i) => (i && !p.brk ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.stroke();
    c.setLineDash([]);
  }

  private drawEditGuides(S: number) {
    const c = this.ctx;
    c.lineWidth = 1 / S;
    c.setLineDash([4 / S, 6 / S]);
    this.level.bodies.forEach((b) => {
      if (!b.orbit) return;
      const o = b.orbit;
      const cx = o.around !== undefined ? this.pos[o.around].x : o.cx!;
      const cy = o.around !== undefined ? this.pos[o.around].y : o.cy!;
      c.strokeStyle = 'rgba(200, 210, 255, 0.3)';
      c.beginPath();
      c.arc(cx, cy, o.radius, 0, Math.PI * 2);
      c.stroke();
    });
    (this.level.wormholes ?? []).forEach((w, i) => {
      c.strokeStyle = `hsla(${WORM_HUES[i % WORM_HUES.length]}, 100%, 75%, 0.35)`;
      c.beginPath();
      c.moveTo(w.a.x, w.a.y);
      c.lineTo(w.b.x, w.b.y);
      c.stroke();
    });
    c.setLineDash([]);
    c.fillStyle = 'rgba(200, 215, 255, 0.7)';
    c.font = `600 ${12 / S}px "Space Grotesk", sans-serif`;
    c.textAlign = 'center';
    c.fillText('START', this.level.launch.x, this.level.launch.y + 44);
    c.fillText('BEACON', this.level.target.x, this.level.target.y + this.level.target.r * 1.6 + 18);
  }

  private drawSelection(S: number) {
    if (!this.sel) return;
    const c = this.ctx;
    const p = this.posOf(this.sel);
    const s = this.sel;
    const l = this.level;
    let r = 24;
    if (s.type === 'body') r = l.bodies[s.index].kind === 'blackhole' ? l.bodies[s.index].r * 2.6 : l.bodies[s.index].r + 10;
    else if (s.type === 'target') r = l.target.r + 12;
    else if (s.type === 'worm') r = l.wormholes![s.index].r + 10;
    else if (s.type === 'dust') r = DUST_R + 8;
    c.save();
    c.translate(p.x, p.y);
    c.rotate(this.anim * 0.6);
    c.strokeStyle = 'rgba(95, 245, 210, 0.95)';
    c.lineWidth = 2 / S;
    c.setLineDash([10 / S, 7 / S]);
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.stroke();
    c.restore();
    c.setLineDash([]);
  }

  private drawTarget() {
    const c = this.ctx;
    const { x, y, r } = this.level.target;
    const t = this.anim;
    const won = this.phase === 'won';

    c.globalCompositeOperation = 'lighter';
    const glow = c.createRadialGradient(x, y, r * 0.2, x, y, r * (won ? 4 : 2.6));
    glow.addColorStop(0, 'hsla(165, 100%, 60%, 0.45)');
    glow.addColorStop(1, 'hsla(165, 100%, 50%, 0)');
    c.fillStyle = glow;
    c.beginPath();
    c.arc(x, y, r * (won ? 4 : 2.6), 0, Math.PI * 2);
    c.fill();

    if (this.targetPing > 0) {
      c.strokeStyle = `hsla(165, 100%, 80%, ${this.targetPing * 0.9})`;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(x, y, r * (1.05 + (1 - this.targetPing) * 0.5), 0, Math.PI * 2);
      c.stroke();
    }

    for (let k = 0; k < 3; k++) {
      const ph = (t * 0.6 + k / 3) % 1;
      c.strokeStyle = `hsla(165, 100%, 70%, ${(1 - ph) * 0.55})`;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y, r * (0.8 + ph * 1.8), 0, Math.PI * 2);
      c.stroke();
    }

    c.save();
    c.translate(x, y);
    c.rotate(t * 0.8);
    c.setLineDash([10, 8]);
    c.strokeStyle = 'hsla(170, 100%, 75%, 0.9)';
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.stroke();
    c.rotate(-t * 2);
    c.setLineDash([4, 9]);
    c.strokeStyle = 'hsla(290, 100%, 80%, 0.8)';
    c.beginPath();
    c.arc(0, 0, r * 0.72, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    const core = c.createRadialGradient(x, y, 0, x, y, r * 0.5);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.4, 'hsla(170, 100%, 70%, 0.6)');
    core.addColorStop(1, 'hsla(170, 100%, 60%, 0)');
    c.fillStyle = core;
    c.beginPath();
    c.arc(x, y, r * 0.5, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  private drawWormholes() {
    const whs = this.level.wormholes;
    if (!whs) return;
    const c = this.ctx;
    whs.forEach((w, i) => {
      const hue = WORM_HUES[i % WORM_HUES.length];
      (['a', 'b'] as const).forEach((end, ei) => {
        const { x, y } = w[end];
        const r = w.r;
        c.globalCompositeOperation = 'lighter';
        const glow = c.createRadialGradient(x, y, r * 0.3, x, y, r * 2.4);
        glow.addColorStop(0, `hsla(${hue}, 100%, 65%, 0.45)`);
        glow.addColorStop(1, `hsla(${hue}, 100%, 55%, 0)`);
        c.fillStyle = glow;
        c.beginPath();
        c.arc(x, y, r * 2.4, 0, Math.PI * 2);
        c.fill();

        c.save();
        c.translate(x, y);
        const dir = ei ? -1 : 1;
        c.lineCap = 'round';
        for (let k = 0; k < 5; k++) {
          const rad = r * (0.35 + k * 0.16);
          c.save();
          c.rotate(this.anim * (2.6 - k * 0.3) * dir + k * 1.3);
          c.strokeStyle = `hsla(${hue + k * 8}, 100%, ${78 - k * 5}%, ${0.85 - k * 0.12})`;
          c.lineWidth = 2.2;
          c.beginPath();
          c.arc(0, 0, rad, 0, Math.PI * 1.25);
          c.stroke();
          c.restore();
        }
        c.restore();
        c.globalCompositeOperation = 'source-over';
        const hole = c.createRadialGradient(x, y, 0, x, y, r * 0.5);
        hole.addColorStop(0, 'rgba(4, 0, 16, 0.95)');
        hole.addColorStop(1, 'rgba(4, 0, 16, 0)');
        c.fillStyle = hole;
        c.beginPath();
        c.arc(x, y, r * 0.5, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = `hsla(${hue}, 100%, 80%, 0.7)`;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.stroke();
      });
    });
  }

  private drawDust() {
    const dust = this.level.dust;
    if (!dust) return;
    const c = this.ctx;
    c.globalCompositeOperation = 'lighter';
    dust.forEach((d, i) => {
      const got = this.dustGot[i] === 1;
      const pulse = 1 + Math.sin(this.anim * 4 + i) * 0.12;
      const alpha = got ? 0.12 : 1;
      const glow = c.createRadialGradient(d.x, d.y, 0, d.x, d.y, DUST_R * 2.2);
      glow.addColorStop(0, `hsla(45, 100%, 70%, ${0.5 * alpha})`);
      glow.addColorStop(1, 'hsla(45, 100%, 60%, 0)');
      c.fillStyle = glow;
      c.beginPath();
      c.arc(d.x, d.y, DUST_R * 2.2, 0, Math.PI * 2);
      c.fill();

      c.save();
      c.translate(d.x, d.y);
      c.rotate(this.anim * 0.8 + i);
      c.scale(pulse, pulse);
      c.fillStyle = `hsla(48, 100%, 85%, ${0.95 * alpha})`;
      c.beginPath();
      const R = DUST_R * 0.85;
      const r = R * 0.28;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const rad = k % 2 ? r : R;
        c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      c.closePath();
      c.fill();
      c.restore();
    });
    c.globalCompositeOperation = 'source-over';
  }

  private drawRings(b: BodyDef, p: Vec, front: boolean) {
    const c = this.ctx;
    const r = b.r;
    c.save();
    c.translate(p.x, p.y);
    c.rotate(-0.35);
    c.scale(1, 0.3);
    const bands = [
      { rad: 1.4, w: 0.1, a: 0.35 },
      { rad: 1.65, w: 0.24, a: 0.55 },
      { rad: 1.95, w: 0.12, a: 0.3 },
    ];
    for (const band of bands) {
      c.strokeStyle = `hsla(${b.hue + 30}, 55%, ${front ? 78 : 60}%, ${band.a})`;
      c.lineWidth = r * band.w;
      c.beginPath();
      if (front) c.arc(0, 0, r * band.rad, 0, Math.PI);
      else c.arc(0, 0, r * band.rad, Math.PI, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  private drawPlanet(b: BodyDef, p: Vec, index: number) {
    const c = this.ctx;
    const { x, y } = p;
    const r = b.r;
    const h = b.hue;

    const glow = c.createRadialGradient(x, y, r * 0.85, x, y, r * 1.8);
    glow.addColorStop(0, `hsla(${h}, 90%, 60%, 0.32)`);
    glow.addColorStop(1, `hsla(${h}, 90%, 50%, 0)`);
    c.fillStyle = glow;
    c.beginPath();
    c.arc(x, y, r * 1.8, 0, Math.PI * 2);
    c.fill();

    if (b.rings) this.drawRings(b, p, false);

    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.clip();
    const body = c.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.05, x, y, r * 1.1);
    body.addColorStop(0, `hsl(${h}, 75%, 75%)`);
    body.addColorStop(0.45, `hsl(${h}, 60%, 48%)`);
    body.addColorStop(1, `hsl(${h + 20}, 55%, 16%)`);
    c.fillStyle = body;
    c.fillRect(x - r, y - r, r * 2, r * 2);

    const rng = mulberry32(index * 131 + this.bgSeed * 17 + 3);
    const drift = this.anim * 4;
    for (let i = 0; i < 6; i++) {
      const by = y - r + rng() * r * 2;
      const bh = r * (0.06 + rng() * 0.16);
      c.fillStyle = `hsla(${h + (rng() * 50 - 25)}, 70%, ${rng() < 0.5 ? 80 : 25}%, ${0.08 + rng() * 0.12})`;
      c.beginPath();
      c.ellipse(x + ((drift * (0.5 + rng())) % (r * 0.6)) - r * 0.3, by, r * 1.4, bh, 0, 0, Math.PI * 2);
      c.fill();
    }

    const shade = c.createLinearGradient(x - r * 0.6, y - r * 0.6, x + r, y + r);
    shade.addColorStop(0, 'rgba(0,0,10,0)');
    shade.addColorStop(0.55, 'rgba(0,0,10,0.1)');
    shade.addColorStop(1, 'rgba(0,0,10,0.75)');
    c.fillStyle = shade;
    c.fillRect(x - r, y - r, r * 2, r * 2);
    c.restore();

    c.strokeStyle = `hsla(${h}, 100%, 82%, 0.35)`;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(x, y, r - 0.5, Math.PI * 0.95, Math.PI * 1.75);
    c.stroke();

    if (b.rings) this.drawRings(b, p, true);
  }

  private drawRepulsor(b: BodyDef, p: Vec) {
    const c = this.ctx;
    const { x, y } = p;
    const r = b.r;
    // Fixed blue-violet so a repulsor never reads as the (cyan) beacon.
    const h = 235;
    c.globalCompositeOperation = 'lighter';
    const glow = c.createRadialGradient(x, y, r * 0.8, x, y, r * 3.2);
    glow.addColorStop(0, `hsla(${h}, 100%, 68%, 0.35)`);
    glow.addColorStop(1, `hsla(${h}, 100%, 60%, 0)`);
    c.fillStyle = glow;
    c.beginPath();
    c.arc(x, y, r * 3.2, 0, Math.PI * 2);
    c.fill();

    // Dashed shock rings pushing outward.
    c.lineWidth = 2;
    c.setLineDash([6, 8]);
    for (let k = 0; k < 3; k++) {
      const ph = (this.anim * 0.8 + k / 3) % 1;
      c.strokeStyle = `hsla(${h}, 100%, 78%, ${(1 - ph) * 0.55})`;
      c.beginPath();
      c.arc(x, y, r * (1.2 + ph * 2), 0, Math.PI * 2);
      c.stroke();
    }
    c.setLineDash([]);
    c.globalCompositeOperation = 'source-over';

    // Spiky body: points outward, like it's shoving space away.
    c.save();
    c.translate(x, y);
    c.rotate(this.anim * 0.35);
    const core = c.createRadialGradient(-r * 0.2, -r * 0.2, 0, 0, 0, r * 1.25);
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.35, `hsl(${h}, 100%, 82%)`);
    core.addColorStop(1, `hsl(${h + 25}, 80%, 42%)`);
    c.fillStyle = core;
    c.beginPath();
    const spikes = 12;
    for (let k = 0; k < spikes * 2; k++) {
      const a = (k / (spikes * 2)) * Math.PI * 2;
      const rad = k % 2 ? r * 0.92 : r * 1.25;
      c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    c.closePath();
    c.fill();
    c.restore();
  }

  private drawBlackHole(b: BodyDef, p: Vec) {
    const c = this.ctx;
    const { x, y } = p;
    const r = b.r;
    const h = b.hue;

    const halo = c.createRadialGradient(x, y, r, x, y, r * 9);
    halo.addColorStop(0, `hsla(${h}, 100%, 60%, 0.28)`);
    halo.addColorStop(1, `hsla(${h}, 100%, 50%, 0)`);
    c.fillStyle = halo;
    c.beginPath();
    c.arc(x, y, r * 9, 0, Math.PI * 2);
    c.fill();

    const disc = (front: boolean) => {
      c.save();
      c.translate(x, y);
      c.rotate(-0.25);
      c.scale(1, 0.3);
      c.beginPath();
      c.rect(-r * 6, front ? 0 : -r * 6, r * 12, r * 6);
      c.clip();
      const g = c.createConicGradient(this.anim * 1.4, 0, 0);
      g.addColorStop(0, `hsla(${h}, 100%, 72%, 0.95)`);
      g.addColorStop(0.25, `hsla(${h + 20}, 100%, 55%, 0.35)`);
      g.addColorStop(0.5, `hsla(${h - 10}, 100%, 78%, 0.9)`);
      g.addColorStop(0.75, `hsla(${h + 15}, 100%, 50%, 0.3)`);
      g.addColorStop(1, `hsla(${h}, 100%, 72%, 0.95)`);
      c.fillStyle = g;
      c.globalCompositeOperation = 'lighter';
      c.beginPath();
      c.arc(0, 0, r * 4.4, 0, Math.PI * 2);
      c.arc(0, 0, r * 1.6, 0, Math.PI * 2, true);
      c.fill();
      c.restore();
      c.globalCompositeOperation = 'source-over';
    };

    disc(false);

    // Light bent over the top of the hole.
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = `hsla(${h + 10}, 100%, 70%, 0.45)`;
    c.lineWidth = r * 0.5;
    c.beginPath();
    c.ellipse(x, y, r * 1.9, r * 1.75, -0.25, Math.PI * 1.05, Math.PI * 1.95);
    c.stroke();
    c.globalCompositeOperation = 'source-over';

    c.fillStyle = '#000';
    c.beginPath();
    c.arc(x, y, r * 1.25, 0, Math.PI * 2);
    c.fill();

    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = `hsla(${h + 20}, 100%, 88%, 0.9)`;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, r * 1.32, 0, Math.PI * 2);
    c.stroke();
    c.globalCompositeOperation = 'source-over';

    disc(true);
  }

  private drawLauncher() {
    const c = this.ctx;
    const { x, y } = this.level.launch;
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(x, y, 4, x, y, 34);
    g.addColorStop(0, 'hsla(200, 100%, 60%, 0.35)');
    g.addColorStop(1, 'hsla(200, 100%, 50%, 0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, 34, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'hsla(200, 100%, 75%, 0.55)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 16, 0, Math.PI * 2);
    c.stroke();
    if (this.phase === 'idle' && this.active && this.mode === 'play') {
      c.save();
      c.translate(x, y);
      c.rotate(this.anim * 0.7);
      c.setLineDash([5, 7]);
      c.strokeStyle = `hsla(195, 100%, 75%, ${0.35 + 0.3 * Math.sin(this.anim * 4)})`;
      c.beginPath();
      c.arc(0, 0, 26 + Math.sin(this.anim * 3) * 3, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    c.globalCompositeOperation = 'source-over';
  }

  private drawHint(S: number) {
    const h = this.hint!;
    const c = this.ctx;
    const { x, y } = this.level.launch;
    const d = dragFor(h.vx, h.vy);
    const power = Math.hypot(h.vx, h.vy) / MAX_SPEED;
    const dir = Math.atan2(h.vy, h.vx);

    // Does the player's current aim match the hint?
    let matched = false;
    if (this.phase === 'aiming') {
      const cur = this.aimVec();
      const v = launchVelocity(cur.x, cur.y);
      const da = Math.abs(((Math.atan2(v.y, v.x) - dir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const dp = Math.abs(Math.hypot(v.x, v.y) / MAX_SPEED - power);
      matched = da < 0.012 && dp < 0.02;
    }
    const col = matched ? '150, 100%, 65%' : '45, 100%, 65%';

    c.globalCompositeOperation = 'lighter';
    // Where the probe should sit when pulled back.
    const pxl = x + d.x * 0.22;
    const pyl = y + d.y * 0.22;
    c.strokeStyle = `hsla(${col}, 0.9)`;
    c.lineWidth = 2 / S;
    c.setLineDash([3 / S, 4 / S]);
    c.beginPath();
    c.arc(pxl, pyl, PROBE_R * 2.2, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    // Launch direction arrow.
    const len = 40 + power * 70;
    const ex = x + Math.cos(dir) * len;
    const ey = y + Math.sin(dir) * len;
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(x + Math.cos(dir) * 22, y + Math.sin(dir) * 22);
    c.lineTo(ex, ey);
    c.lineTo(ex - Math.cos(dir - 0.4) * 12, ey - Math.sin(dir - 0.4) * 12);
    c.moveTo(ex, ey);
    c.lineTo(ex - Math.cos(dir + 0.4) * 12, ey - Math.sin(dir + 0.4) * 12);
    c.stroke();
    // Power ring.
    c.strokeStyle = `hsla(${col}, 0.8)`;
    c.lineWidth = 3;
    c.beginPath();
    c.arc(x, y, 36, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
    c.stroke();

    // Ghost probe flying the solution.
    let idx = -1;
    if (h.loop) {
      const cycle = h.path.length + 120;
      idx = Math.floor(((this.anim - h.start) / (STEP * 2)) % cycle);
    } else {
      // The sky repeats every period, so the same shot works again one cycle later.
      let t0 = h.t0;
      const dur = h.path.length * STEP * 2;
      if (h.period && this.clock > t0 + dur + 0.5) t0 += Math.ceil((this.clock - t0 - dur - 0.5) / h.period) * h.period;
      if (this.clock >= t0) {
        idx = Math.floor((this.clock - t0) / (STEP * 2));
      } else if (this.phase === 'idle' || this.phase === 'aiming') {
        const left = t0 - this.clock;
        c.fillStyle = left < 0.35 ? 'hsla(150, 100%, 70%, 1)' : 'hsla(45, 100%, 75%, 0.95)';
        c.font = `600 ${15 / S}px "Space Grotesk", sans-serif`;
        c.textAlign = 'center';
        c.fillText(left < 0.35 ? 'Launch now!' : `Launch in ${Math.ceil(left)}`, x, y - 48);
      }
    }
    if (idx >= 0 && idx < h.path.length) {
      const from = Math.max(0, idx - 60);
      c.strokeStyle = 'hsla(45, 100%, 65%, 0.5)';
      c.lineWidth = 2;
      c.beginPath();
      for (let i = from; i <= idx; i++) {
        const p = h.path[i];
        if (i === from || p.brk) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      }
      c.stroke();
      const p = h.path[idx];
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, PROBE_R * 4);
      g.addColorStop(0, 'hsla(48, 100%, 85%, 0.9)');
      g.addColorStop(1, 'hsla(45, 100%, 60%, 0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(p.x, p.y, PROBE_R * 4, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  /** How far the probe is pulled back right now: the live aim, or a replay winding up. */
  private pullVec(): Vec | null {
    if (this.phase === 'aiming') return this.aimVec();
    const rs = this.replayShot;
    if (rs && this.phase === 'idle') {
      const k = clamp(1 - (rs.t0 - this.clock) / rs.lead, 0, 1);
      const d = dragFor(rs.vx, rs.vy);
      return { x: d.x * k, y: d.y * k };
    }
    return null;
  }

  private drawAim(S: number) {
    const d = this.pullVec();
    if (!d) return;
    const c = this.ctx;
    const { x, y } = this.level.launch;
    const power = Math.hypot(d.x, d.y) / MAX_DRAG;
    const aiming = this.phase === 'aiming';

    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = 'hsla(200, 100%, 80%, 0.5)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + d.x * 0.22, y + d.y * 0.22);
    c.stroke();

    const hue = 190 + power * 120;
    c.strokeStyle = `hsla(${hue}, 100%, 70%, 0.25)`;
    c.lineWidth = 5;
    c.beginPath();
    c.arc(x, y, 30, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = `hsla(${hue}, 100%, 70%, 0.95)`;
    c.beginPath();
    c.arc(x, y, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
    c.stroke();

    // Exact readout, so a good shot can be repeated (arrow keys fine-tune it).
    if (power > 0.01) {
      const deg = ((-Math.atan2(-d.y, -d.x) * 180) / Math.PI + 360) % 360;
      const below = y < 120;
      c.globalCompositeOperation = 'source-over';
      c.textAlign = 'center';
      c.font = `600 ${13 / S}px "Space Grotesk", sans-serif`;
      c.fillStyle = 'rgba(225, 235, 255, 0.92)';
      c.fillText(`${deg.toFixed(1)}°  ·  ${(power * 100).toFixed(1)}%`, x, below ? y + 52 + 13 / S : y - 46);
      if (this.kbAim) {
        c.font = `500 ${11 / S}px "Space Grotesk", sans-serif`;
        c.fillStyle = 'rgba(160, 175, 220, 0.85)';
        c.fillText('Enter to launch', x, below ? y + 56 + 28 / S : y - 46 - 16 / S);
      }
      c.globalCompositeOperation = 'lighter';
    }
    if (!aiming) {
      c.globalCompositeOperation = 'source-over';
      return;
    }

    const n = this.preview.length;
    for (let i = 0; i < n; i++) {
      const p = this.preview[i];
      const f = 1 - i / n;
      c.fillStyle = `hsla(190, 100%, 82%, ${0.15 + f * 0.8})`;
      c.beginPath();
      c.arc(p.x, p.y, (1.4 + f * 2) / Math.sqrt(S), 0, Math.PI * 2);
      c.fill();
    }
    if (n && this.previewOutcome !== 'flying' && this.previewOutcome !== 'lost') {
      const end = this.preview[n - 1];
      if (this.previewOutcome === 'crash') {
        c.strokeStyle = 'hsla(0, 100%, 65%, 0.9)';
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(end.x - 7, end.y - 7);
        c.lineTo(end.x + 7, end.y + 7);
        c.moveTo(end.x + 7, end.y - 7);
        c.lineTo(end.x - 7, end.y + 7);
        c.stroke();
      } else if (this.previewOutcome === 'target') {
        c.strokeStyle = 'hsla(150, 100%, 70%, 0.9)';
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(end.x, end.y, 10, 0, Math.PI * 2);
        c.stroke();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  private drawTrail() {
    const c = this.ctx;
    const tr = this.trail;
    const n = tr.length;
    if (n < 2) return;
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const CHUNK = 10;
    for (const pass of [
      { w: 9, a: 0.1 },
      { w: 2.4, a: 0.9 },
    ]) {
      c.lineWidth = pass.w;
      for (let s = 0; s < n - 1; s += CHUNK) {
        const f = (s + CHUNK / 2) / n;
        c.strokeStyle = `hsla(${285 - f * 95}, 100%, ${60 + f * 15}%, ${Math.pow(f, 1.6) * pass.a})`;
        c.beginPath();
        c.moveTo(tr[s].x, tr[s].y);
        const end = Math.min(n - 1, s + CHUNK);
        for (let i = s + 1; i <= end; i++) {
          if (tr[i].brk) c.moveTo(tr[i].x, tr[i].y);
          else c.lineTo(tr[i].x, tr[i].y);
        }
        if (end === n - 1 && this.phase === 'flying') c.lineTo(this.probe.x, this.probe.y);
        c.stroke();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  private drawProbe() {
    if (this.phase === 'resolving' || this.phase === 'won') return;
    if (this.mode === 'attract' && this.phase !== 'flying') return;
    const c = this.ctx;
    let { x, y } = this.probe;
    const pull = this.pullVec();
    if (pull) {
      x += pull.x * 0.22;
      y += pull.y * 0.22;
    }
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(x, y, 0, x, y, PROBE_R * 5);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.25, 'hsla(190, 100%, 70%, 0.6)');
    g.addColorStop(1, 'hsla(200, 100%, 60%, 0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, PROBE_R * 5, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(x, y, PROBE_R * 0.8, 0, Math.PI * 2);
    c.fill();
  }

  private drawEffects() {
    const c = this.ctx;

    // Smoke first, normally blended, so fire glows on top of it.
    for (const p of this.particles) {
      if (p.kind !== 'smoke') continue;
      const a = p.life / p.max;
      const r = p.size * (1 + (1 - a) * 1.8);
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, `hsla(${p.hue}, 14%, ${p.light}%, ${a * 0.4})`);
      g.addColorStop(1, `hsla(${p.hue}, 14%, ${p.light}%, 0)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
    }

    c.globalCompositeOperation = 'lighter';
    // Scorch glow on whatever was hit, riding along with it.
    for (const m of this.impacts) {
      const bp = this.pos[m.body];
      const b = this.level.bodies[m.body];
      if (!bp || !b) continue;
      const f = 1 - m.age / 1.4;
      const x = bp.x + m.ox;
      const y = bp.y + m.oy;
      const r = Math.max(24, b.r * 0.9);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(32, 100%, 72%, ${f * 0.75})`);
      g.addColorStop(0.4, `hsla(18, 100%, 55%, ${f * 0.35})`);
      g.addColorStop(1, 'hsla(10, 100%, 50%, 0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }

    for (const w of this.waves) {
      if (w.age < 0) continue;
      const f = w.age / w.max;
      c.strokeStyle = `hsla(${w.hue}, 100%, 70%, ${(1 - f) * 0.7})`;
      c.lineWidth = 3 * (1 - f) + 0.5;
      c.beginPath();
      c.arc(w.x, w.y, w.size * (1 - Math.pow(1 - f, 3)), 0, Math.PI * 2);
      c.stroke();
    }

    c.lineCap = 'round';
    for (const p of this.particles) {
      if (p.kind === 'smoke') continue;
      const a = p.life / p.max;
      if (p.kind === 'spark') {
        c.strokeStyle = `hsla(${p.hue}, 100%, ${p.light}%, ${a})`;
        c.lineWidth = p.size * (0.5 + 0.5 * a);
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        c.stroke();
      } else if (p.size > 14) {
        // Big glows (flashes, fireball cores) need a soft falloff or they read as flat discs.
        const r = p.size * (0.6 + 0.4 * a);
        const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${p.hue}, 100%, ${p.light}%, ${a})`);
        g.addColorStop(0.35, `hsla(${p.hue}, 100%, ${p.light - 12}%, ${a * 0.55})`);
        g.addColorStop(1, `hsla(${p.hue}, 100%, ${p.light - 25}%, 0)`);
        c.fillStyle = g;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fill();
      } else {
        c.fillStyle = `hsla(${p.hue}, 100%, ${p.light}%, ${a})`;
        c.beginPath();
        c.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, Math.PI * 2);
        c.fill();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }
}
