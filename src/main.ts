import './style.css';
import { Game, WORM_HUES, type Launch, type Selection, type Settings, type WinInfo } from './game.ts';
import { DEMO_LEVEL, LEVELS } from './levels.ts';
import { hasMovingBodies, starsFor, type BodyDef, type LevelDef } from './physics.ts';
import { sfx } from './audio.ts';
import { music } from './music.ts';
import { dateKey } from './daily.ts';
import { canonical, cloneLevel, decodeLevel, decodeReplay, encodeLevel, encodeReplay, type LevelRef, type ReplayData } from './share.ts';
import { dailyAsync, solveAsync } from './worker.ts';
import { hashString } from './rng.ts';

// ---------------------------------------------------------------- save data

const STORAGE_KEY = 'orbit-slingshot:v1';

interface DailyResult {
  shots: number;
  stars: number;
  dust: number;
  dustTotal: number;
}

interface Save {
  stars: number[];
  muted: boolean;
  best: Record<number, { launch: Launch; shots: number }>;
  settings: Settings;
  daily: Record<string, DailyResult>;
  streak: { last: string; count: number };
  dailyLevel?: { key: string; enc: string };
  draft?: string;
}

function loadSave(): Save {
  const fresh: Save = {
    stars: [],
    muted: false,
    best: {},
    settings: { assist: false, shake: true, grid: true, bestRoute: true, music: true },
    daily: {},
    streak: { last: '', count: 0 },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { ...fresh, ...raw, settings: { ...fresh.settings, ...(raw.settings ?? {}) } };
  } catch {
    return fresh;
  }
}

const save = loadSave();
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Private mode or storage disabled: progress just won't survive a reload.
  }
}

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const screens = {
  title: $('#title'),
  levels: $('#levels'),
  hud: $('#hud'),
  win: $('#win'),
  editor: $('#editor'),
  settings: $('#settings'),
  loading: $('#loading'),
};
type ScreenName = keyof typeof screens;

const hintText = $('#hint');
const toast = $('#toast');
const levelLabel = $('#level-label');
const shotsLabel = $('#shots');
const dustLabel = $('#dust');
const levelGrid = $('#level-grid');
const muteBtn = $<HTMLButtonElement>('#btn-mute');
const hintBtn = $<HTMLButtonElement>('#btn-hint');
const ffBtn = $<HTMLButtonElement>('#btn-ff');
const menuBtn = $<HTMLButtonElement>('#btn-menu');
const inspector = $('#ed-inspector');
const nameInput = $<HTMLInputElement>('#ed-name');

function show(...names: ScreenName[]) {
  for (const [name, el] of Object.entries(screens)) el.classList.toggle('visible', names.includes(name as ScreenName));
}
const isVisible = (name: ScreenName) => screens[name].classList.contains('visible');

let toastTimer = 0;
function notify(text: string, kind: 'bad' | 'info' | 'good' = 'info', ms = 1800) {
  toast.textContent = text;
  toast.className = `toast ${kind}`;
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- game

type PlayContext =
  | { kind: 'campaign'; index: number }
  | { kind: 'daily'; key: string }
  | { kind: 'custom'; fromEditor: boolean }
  | { kind: 'replay'; data: ReplayData; level: LevelDef };

let ctx: PlayContext = { kind: 'campaign', index: 0 };
// The level as originally loaded, so retries start clean (the editor mutates drafts in place).
let lastLevel: LevelDef = LEVELS[0];
let editorDraft: LevelDef | null = null;
let lastWin: WinInfo | null = null;
const hud = screens.hud;

const game = new Game($<HTMLCanvasElement>('#game'), {
  onShot(shots) {
    if (ctx.kind === 'replay') return;
    shotsLabel.textContent = String(shots);
    if (shots > 0) hintText.classList.add('faded');
  },
  onMessage(text) {
    notify(text, 'bad', 1400);
  },
  onWin,
  onDust(got, total) {
    dustLabel.hidden = total === 0;
    dustLabel.innerHTML = `<span class="dust-icon">✦</span> ${got}/${total}`;
    dustLabel.classList.toggle('complete', total > 0 && got === total);
  },
  onFlightChange(flying) {
    ffBtn.classList.toggle('available', flying);
  },
  onSelect: renderInspector,
  onEdit: saveDraft,
  onReplayFail() {
    showReplayEnd(false);
  },
});
game.settings = save.settings;

const pad2 = (n: number) => String(n).padStart(2, '0');

function play(level: LevelDef, next: PlayContext) {
  ctx = next;
  lastLevel = cloneLevel(level);
  let label = '';
  let seed = 0;
  let best: Launch | null = null;
  if (next.kind === 'campaign') {
    label = `<b>${pad2(next.index + 1)}</b> `;
    seed = next.index;
    best = save.best[next.index]?.launch ?? null;
  } else if (next.kind === 'daily') {
    label = '<b>Daily</b> ';
    seed = seedFor({ d: next.key }, level);
  } else {
    label = '<b>Custom</b> ';
    seed = seedFor({ e: '' }, level);
  }
  game.loadLevel(level, { seed, best });
  game.active = true;
  levelLabel.innerHTML = label;
  levelLabel.append(level.name);
  hintText.textContent = level.hint;
  hintText.classList.remove('faded');
  hintBtn.classList.remove('used');
  ffBtn.classList.remove('active');
  menuBtn.setAttribute('aria-label', next.kind === 'custom' && next.fromEditor ? 'Back to editor' : 'Menu');
  menuBtn.classList.toggle('to-editor', next.kind === 'custom' && next.fromEditor);
  hud.classList.remove('replaying');
  show('hud');
}

/** Background seed, so a level always gets the same nebula wherever it's played from. */
function seedFor(ref: LevelRef, level: LevelDef) {
  if ('c' in ref) return ref.c;
  if ('d' in ref) return hashString(ref.d) % 10000;
  return hashString(level.name) % 10000;
}

const playCampaign = (i: number) => play(LEVELS[i], { kind: 'campaign', index: i });

function replay() {
  if (ctx.kind === 'campaign') playCampaign(ctx.index);
  else if (ctx.kind === 'replay') startReplay(ctx.data, ctx.level);
  else play(cloneLevel(lastLevel), ctx);
}

function leavePlay() {
  game.active = false;
  if (ctx.kind === 'campaign') openLevels();
  else if (ctx.kind === 'replay') openTitle();
  else if (ctx.kind === 'custom' && ctx.fromEditor) openEditor(editorDraft ?? undefined);
  else openTitle();
}

// ---------------------------------------------------------------- menus

function isUnlocked(i: number) {
  return i === 0 || (save.stars[i - 1] ?? 0) > 0;
}

function starMarkup(n: number) {
  return [0, 1, 2].map((i) => `<span class="star ${i < n ? 'on' : ''}">★</span>`).join('');
}

function renderLevelGrid() {
  const total = save.stars.reduce((a, b) => a + (b ?? 0), 0);
  $('#star-total').textContent = `★ ${total} / ${LEVELS.length * 3}`;
  levelGrid.innerHTML = LEVELS.map((lvl, i) => {
    const locked = !isUnlocked(i);
    const tags = [
      lvl.bodies.some((b) => b.orbit) && 'moving',
      lvl.bodies.some((b) => b.kind === 'blackhole') && 'black hole',
      lvl.bodies.some((b) => b.kind === 'repulsor') && 'repulsor',
      lvl.wormholes && 'wormhole',
      lvl.dust && 'stardust',
    ].filter(Boolean);
    return `<button class="level-card ${locked ? 'locked' : ''}" data-level="${i}" ${locked ? 'disabled' : ''}>
      <span class="num">${pad2(i + 1)}</span>
      <span class="name">${locked ? 'Locked' : lvl.name}</span>
      <span class="tags">${locked ? '' : tags.map((t) => `<i>${t}</i>`).join('')}</span>
      <span class="stars">${starMarkup(save.stars[i] ?? 0)}</span>
    </button>`;
  }).join('');
}

function renderTitle() {
  const key = dateKey();
  const done = save.daily[key];
  const streak = activeStreak();
  $('#daily-meta').textContent = done ? `Done today · ${'★'.repeat(done.stars)}` : streak ? `🔥 ${streak}-day streak` : 'New every day';
}

function activeStreak() {
  const today = dateKey();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return save.streak.last === today || save.streak.last === dateKey(y) ? save.streak.count : 0;
}

function openTitle() {
  game.active = false;
  game.startAttract(DEMO_LEVEL);
  renderTitle();
  show('title');
}

function openLevels() {
  game.active = false;
  game.startAttract(DEMO_LEVEL);
  renderLevelGrid();
  show('levels');
}

function firstUnfinished() {
  const i = LEVELS.findIndex((_, idx) => !(save.stars[idx] > 0));
  return i === -1 ? 0 : i;
}

function setMuted(m: boolean) {
  save.muted = m;
  sfx.setMuted(m);
  muteBtn.classList.toggle('muted', m);
  muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
  persist();
}

// ---------------------------------------------------------------- daily

/** Today's daily is cached; other dates (from replay links) are regenerated in the worker. */
async function loadDaily(key: string): Promise<LevelDef> {
  let level = save.dailyLevel?.key === key ? decodeLevel(save.dailyLevel.enc) : null;
  if (!level) {
    show('loading');
    game.startAttract(DEMO_LEVEL);
    // Canonical form, so hints and replays see exactly the numbers a share link would carry.
    level = canonical(await dailyAsync(key));
    if (key === dateKey()) {
      save.dailyLevel = { key, enc: encodeLevel(level) };
      persist();
    }
  }
  level.hint = `Daily challenge · ${key}`;
  return level;
}

async function openDaily() {
  const key = dateKey();
  play(await loadDaily(key), { kind: 'daily', key });
}

function recordDaily(key: string, r: DailyResult) {
  const prev = save.daily[key];
  if (!prev || r.stars > prev.stars || (r.stars === prev.stars && r.shots < prev.shots)) save.daily[key] = r;
  if (save.streak.last !== key) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    save.streak.count = save.streak.last === dateKey(y) ? save.streak.count + 1 : 1;
    save.streak.last = key;
  }
  // Keep the save small: only the last 60 days.
  const keys = Object.keys(save.daily).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete save.daily[k];
  persist();
}

// ---------------------------------------------------------------- win

function onWin(info: WinInfo) {
  lastWin = info;
  if (ctx.kind === 'replay') return showReplayEnd(true);
  const missed = info.dust < info.dustTotal;
  const stars = starsFor(info.shots, missed, info.hinted);
  if (ctx.kind === 'campaign') {
    const i = ctx.index;
    save.stars[i] = Math.max(save.stars[i] ?? 0, stars);
    const prev = save.best[i];
    if (!info.hinted && (!prev || info.shots <= prev.shots)) save.best[i] = { launch: info.launch, shots: info.shots };
    persist();
  } else if (ctx.kind === 'daily') {
    recordDaily(ctx.key, { shots: info.shots, stars, dust: info.dust, dustTotal: info.dustTotal });
  }
  showWin(info, stars);
}

function showWin(info: WinInfo, stars: number) {
  game.active = false;
  const lastCampaign = ctx.kind === 'campaign' && ctx.index === LEVELS.length - 1;
  $('#win-title').textContent = lastCampaign ? 'Campaign complete!' : ctx.kind === 'daily' ? 'Daily complete' : 'Probe delivered';
  $('#win-stars').innerHTML = starMarkup(stars);
  const bits = [`${info.shots} ${info.shots === 1 ? 'shot' : 'shots'}`];
  if (info.dustTotal) bits.push(`✦ ${info.dust}/${info.dustTotal} stardust`);
  if (info.hinted) bits.push('hint used');
  if (stars === 3) bits.push('perfect');
  $('#win-shots').textContent = bits.join(' · ');

  const actions = $('#win-actions');
  actions.innerHTML = '';
  const add = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement('button');
    b.className = `btn ${primary ? 'primary' : 'ghost'}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
  };
  if (ctx.kind === 'campaign') {
    const i = ctx.index;
    if (!lastCampaign) add('Next level', true, () => playCampaign(i + 1));
    add('Retry', lastCampaign, replay);
    add('Share replay', false, () => shareReplay({ c: i }));
    add('Levels', false, openLevels);
  } else if (ctx.kind === 'daily') {
    const key = ctx.key;
    add('Share result', true, () => shareDaily(key));
    add('Share replay', false, () => shareReplay({ d: key }));
    add('Retry', false, replay);
    add('Menu', false, openTitle);
  } else if (ctx.kind === 'custom' && ctx.fromEditor) {
    add('Back to editor', true, () => openEditor(editorDraft ?? undefined));
    add('Retry', false, replay);
    add('Share level', false, () => shareLevel(lastLevel));
    add('Share replay', false, () => shareReplay({ e: encodeLevel(lastLevel) }));
  } else {
    add('Retry', true, replay);
    add('Share replay', false, () => shareReplay({ e: encodeLevel(lastLevel) }));
    add('Remix in editor', false, () => openEditor(cloneLevel(lastLevel)));
    add('Menu', false, openTitle);
  }
  show('hud', 'win');
}

// ---------------------------------------------------------------- replays

function startReplay(data: ReplayData, level: LevelDef) {
  ctx = { kind: 'replay', data, level };
  lastLevel = cloneLevel(level);
  game.playReplay(cloneLevel(level), { vx: data.vx, vy: data.vy, t0: data.t0 }, seedFor(data.ref, level));
  const where = 'c' in data.ref ? `${pad2(data.ref.c + 1)} ` : 'd' in data.ref ? `Daily ${data.ref.d} · ` : '';
  levelLabel.innerHTML = '<b>Replay</b> ';
  levelLabel.append(where + level.name);
  shotsLabel.textContent = String(data.shots);
  hintText.textContent = data.shots === 1 ? 'Watching a one-shot win' : `Watching the winning shot (won in ${data.shots} shots)`;
  hintText.classList.remove('faded');
  menuBtn.classList.remove('to-editor');
  menuBtn.setAttribute('aria-label', 'Menu');
  hud.classList.add('replaying');
  ffBtn.classList.remove('active');
  show('hud');
}

async function openReplay(data: ReplayData) {
  const r = data.ref;
  let level: LevelDef | null = null;
  if ('c' in r) level = LEVELS[r.c] ?? null;
  else if ('d' in r) level = await loadDaily(r.d);
  else level = decodeLevel(r.e);
  if (!level) {
    notify('That replay link is broken', 'bad');
    return openTitle();
  }
  startReplay(data, level);
}

/** Shown when a replay finishes: it landed, or (if a level changed since) it didn't. */
function showReplayEnd(landed: boolean) {
  if (ctx.kind !== 'replay') return;
  const { data, level } = ctx;
  game.active = false;
  $('#win-title').textContent = landed ? 'Replay' : 'Replay missed';
  $('#win-stars').innerHTML = '';
  $('#win-shots').textContent = landed
    ? `${level.name} · won in ${data.shots} ${data.shots === 1 ? 'shot' : 'shots'}${lastWin?.dustTotal ? ` · ✦ ${lastWin.dust}/${lastWin.dustTotal}` : ''}`
    : 'This level has changed since the replay was recorded.';
  const actions = $('#win-actions');
  actions.innerHTML = '';
  const add = (label: string, primary: boolean, fn: () => void) => {
    const b = document.createElement('button');
    b.className = `btn ${primary ? 'primary' : 'ghost'}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
  };
  add('Play this level', true, () => {
    const r = data.ref;
    if ('c' in r) playCampaign(r.c);
    else if ('d' in r && r.d === dateKey()) void openDaily();
    else play(cloneLevel(level), { kind: 'custom', fromEditor: false });
  });
  add('Watch again', false, replay);
  add('Menu', false, openTitle);
  show('hud', 'win');
}

function shareReplay(ref: LevelRef) {
  if (!lastWin) return;
  const { launch, shots } = lastWin;
  const enc = encodeReplay({ ref, vx: launch.vx, vy: launch.vy, t0: launch.t0, shots });
  const what = shots === 1 ? 'one-shot' : `${shots}-shot win`;
  void shareOut(`Watch my ${what} on "${lastLevel.name}" in Orbit Slingshot`, `${baseUrl()}#replay=${enc}`, 'Replay link copied to clipboard');
}

// ---------------------------------------------------------------- sharing

const baseUrl = () => location.href.split('#')[0];

async function shareOut(text: string, url: string, copiedMsg: string) {
  const full = `${text}\n${url}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text, url });
      return;
    } catch {
      // Fall back to the clipboard if the share sheet was dismissed or failed.
    }
  }
  try {
    await navigator.clipboard.writeText(full);
    notify(copiedMsg, 'good');
  } catch {
    window.prompt('Copy this link:', url);
  }
}

function shareDaily(key: string) {
  const r = save.daily[key];
  if (!r) return;
  const name = lastLevel.name;
  const lines = [
    `Orbit Slingshot · Daily ${key}`,
    `${name}: ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} · ${r.shots} ${r.shots === 1 ? 'shot' : 'shots'}${r.dustTotal ? ` · ✦ ${r.dust}/${r.dustTotal}` : ''}`,
  ];
  const streak = activeStreak();
  if (streak > 1) lines.push(`🔥 ${streak}-day streak`);
  void shareOut(lines.join('\n'), `${baseUrl()}#daily`, 'Result copied to clipboard');
}

function shareLevel(level: LevelDef) {
  void shareOut(`Can you beat "${level.name}" in Orbit Slingshot?`, `${baseUrl()}#play=${encodeLevel(level)}`, 'Level link copied to clipboard');
}

// ---------------------------------------------------------------- hints

let hintBusy = false;
async function requestHint() {
  if (hintBusy || ctx.kind === 'replay' || !isVisible('hud') || isVisible('win') || game.isFlying) return;
  const level = game.currentLevel;
  const moving = hasMovingBodies(level);
  hintBusy = true;
  hintBtn.classList.add('busy');
  notify('Plotting a course…', 'info', 4000);
  let lead = 2.5;
  try {
    for (let tries = 0; tries < 3; tries++) {
      const now = game.currentClock;
      const t0s = moving ? Array.from({ length: 10 }, (_, i) => now + lead + i * 0.6) : [0];
      const rep = await solveAsync(level, { t0s, samples: 3000, want: 8, stopEarly: true, maxTime: 20, seed: (Date.now() & 0xffff) + tries });
      if (game.currentLevel !== level) return;
      if (!rep.solutions.length) {
        notify('No route found. Try again in a moment.', 'bad');
        return;
      }
      const minT = Math.min(...rep.solutions.map((s) => s.t0));
      const pick = rep.solutions.filter((s) => s.t0 === minT).sort((a, b) => b.dust - a.dust || b.score - a.score)[0];
      if (moving && pick.t0 < game.currentClock + 0.8) {
        lead += 2;
        continue;
      }
      game.showHint(pick);
      hintBtn.classList.add('used');
      notify(moving ? 'Match the gold aim and launch on the countdown (max ★★)' : 'Match the gold aim: it turns green when you’re on it (max ★★)', 'info', 3500);
      return;
    }
    notify('The sky moved too fast. Try the hint again.', 'bad');
  } finally {
    hintBusy = false;
    hintBtn.classList.remove('busy');
  }
}

// ---------------------------------------------------------------- editor

const LIMITS = { bodies: 12, wormholes: 4, dust: 8 };

function newDraft(): LevelDef {
  return {
    name: 'My level',
    hint: 'A custom level.',
    launch: { x: 180, y: 450 },
    target: { x: 1420, y: 450, r: 38 },
    bodies: [{ x: 800, y: 450, r: 70, hue: 200 }],
  };
}

function saveDraft() {
  if (!editorDraft) return;
  save.draft = encodeLevel(editorDraft);
  persist();
}

function openEditor(level?: LevelDef) {
  editorDraft = level ?? (save.draft ? decodeLevel(save.draft) : null) ?? newDraft();
  nameInput.value = editorDraft.name;
  game.startEditor(editorDraft);
  renderInspector(null);
  saveDraft();
  show('editor');
}

/** The most open spot in the middle of the field, so new items don't pile up. */
function freeSpot(): { x: number; y: number } {
  const l = editorDraft!;
  const taken = [
    { x: l.launch.x, y: l.launch.y, r: 60 },
    { x: l.target.x, y: l.target.y, r: l.target.r + 40 },
    ...l.bodies.filter((b) => !b.orbit).map((b) => ({ x: b.x!, y: b.y!, r: (b.kind === 'blackhole' ? 70 : b.r) + 30 })),
    ...(l.wormholes ?? []).flatMap((w) => [w.a, w.b].map((p) => ({ ...p, r: w.r + 30 }))),
    ...(l.dust ?? []).map((d) => ({ ...d, r: 40 })),
  ];
  let best = { x: 800, y: 450 };
  let bestGap = -Infinity;
  for (let i = 0; i < 60; i++) {
    const p = { x: Math.round(320 + Math.random() * 960), y: Math.round(120 + Math.random() * 660) };
    const gap = Math.min(...taken.map((t) => Math.hypot(p.x - t.x, p.y - t.y) - t.r));
    if (gap > bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  return best;
}

function addItem(kind: string) {
  const l = editorDraft!;
  const p = freeSpot();
  const hue = Math.round(Math.random() * 360);
  if (['planet', 'blackhole', 'repulsor', 'moon'].includes(kind) && l.bodies.length >= LIMITS.bodies) return notify(`Up to ${LIMITS.bodies} bodies per level`, 'bad');
  if (kind === 'planet') l.bodies.push({ ...p, r: 55, hue, rings: false });
  else if (kind === 'blackhole') l.bodies.push({ ...p, r: 16, gm: 2.5e7, kind: 'blackhole', hue });
  else if (kind === 'repulsor') l.bodies.push({ ...p, r: 38, gm: 1e7, kind: 'repulsor', hue: 195 });
  else if (kind === 'moon') {
    const sel = game.selection;
    let parent = sel?.type === 'body' && !l.bodies[sel.index].orbit ? sel.index : -1;
    if (parent < 0) parent = l.bodies.findIndex((b) => !b.orbit && b.kind !== 'blackhole');
    if (parent < 0) return notify('Add a planet for the moon to circle first', 'bad');
    const pb = l.bodies[parent];
    l.bodies.push({ r: 18, hue, orbit: { around: parent, radius: Math.round(pb.r + 80), period: 7, phase: 0 } });
  } else if (kind === 'wormhole') {
    l.wormholes ??= [];
    if (l.wormholes.length >= LIMITS.wormholes) return notify(`Up to ${LIMITS.wormholes} wormhole pairs`, 'bad');
    // Place one end, then find open space for the other end away from it.
    const w = { a: p, b: { ...p }, r: 28 };
    l.wormholes.push(w);
    w.b = freeSpot();
  } else if (kind === 'dust') {
    l.dust ??= [];
    if (l.dust.length >= LIMITS.dust) return notify(`Up to ${LIMITS.dust} stardust`, 'bad');
    l.dust.push(p);
  }
  const sel: Selection =
    kind === 'wormhole'
      ? { type: 'worm', index: l.wormholes!.length - 1, end: 'a' }
      : kind === 'dust'
        ? { type: 'dust', index: l.dust!.length - 1 }
        : { type: 'body', index: l.bodies.length - 1 };
  game.select(sel);
  saveDraft();
}

function removeSelected() {
  const l = editorDraft!;
  const s = game.selection;
  if (!s) return;
  if (s.type === 'body') {
    const drop = new Set([s.index]);
    l.bodies.forEach((b, j) => b.orbit?.around === s.index && drop.add(j));
    const remap = new Map<number, number>();
    const kept: BodyDef[] = [];
    l.bodies.forEach((b, j) => {
      if (drop.has(j)) return;
      remap.set(j, kept.length);
      kept.push(b);
    });
    kept.forEach((b) => {
      if (b.orbit?.around !== undefined) b.orbit.around = remap.get(b.orbit.around);
    });
    l.bodies.splice(0, l.bodies.length, ...kept);
  } else if (s.type === 'worm') l.wormholes!.splice(s.index, 1);
  else if (s.type === 'dust') l.dust!.splice(s.index, 1);
  else return;
  game.select(null);
  saveDraft();
}

interface Field {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  fmt?: (v: number) => string;
}

function renderInspector(sel: Selection | null) {
  if (!editorDraft || !isVisible('editor')) {
    inspector.hidden = true;
    return;
  }
  const l = editorDraft;
  if (!sel) {
    inspector.hidden = true;
    return;
  }
  let title = '';
  const fields: Field[] = [];
  let toggles: { label: string; get: () => boolean; set: (v: boolean) => void }[] = [];
  let deletable = true;
  const hueField = (b: { hue: number }): Field => ({ label: 'Colour', min: 0, max: 360, step: 1, get: () => b.hue, set: (v) => (b.hue = v), fmt: () => '' });

  if (sel.type === 'launch') {
    title = 'Launch pad';
    deletable = false;
  } else if (sel.type === 'target') {
    title = 'Beacon';
    deletable = false;
    fields.push({ label: 'Size', min: 20, max: 70, step: 1, get: () => l.target.r, set: (v) => (l.target.r = v) });
  } else if (sel.type === 'dust') {
    title = 'Stardust';
  } else if (sel.type === 'worm') {
    const w = l.wormholes![sel.index];
    title = 'Wormhole pair';
    fields.push({ label: 'Size', min: 18, max: 50, step: 1, get: () => w.r, set: (v) => (w.r = v) });
  } else {
    const b = l.bodies[sel.index];
    if (b.orbit) {
      title = 'Moon';
      const o = b.orbit;
      fields.push({ label: 'Size', min: 10, max: 40, step: 1, get: () => b.r, set: (v) => (b.r = v) });
      fields.push({ label: 'Orbit time', min: 3, max: 16, step: 0.5, get: () => Math.abs(o.period), set: (v) => (o.period = Math.sign(o.period || 1) * v), fmt: (v) => `${v}s` });
      fields.push(hueField(b));
      toggles = [{ label: 'Clockwise', get: () => o.period > 0, set: (v) => (o.period = Math.abs(o.period) * (v ? 1 : -1)) }];
    } else if (b.kind === 'blackhole') {
      title = 'Black hole';
      fields.push({ label: 'Pull', min: 8e6, max: 5e7, step: 1e6, get: () => b.gm ?? 2.5e7, set: (v) => (b.gm = v), fmt: (v) => `${Math.round(v / 1e6)}` });
      fields.push(hueField(b));
    } else if (b.kind === 'repulsor') {
      title = 'Repulsor';
      fields.push({ label: 'Size', min: 20, max: 70, step: 1, get: () => b.r, set: (v) => (b.r = v) });
      fields.push({ label: 'Push', min: 3e6, max: 2.4e7, step: 1e6, get: () => b.gm ?? 1e7, set: (v) => (b.gm = v), fmt: (v) => `${Math.round(v / 1e6)}` });
    } else {
      title = 'Planet';
      fields.push({ label: 'Size', min: 15, max: 130, step: 1, get: () => b.r, set: (v) => (b.r = v) });
      fields.push(hueField(b));
      toggles = [{ label: 'Rings', get: () => !!b.rings, set: (v) => (b.rings = v) }];
    }
  }

  inspector.hidden = false;
  inspector.innerHTML = `<div class="insp-head"><h3></h3>${deletable ? '<button class="icon-btn danger" data-act="delete" aria-label="Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" /></svg></button>' : ''}</div>`;
  inspector.querySelector('h3')!.textContent = title;
  fields.forEach((f) => {
    const row = document.createElement('label');
    row.className = 'insp-row';
    const isHue = f.label === 'Colour';
    row.innerHTML = `<span>${f.label}</span><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" ${isHue ? 'class="hue"' : ''}><output></output>`;
    const input = row.querySelector('input')!;
    const out = row.querySelector('output')!;
    input.value = String(f.get());
    const fmt = f.fmt ?? ((v: number) => String(Math.round(v)));
    out.textContent = fmt(f.get());
    input.addEventListener('input', () => {
      f.set(Number(input.value));
      out.textContent = fmt(Number(input.value));
    });
    input.addEventListener('change', saveDraft);
    inspector.append(row);
  });
  toggles.forEach((t) => {
    const row = document.createElement('label');
    row.className = 'insp-row toggle';
    row.innerHTML = `<span>${t.label}</span><input type="checkbox" class="switch">`;
    const input = row.querySelector('input')!;
    input.checked = t.get();
    input.addEventListener('change', () => {
      t.set(input.checked);
      saveDraft();
    });
    inspector.append(row);
  });
  if (sel.type === 'worm') {
    const note = document.createElement('p');
    note.className = 'insp-note';
    note.innerHTML = `<span class="swatch" style="--h:${WORM_HUES[sel.index % WORM_HUES.length]}"></span> Drag each end separately`;
    inspector.append(note);
  }
  if (sel.type === 'body' && l.bodies[sel.index].orbit) {
    const note = document.createElement('p');
    note.className = 'insp-note';
    note.textContent = 'Drag the moon to set its orbit';
    inspector.append(note);
  }
}

async function checkDraft() {
  const l = editorDraft!;
  const btn = $<HTMLButtonElement>('#ed-check');
  btn.disabled = true;
  notify('Testing thousands of shots…', 'info', 6000);
  try {
    const moving = hasMovingBodies(l);
    const rep = await solveAsync(l, { t0s: moving ? [0, 2, 4] : [0], samples: moving ? 1500 : 3500, want: 40, maxTime: 20, seed: 7 });
    if (!rep.hits) return notify('No solution found. Try moving things around.', 'bad', 3000);
    const rate = rep.hits / rep.tried;
    const difficulty = rate > 0.05 ? 'Easy' : rate > 0.015 ? 'Medium' : rate > 0.004 ? 'Hard' : 'Brutal';
    const dustTotal = l.dust?.length ?? 0;
    const perfect = !dustTotal || rep.solutions.some((s) => s.dust === dustTotal);
    notify(`Solvable ✓ · ${difficulty} (${(rate * 100).toFixed(1)}% of random shots land)${perfect ? '' : ' · no route found that collects all stardust'}`, perfect ? 'good' : 'info', 4200);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- settings

const SETTING_LABELS: [keyof Settings, string, string][] = [
  ['assist', 'Long aim preview', 'Shows nearly three times more of your path while aiming'],
  ['bestRoute', 'Show best route', 'A faint gold line of your best winning shot'],
  ['grid', 'Gravity grid', 'The warped space-time grid behind everything'],
  ['shake', 'Screen shake', 'Shake and flash the screen on crashes'],
  ['music', 'Music', 'A generative soundtrack that builds as you near the beacon'],
];

function openSettings() {
  const list = $('#settings-list');
  list.innerHTML = '';
  for (const [key, label, desc] of SETTING_LABELS) {
    const row = document.createElement('label');
    row.className = 'setting';
    row.innerHTML = `<span><b></b><small></small></span><input type="checkbox" class="switch">`;
    row.querySelector('b')!.textContent = label;
    row.querySelector('small')!.textContent = desc;
    const input = row.querySelector('input')!;
    input.checked = save.settings[key];
    input.addEventListener('change', () => {
      save.settings[key] = input.checked;
      if (key === 'music') music.setEnabled(input.checked);
      persist();
    });
    list.append(row);
  }
  show('settings');
}

// ---------------------------------------------------------------- wiring

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  sfx.click();
  // Don't leave HUD buttons focused, or Enter/Space would press them again mid-game.
  if (btn.closest('#hud')) btn.blur();
});
// Browsers only allow audio after a user gesture, so music starts on the first one.
const startAudio = () => {
  sfx.unlock();
  music.start();
};
document.addEventListener('pointerdown', startAudio);
document.addEventListener('keydown', startAudio);

$('#btn-play').addEventListener('click', () => playCampaign(firstUnfinished()));
$('#btn-levels').addEventListener('click', openLevels);
$('#btn-daily').addEventListener('click', () => void openDaily());
$('#btn-create').addEventListener('click', () => openEditor());
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-close').addEventListener('click', openTitle);
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Reset all stars, best routes and daily results?')) return;
  save.stars = [];
  save.best = {};
  save.daily = {};
  save.streak = { last: '', count: 0 };
  persist();
  notify('Progress reset', 'info');
});
$('#btn-levels-back').addEventListener('click', openTitle);
levelGrid.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.level-card');
  if (card && !card.disabled) playCampaign(Number(card.dataset.level));
});
$('#btn-restart').addEventListener('click', replay);
menuBtn.addEventListener('click', leavePlay);
muteBtn.addEventListener('click', () => setMuted(!save.muted));
hintBtn.addEventListener('click', () => void requestHint());
ffBtn.addEventListener('click', () => {
  game.ff = !game.ff;
  ffBtn.classList.toggle('active', game.ff);
});

$('#ed-exit').addEventListener('click', openTitle);
$('#ed-test').addEventListener('click', () => {
  if (!editorDraft) return;
  editorDraft.name = nameInput.value.trim() || 'My level';
  saveDraft();
  play(canonical(editorDraft), { kind: 'custom', fromEditor: true });
});
$('#ed-check').addEventListener('click', () => void checkDraft());
$('#ed-share').addEventListener('click', () => {
  if (!editorDraft) return;
  editorDraft.name = nameInput.value.trim() || 'My level';
  saveDraft();
  shareLevel(editorDraft);
});
$('#ed-clear').addEventListener('click', () => {
  if (!confirm('Start a new blank level? Your current draft will be replaced.')) return;
  save.draft = undefined;
  openEditor(newDraft());
});
nameInput.addEventListener('input', () => {
  if (editorDraft) editorDraft.name = nameInput.value.slice(0, 40);
});
nameInput.addEventListener('change', saveDraft);
$('#ed-tools').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-add]');
  if (b) addItem(b.dataset.add!);
});
inspector.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-act="delete"]')) removeSelected();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const winOpen = isVisible('win');
  const playing = isVisible('hud') && !winOpen;
  const k = e.key.toLowerCase();
  if (isVisible('editor')) {
    if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
    else if (e.key === 'Escape') game.select(null);
    return;
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (e.key in arrows && playing && ctx.kind !== 'replay') {
    // Left turns the aim anticlockwise, right clockwise: 0.5° a press (Shift: 0.1°). Up/down: power 1% (Shift: 0.2%).
    const [turn, push] = arrows[e.key];
    const fine = e.shiftKey ? 0.2 : 1;
    if (game.nudgeAim(turn * ((0.5 * fine * Math.PI) / 180), push * 0.01 * fine)) e.preventDefault();
    return;
  }
  if (k === 'r') {
    if (playing || winOpen) replay();
  } else if (e.key === 'Escape') {
    if (playing && game.cancelKeyboardAim()) return;
    if (playing || winOpen) leavePlay();
    else if (isVisible('levels') || isVisible('settings')) openTitle();
  } else if (e.key === ' ') {
    if (playing) {
      e.preventDefault();
      game.recall();
    }
  } else if (k === 'h') {
    if (playing) void requestHint();
  } else if (k === 'f') {
    if (playing) ffBtn.click();
  } else if (e.key === 'Enter' || k === 'n') {
    if (playing && e.key === 'Enter' && game.fireKeyboardAim()) e.preventDefault();
    else if (winOpen) {
      e.preventDefault();
      ($('#win-actions .btn.primary') as HTMLButtonElement | null)?.click();
    }
  } else if (k === 'm') {
    setMuted(!save.muted);
  }
});

// ---------------------------------------------------------------- boot

function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('play=')) {
    const level = decodeLevel(hash.slice(5));
    if (level) return play(level, { kind: 'custom', fromEditor: false });
    notify('That level link is broken', 'bad');
  } else if (hash.startsWith('edit=')) {
    const level = decodeLevel(hash.slice(5));
    if (level) return openEditor(level);
    notify('That level link is broken', 'bad');
  } else if (hash === 'daily') {
    return void openDaily();
  } else if (hash.startsWith('replay=')) {
    const data = decodeReplay(hash.slice(7));
    if (data) return void openReplay(data);
    notify('That replay link is broken', 'bad');
  }
  openTitle();
}

setMuted(save.muted);
music.setEnabled(save.settings.music, false);
window.addEventListener('hashchange', route);
route();
