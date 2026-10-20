// Brute-forces launch angle, power and launch time for every level and reports how
// many shots reach the target, and whether a perfect (all-stardust) run exists.
// Run with: npm run verify   (or: node scripts/verify-levels.ts 11 12 to check some levels)
import { LEVELS } from '../src/levels.ts';
import { MAX_SPEED, hasMovingBodies, simulate } from '../src/physics.ts';

const ANGLE_STEPS = 360;
const POWER_STEPS = 30;
const TIMES = [0, 1, 2, 3, 4, 5];

const only = process.argv.slice(2).map(Number);
let failed = false;

LEVELS.forEach((level, i) => {
  if (only.length && !only.includes(i + 1)) return;
  const moving = hasMovingBodies(level);
  const times = moving ? TIMES : [0];
  const dustTotal = level.dust?.length ?? 0;
  let hits = 0;
  let perfect = 0;
  let total = 0;
  const hitTimes = new Set<number>();
  for (const t0 of times) {
    for (let a = 0; a < ANGLE_STEPS; a++) {
      const ang = (a / ANGLE_STEPS) * Math.PI * 2;
      for (let s = 1; s <= POWER_STEPS; s++) {
        const speed = (s / POWER_STEPS) * MAX_SPEED;
        total++;
        const r = simulate(level, Math.cos(ang) * speed, Math.sin(ang) * speed, t0);
        if (r.outcome === 'target') {
          hits++;
          hitTimes.add(t0);
          if (r.dust === dustTotal) perfect++;
        }
      }
    }
  }
  const pct = ((hits / total) * 100).toFixed(2);
  const dust = dustTotal ? `  all ${dustTotal} dust: ${perfect}` : '';
  const timing = moving ? `  (t0 = ${[...hitTimes].join(', ') || 'none'})` : '';
  console.log(`${String(i + 1).padStart(2)}. ${level.name.padEnd(16)} ${String(hits).padStart(5)} hits  ${pct.padStart(5)}%${dust}${timing}`);
  if (hits === 0 || (dustTotal && perfect === 0)) failed = true;
});

if (failed) {
  console.error('\nAt least one level has no solution (or no perfect run).');
  process.exit(1);
}
