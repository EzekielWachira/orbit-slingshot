# Orbit Slingshot

A gravity puzzle for the browser. Drag to pull back, release to launch, and bend your probe's path around planets, moons and black holes to reach the beacon.

- 10 hand-built levels with stars for fewer shots
- Warped space-time grid, glowing trails, particle bursts and a slow-motion camera on arrival
- Synthesized sound effects (no audio files)
- Works with mouse or touch; progress is saved in `localStorage`

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
| `npm run verify` | Brute-force every level to prove it is solvable |

## Controls

| Input | Action |
| --- | --- |
| Drag + release | Aim and launch |
| `R` | Restart level |
| `Space` | Recall probe mid-flight |
| `M` | Mute |
| `Esc` | Level select |

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and deploys on every push to `main`.
In the repo on GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions** once.

## Adding levels

Levels live in `src/levels.ts` on a 1600×900 world. Run `npm run verify` after editing; CI fails the deploy if any level has no solution.
