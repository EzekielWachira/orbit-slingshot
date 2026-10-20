import type { LevelDef } from './physics.ts';

export const LEVELS: LevelDef[] = [
  {
    name: 'First Light',
    hint: 'Drag anywhere to pull back, then let go to launch.',
    launch: { x: 180, y: 700 },
    target: { x: 1400, y: 300, r: 42 },
    bodies: [{ x: 800, y: 560, r: 55, hue: 200 }],
  },
  {
    name: 'In the Way',
    hint: 'Gravity bends your path. Use it to curve around the planet.',
    launch: { x: 180, y: 450 },
    target: { x: 1420, y: 450, r: 38 },
    bodies: [{ x: 800, y: 450, r: 80, hue: 20, rings: true }],
  },
  {
    name: 'Twin Worlds',
    hint: 'Two pulls at once. Watch the preview line.',
    launch: { x: 160, y: 780 },
    target: { x: 1450, y: 150, r: 36 },
    bodies: [
      { x: 620, y: 470, r: 65, hue: 140 },
      { x: 1080, y: 300, r: 50, hue: 280 },
    ],
  },
  {
    name: 'Hairpin',
    hint: 'The direct route is blocked. Swing around the giant.',
    launch: { x: 200, y: 200 },
    target: { x: 200, y: 720, r: 36 },
    bodies: [
      { x: 230, y: 460, r: 60, hue: 330 },
      { x: 950, y: 460, r: 95, hue: 45, rings: true },
    ],
  },
  {
    name: 'Moon Dance',
    hint: 'Moons move. Timing matters.',
    launch: { x: 180, y: 450 },
    target: { x: 1430, y: 450, r: 36 },
    bodies: [
      { x: 800, y: 450, r: 70, hue: 190 },
      { r: 22, hue: 60, orbit: { around: 0, radius: 200, period: 7, phase: 0 } },
    ],
  },
  {
    name: 'Narrow Gap',
    hint: 'Thread the needle, then bend past the sentinel.',
    launch: { x: 150, y: 450 },
    target: { x: 1460, y: 450, r: 34 },
    bodies: [
      { x: 760, y: 230, r: 110, hue: 10 },
      { x: 760, y: 670, r: 110, hue: 220 },
      { x: 1180, y: 450, r: 45, hue: 120 },
    ],
  },
  {
    name: 'Event Horizon',
    hint: 'Nothing comes back from the black hole. Get close, but not too close.',
    launch: { x: 180, y: 760 },
    target: { x: 1400, y: 160, r: 36 },
    bodies: [{ x: 800, y: 450, r: 18, gm: 3.2e7, kind: 'blackhole', hue: 30 }],
  },
  {
    name: 'Binary',
    hint: 'Two worlds locked in orbit around nothing at all.',
    launch: { x: 160, y: 450 },
    target: { x: 1450, y: 450, r: 36 },
    bodies: [
      { r: 48, hue: 300, orbit: { cx: 800, cy: 450, radius: 150, period: 6, phase: 0 } },
      { r: 48, hue: 170, orbit: { cx: 800, cy: 450, radius: 150, period: 6, phase: Math.PI } },
    ],
  },
  {
    name: 'Long Way Round',
    hint: 'Home is close, but the wall is not going anywhere.',
    launch: { x: 150, y: 790 },
    target: { x: 150, y: 120, r: 36 },
    bodies: [
      { x: 130, y: 450, r: 62, hue: 0 },
      { x: 330, y: 450, r: 58, hue: 25 },
      { x: 1050, y: 450, r: 105, hue: 205, rings: true },
    ],
  },
  {
    name: 'Grand Tour',
    hint: 'Everything you have learned, all at once.',
    launch: { x: 140, y: 140 },
    target: { x: 1470, y: 760, r: 34 },
    bodies: [
      { x: 520, y: 380, r: 70, hue: 160 },
      { r: 20, hue: 50, orbit: { around: 0, radius: 160, period: 5, phase: 1 } },
      { x: 1000, y: 620, r: 16, gm: 2.2e7, kind: 'blackhole', hue: 280 },
      { x: 1250, y: 260, r: 60, hue: 15, rings: true },
    ],
  },
];

/** Backdrop for the title screen: a probe circling a ringed giant. */
export const DEMO_LEVEL: LevelDef = {
  name: 'Demo',
  hint: '',
  launch: { x: 800, y: 250 },
  target: { x: -9999, y: -9999, r: 1 },
  bodies: [
    { x: 800, y: 470, r: 85, hue: 25, rings: true },
    { r: 20, hue: 200, orbit: { around: 0, radius: 360, period: -18, phase: 2 } },
  ],
};
