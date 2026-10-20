# Orbit Slingshot

A gravity puzzle for the browser. Drag to pull back, release to launch, and bend your probe's path around planets, moons, black holes, repulsors and wormholes to reach the beacon.

**Play:** https://ezekielwachira.github.io/orbit-slingshot/

## Features

- **16 campaign levels** that introduce moons, black holes, repulsors (they push), wormholes and stardust
- **Stars:** 3 for a one-shot delivery that collects all stardust; fewer for extra shots or missed stardust
- **Daily Challenge:** a new procedurally generated level each day (the same for everyone), with streaks and a shareable result
- **Level editor:** place and drag bodies, wormholes and stardust, test-play, check that the level is solvable, and share it as a link (the level lives in the URL, so no server is needed)
- **Hints:** a solver running in a Web Worker finds a working shot and shows it as a gold ghost (using one caps the level at two stars)
- **Best route:** your best winning shot appears as a faint gold line when you replay a level
- **Fast-forward** for long orbits, a slow-motion camera on arrival, and synthesized sound
- **Settings:** longer aim preview, screen shake, gravity grid, best route

## Run locally

```bash
npm install
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run verify` | Brute-force every level: proves it is solvable and that a perfect (all-stardust) run exists. Pass level numbers to check a few: `node scripts/verify-levels.ts 11 12` |

## Controls

| Input | Action |
| --- | --- |
| Drag + release | Aim and launch |
| `H` | Hint |
| `F` | Toggle fast-forward |
| `Space` | Recall probe mid-flight |
| `R` | Restart level |
| `M` | Mute |
| `Esc` | Back to menu |

In the editor: drag to move, scroll to resize the selection, `Delete` to remove it.

## Share links

| Link | Opens |
| --- | --- |
| `…/#daily` | Today's daily challenge |
| `…/#play=<level>` | A shared custom level |
| `…/#edit=<level>` | A shared level in the editor |

## Code map

| File | Role |
| --- | --- |
| `src/physics.ts` | Fixed-step simulation, shared by the game, the worker and the verify script |
| `src/solver.ts` | Random-search solver with robustness scoring |
| `src/daily.ts` | Seeded daily level generator (solver-checked) |
| `src/share.ts` | Compact, sanitised level encoding for URLs |
| `src/game.ts` | Rendering, input, camera, effects and the editor canvas |
| `src/main.ts` | Menus, modes, saving, editor UI, sharing and hints |
| `src/levels.ts` | Campaign levels on a 1600×900 world |

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the level check, builds and deploys on every push to `main`. If any level can't be solved, the deploy stops.
