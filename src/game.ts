import {
  MAX_DRAG,
  MAX_FLIGHT,
  MIN_DRAG,
  PROBE_R,
  STEP,
  WORLD_H,
  WORLD_W,
  bodyPositions,
  gmOf,
  launchVelocity,
  simulate,
  stepProbe,
  type BodyDef,
  type LevelDef,
  type Outcome,
  type Probe,
  type Vec,
} from './physics.ts';
import { sfx } from './audio.ts';

type Phase = 'idle' | 'aiming' | 'flying' | 'resolving' | 'won';

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
}

interface Wave {
  x: number;
  y: number;
  age: number;
  max: number;
  size: number;
  hue: number;
}

export interface GameHooks {
  onShot(shots: number): void;
  onMessage(text: string): void;
  onWin(shots: number): void;
}

const PREVIEW_TIME = 1.2;
const TRAIL_MAX = 700;
const GRID = 50;
const GRID_PAD = 150;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Game {
  active = false;
  levelIndex = 0;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hooks: GameHooks;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private fit = 1;
  private cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
  private bg = document.createElement('canvas');
  private vignette: CanvasGradient | null = null;
  private twinkles: { x: number; y: number; s: number; p: number; f: number }[] = [];

  private level!: LevelDef;
  private phase: Phase = 'idle';
  private attract = false;
  private clock = 0;
  private anim = 0;
  private acc = 0;
  private probe: Probe = { x: 0, y: 0, vx: 0, vy: 0 };
  private flightTime = 0;
  private stepCount = 0;
  private trail: Vec[] = [];
  private ghosts: Vec[][] = [];
  private particles: Particle[] = [];
  private waves: Wave[] = [];
  private pos: Vec[] = [];
  private preview: Vec[] = [];
  private previewOutcome: Outcome = 'flying';
  private shots = 0;
  private timeScale = 1;
  private shake = 0;
  private resolveTimer = 0;
  private winTimer = 0;
  private winFired = false;
  private drag: { sx: number; sy: number; x: number; y: number; id: number } | null = null;
  private gx = new Float32Array(0);
  private gy = new Float32Array(0);
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
    canvas.addEventListener('pointercancel', () => this.cancelAim());

    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- public API

  loadLevel(index: number, level: LevelDef) {
    this.attract = false;
    this.level = level;
    this.levelIndex = index;
    this.clock = 0;
    this.shots = 0;
    this.ghosts = [];
    this.particles = [];
    this.waves = [];
    this.cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
    this.timeScale = 1;
    this.resetProbe();
    this.renderBackground();
    this.hooks.onShot(0);
  }

  /** Title-screen mode: a probe circling a planet forever, relaunched when it falls. */
  startAttract(level: LevelDef) {
    this.loadLevel(-1, level);
    this.attract = true;
    this.launchAttract();
  }

  restart() {
    this.loadLevel(this.levelIndex, this.level);
  }

  recall() {
    if (this.phase === 'flying' && !this.attract) this.resolve('lost', 'Probe recalled');
  }

  // ---------------------------------------------------------------- input

  private dragScale() {
    const screenMax = Math.min(230, Math.max(110, MAX_DRAG * this.fit * 1.2));
    return MAX_DRAG / screenMax;
  }

  private dragWorld(): Vec {
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
    if (!this.active || this.attract || this.phase !== 'idle') return;
    this.drag = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId };
    this.phase = 'aiming';
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const d = this.dragWorld();
    this.drag = null;
    if (Math.hypot(d.x, d.y) >= MIN_DRAG && this.phase === 'aiming') this.launch(d);
    else this.phase = 'idle';
  }

  private cancelAim() {
    this.drag = null;
    if (this.phase === 'aiming') this.phase = 'idle';
  }

  // ---------------------------------------------------------------- gameplay

  private resetProbe() {
    const { x, y } = this.level.launch;
    this.probe = { x, y, vx: 0, vy: 0 };
    this.trail = [];
    this.phase = 'idle';
  }

  private beginFlight(vx: number, vy: number) {
    const { x, y } = this.level.launch;
    this.probe = { x, y, vx, vy };
    this.phase = 'flying';
    this.acc = 0;
    this.flightTime = 0;
    this.stepCount = 0;
    this.trail = [{ x, y }];
  }

  private launch(d: Vec) {
    const v = launchVelocity(d.x, d.y);
    const power = Math.hypot(d.x, d.y) / MAX_DRAG;
    this.beginFlight(v.x, v.y);
    this.shots++;
    this.hooks.onShot(this.shots);
    sfx.launch(power);
    const ang = Math.atan2(-v.y, -v.x);
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

  private resolve(out: Outcome, reason?: string) {
    if (out === 'target') {
      this.phase = 'won';
      this.winTimer = 0;
      this.winFired = false;
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

    if (this.trail.length > 4 && !this.attract) {
      this.ghosts.push(this.trail.filter((_, i) => i % 3 === 0));
      if (this.ghosts.length > 3) this.ghosts.shift();
    }
    this.phase = 'resolving';

    if (out === 'crash') {
      const hitHole = this.nearestBody()?.kind === 'blackhole';
      this.explode(this.probe.x, this.probe.y, hitHole);
      this.shake = hitHole ? 6 : 16;
      this.resolveTimer = 1.1;
      if (!this.attract) {
        sfx.crash();
        this.hooks.onMessage(hitHole ? 'Swallowed by the black hole' : 'Crashed!');
      }
    } else {
      this.resolveTimer = 0.8;
      if (!this.attract) {
        if (!reason) sfx.lost();
        this.hooks.onMessage(reason ?? 'Lost in deep space');
      }
    }
  }

  private nearestBody(): BodyDef | undefined {
    let best: BodyDef | undefined;
    let bestD = Infinity;
    this.level.bodies.forEach((b, i) => {
      const d = Math.hypot(this.pos[i].x - this.probe.x, this.pos[i].y - this.probe.y) - b.r;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    });
    return best;
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, hue: number, light: number) {
    if (this.particles.length > 900) return;
    this.particles.push({ x, y, vx, vy, life, max: life, size, hue, light });
  }

  private explode(x: number, y: number, implode: boolean) {
    if (implode) {
      for (let i = 0; i < 50; i++) {
        const a = rand(0, Math.PI * 2);
        const d = rand(30, 90);
        this.spawn(x + Math.cos(a) * d, y + Math.sin(a) * d, -Math.cos(a) * d * 3, -Math.sin(a) * d * 3, rand(0.25, 0.4), rand(1, 2.5), rand(20, 50), 70);
      }
      return;
    }
    this.spawn(x, y, 0, 0, 0.35, 46, 40, 85);
    for (let i = 0; i < 90; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(40, 420);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.4, 1.3), rand(1.2, 4), rand(10, 50), rand(55, 75));
    }
    this.waves.push({ x, y, age: 0, max: 0.6, size: 110, hue: 30 });
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
    const nearTarget = this.phase === 'flying' && !this.attract && distT < t.r * 4.5;

    let goalScale = 1;
    if (nearTarget) goalScale = 0.3;
    if (this.phase === 'won') goalScale = this.winTimer < 0.7 ? 0.25 : 1;
    this.timeScale += (goalScale - this.timeScale) * (1 - Math.exp(-dt * 10));

    const sdt = dt * this.timeScale;
    this.anim += sdt;

    if (this.phase === 'flying') {
      this.acc += sdt;
      while (this.acc >= STEP && this.phase === 'flying') {
        this.acc -= STEP;
        bodyPositions(lvl, this.clock, this.pos);
        const out = stepProbe(lvl, this.probe, this.pos);
        this.clock += STEP;
        this.flightTime += STEP;
        this.stepCount++;
        if (this.stepCount % 2 === 0) {
          this.trail.push({ x: this.probe.x, y: this.probe.y });
          if (this.trail.length > TRAIL_MAX) this.trail.shift();
        }
        if (out !== 'flying') this.resolve(out);
        else if (this.flightTime > MAX_FLIGHT && !this.attract) this.resolve('lost', 'Trapped in orbit');
      }
      if (this.phase === 'flying' && Math.random() < 0.6) {
        const p = this.probe;
        this.spawn(p.x, p.y, -p.vx * 0.15 + rand(-20, 20), -p.vy * 0.15 + rand(-20, 20), rand(0.2, 0.5), rand(0.8, 1.6), rand(185, 215), 80);
      }
    } else {
      this.clock += sdt;
    }
    bodyPositions(lvl, this.clock, this.pos);

    if (this.phase === 'aiming' && this.drag) {
      const d = this.dragWorld();
      this.preview.length = 0;
      if (Math.hypot(d.x, d.y) >= MIN_DRAG) {
        const v = launchVelocity(d.x, d.y);
        this.previewOutcome = simulate(lvl, v.x, v.y, this.clock, PREVIEW_TIME, this.preview, 6);
      }
    }

    if (this.phase === 'resolving') {
      this.resolveTimer -= dt;
      if (this.resolveTimer <= 0) {
        this.resetProbe();
        if (this.attract) this.launchAttract();
      }
    }

    if (this.phase === 'won') {
      this.winTimer += dt;
      if (this.winTimer > 1.6 && !this.winFired) {
        this.winFired = true;
        this.hooks.onWin(this.shots);
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
      const drag = Math.exp(-sdt * 1.8);
      p.vx *= drag;
      p.vy *= drag;
    }
    this.waves = this.waves.filter((w) => (w.age += sdt) < w.max);
    this.shake *= Math.exp(-dt * 9);

    // Camera: frame the arrival, then push in on a win.
    let goal = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
    if (this.phase === 'won') goal = { x: t.x, y: t.y, zoom: 1.7 };
    else if (nearTarget) goal = { x: (this.probe.x + t.x) / 2, y: (this.probe.y + t.y) / 2, zoom: 1.35 };
    const k = 1 - Math.exp(-dt * (this.phase === 'won' ? 2.5 : 4));
    this.cam.x += (goal.x - this.cam.x) * k;
    this.cam.y += (goal.y - this.cam.y) * k;
    this.cam.zoom += (goal.zoom - this.cam.zoom) * k;
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
    const rng = mulberry32(1000 + this.levelIndex * 7919);

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

    this.drawGrid(S);
    this.drawGhosts(S);
    if (!this.attract) this.drawTarget();
    this.level.bodies.forEach((b, i) => {
      if (b.kind === 'blackhole') this.drawBlackHole(b, this.pos[i]);
      else this.drawPlanet(b, this.pos[i], i);
    });
    if (!this.attract) this.drawLauncher();
    this.drawAim(S);
    this.drawTrail();
    this.drawProbe();
    this.drawEffects();

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (this.vignette) {
      c.fillStyle = this.vignette;
      c.fillRect(0, 0, cw, ch);
    }
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
          const m = Math.min((gms[i] / (d2 + 3000)) * 0.025, d * 0.8);
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

  private drawGhosts(S: number) {
    const c = this.ctx;
    c.lineWidth = 1.5 / S;
    c.setLineDash([6 / S, 6 / S]);
    this.ghosts.forEach((g, gi) => {
      c.strokeStyle = `hsla(225, 70%, 75%, ${0.1 + gi * 0.06})`;
      c.beginPath();
      g.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    });
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

    const rng = mulberry32(index * 131 + this.levelIndex * 17 + 3);
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
    if (this.phase === 'idle' && this.active) {
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

  private drawAim(S: number) {
    if (this.phase !== 'aiming' || !this.drag) return;
    const c = this.ctx;
    const { x, y } = this.level.launch;
    const d = this.dragWorld();
    const power = Math.hypot(d.x, d.y) / MAX_DRAG;

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

    const n = this.preview.length;
    for (let i = 0; i < n; i++) {
      const p = this.preview[i];
      const f = 1 - i / n;
      c.fillStyle = `hsla(190, 100%, 82%, ${0.15 + f * 0.8})`;
      c.beginPath();
      c.arc(p.x, p.y, (1.4 + f * 2) / Math.sqrt(S), 0, Math.PI * 2);
      c.fill();
    }
    if (n && this.previewOutcome !== 'flying') {
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
        for (let i = s + 1; i <= end; i++) c.lineTo(tr[i].x, tr[i].y);
        if (end === n - 1) c.lineTo(this.probe.x, this.probe.y);
        c.stroke();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  private drawProbe() {
    if (this.phase === 'resolving' || this.phase === 'won') return;
    if (this.attract && this.phase !== 'flying') return;
    const c = this.ctx;
    let { x, y } = this.probe;
    if (this.phase === 'aiming') {
      const d = this.dragWorld();
      x += d.x * 0.22;
      y += d.y * 0.22;
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
    c.globalCompositeOperation = 'lighter';
    for (const w of this.waves) {
      if (w.age < 0) continue;
      const f = w.age / w.max;
      c.strokeStyle = `hsla(${w.hue}, 100%, 70%, ${(1 - f) * 0.7})`;
      c.lineWidth = 3 * (1 - f) + 0.5;
      c.beginPath();
      c.arc(w.x, w.y, w.size * (1 - Math.pow(1 - f, 3)), 0, Math.PI * 2);
      c.stroke();
    }
    for (const p of this.particles) {
      const a = p.life / p.max;
      c.fillStyle = `hsla(${p.hue}, 100%, ${p.light}%, ${a})`;
      c.beginPath();
      c.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }
}
