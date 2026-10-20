// Brute-forces launch angle, power and launch time for every level and reports how
// many shots reach the target. Run with: npm run verify
import { LEVELS } from '../src/levels.ts';
import { MAX_SPEED, simulate } from '../src/physics.ts';

const ANGLE_STEPS = 360;
const POWER_STEPS = 30;
const TIMES = [0, 1, 2, 3, 4, 5];

let failed = false;
LEVELS.forEach((level, i) => {
  const moving = level.bodies.some((b) => b.orbit);
  const times = moving ? TIMES : [0];
  let hits = 0;
  let total = 0;
  const hitTimes = new Set<number>();
  for (const t0 of times) {
    for (let a = 0; a < ANGLE_STEPS; a++) {
      const ang = (a / ANGLE_STEPS) * Math.PI * 2;
      for (let s = 1; s <= POWER_STEPS; s++) {
        const speed = (s / POWER_STEPS) * MAX_SPEED;
        total++;
        if (simulate(level, Math.cos(ang) * speed, Math.sin(ang) * speed, t0) === 'target') {
          hits++;
          hitTimes.add(t0);
        }
      }
    }
  }
  const pct = ((hits / total) * 100).toFixed(2);
  const timing = moving ? `  (solvable at t0 = ${[...hitTimes].join(', ') || 'none'})` : '';
  console.log(`${String(i + 1).padStart(2)}. ${level.name.padEnd(16)} ${String(hits).padStart(5)} hits  ${pct}%${timing}`);
  if (hits === 0) failed = true;
});

if (failed) {
  console.error('\nAt least one level has no solution.');
  process.exit(1);
}
