import './style.css';
import { Game } from './game.ts';
import { DEMO_LEVEL, LEVELS } from './levels.ts';
import { starsFor } from './physics.ts';
import { sfx } from './audio.ts';

const STORAGE_KEY = 'orbit-slingshot:v1';

interface Save {
  stars: number[];
  muted: boolean;
}

function loadSave(): Save {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { stars: Array.isArray(raw.stars) ? raw.stars : [], muted: !!raw.muted };
  } catch {
    return { stars: [], muted: false };
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

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const screens = {
  title: $('#title'),
  levels: $('#levels'),
  hud: $('#hud'),
  win: $('#win'),
};
const hint = $('#hint');
const toast = $('#toast');
const levelLabel = $('#level-label');
const shotsLabel = $('#shots');
const levelGrid = $('#level-grid');
const muteBtn = $<HTMLButtonElement>('#btn-mute');

let toastTimer = 0;

const game = new Game($<HTMLCanvasElement>('#game'), {
  onShot(shots) {
    shotsLabel.textContent = String(shots);
    if (shots > 0) hint.classList.add('faded');
  },
  onMessage(text) {
    toast.textContent = text;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1400);
  },
  onWin(shots) {
    const i = game.levelIndex;
    const stars = starsFor(shots);
    save.stars[i] = Math.max(save.stars[i] ?? 0, stars);
    persist();
    showWin(i, shots, stars);
  },
});

function show(...names: (keyof typeof screens)[]) {
  for (const [name, el] of Object.entries(screens)) el.classList.toggle('visible', names.includes(name as keyof typeof screens));
}

function isUnlocked(i: number) {
  return i === 0 || (save.stars[i - 1] ?? 0) > 0;
}

function starMarkup(n: number) {
  return [0, 1, 2].map((i) => `<span class="star ${i < n ? 'on' : ''}">★</span>`).join('');
}

function renderLevelGrid() {
  levelGrid.innerHTML = LEVELS.map((lvl, i) => {
    const locked = !isUnlocked(i);
    return `<button class="level-card ${locked ? 'locked' : ''}" data-level="${i}" ${locked ? 'disabled' : ''}>
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <span class="name">${locked ? 'Locked' : lvl.name}</span>
      <span class="stars">${starMarkup(save.stars[i] ?? 0)}</span>
    </button>`;
  }).join('');
}

function playLevel(i: number) {
  game.loadLevel(i, LEVELS[i]);
  game.active = true;
  levelLabel.innerHTML = `<b>${String(i + 1).padStart(2, '0')}</b> ${LEVELS[i].name}`;
  hint.textContent = LEVELS[i].hint;
  hint.classList.remove('faded');
  show('hud');
}

function openTitle() {
  game.active = false;
  game.startAttract(DEMO_LEVEL);
  show('title');
}

function openLevels() {
  game.active = false;
  game.startAttract(DEMO_LEVEL);
  renderLevelGrid();
  show('levels');
}

function showWin(i: number, shots: number, stars: number) {
  game.active = false;
  const last = i === LEVELS.length - 1;
  $('#win-title').textContent = last ? 'Grand Tour complete!' : 'Probe delivered';
  $('#win-stars').innerHTML = starMarkup(stars);
  $('#win-shots').textContent = `${shots} ${shots === 1 ? 'shot' : 'shots'}${stars === 3 ? ' · perfect' : ''}`;
  $('#btn-next').hidden = last;
  show('hud', 'win');
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

// ---- wiring

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) sfx.click();
});

$('#btn-play').addEventListener('click', () => playLevel(firstUnfinished()));
$('#btn-levels').addEventListener('click', openLevels);
$('#btn-levels-back').addEventListener('click', openTitle);
levelGrid.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLButtonElement>('.level-card');
  if (card && !card.disabled) playLevel(Number(card.dataset.level));
});
$('#btn-restart').addEventListener('click', () => playLevel(game.levelIndex));
$('#btn-menu').addEventListener('click', openLevels);
muteBtn.addEventListener('click', () => setMuted(!save.muted));
$('#btn-next').addEventListener('click', () => playLevel(game.levelIndex + 1));
$('#btn-retry').addEventListener('click', () => playLevel(game.levelIndex));
$('#btn-win-levels').addEventListener('click', openLevels);

window.addEventListener('keydown', (e) => {
  const winOpen = screens.win.classList.contains('visible');
  const playing = screens.hud.classList.contains('visible') && !winOpen;
  if (e.key === 'r' || e.key === 'R') {
    if (playing || winOpen) playLevel(game.levelIndex);
  } else if (e.key === 'Escape') {
    if (playing || winOpen) openLevels();
    else if (screens.levels.classList.contains('visible')) openTitle();
  } else if (e.key === ' ') {
    if (playing) {
      e.preventDefault();
      game.recall();
    }
  } else if (e.key === 'Enter' || e.key === 'n' || e.key === 'N') {
    if (winOpen && game.levelIndex < LEVELS.length - 1) playLevel(game.levelIndex + 1);
  } else if (e.key === 'm' || e.key === 'M') {
    setMuted(!save.muted);
  }
});

setMuted(save.muted);
openTitle();
