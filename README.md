# BLACKOUT: 90 Seconds to Save a City

A storm hits the power grid of Nova City, a fictional European city of 250,000 people. You are the operator on shift. You have 90 seconds.

BLACKOUT is a browser game built on a real (simplified) power-system model: DC power flow, grid frequency with inertia and governors, overload protection, transformer heating, automatic load shedding, backup generators and repair crews. Every outcome has a physical cause. At the end, the **Disaster Report** replays your incident without each of your decisions and tells you exactly what each one was worth.

- Architecture, data model, scenario and milestones: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- The electrical model and its limits: [docs/SIMULATION.md](docs/SIMULATION.md)

## Run it

Needs Node.js 20.19 or newer.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # simulation, scoring, report and challenge-link tests
npm run build      # type-check and production build into dist/
npm run preview    # serve the production build
npm run e2e        # browser smoke test (Playwright + Chromium), screenshots in e2e/out
```

Address options: `?speed=4` plays the same deterministic incident faster (for testing), `?q=low` forces the low graphics tier, `#c=…` is a challenge link.

The production build is static (relative paths), so `dist/` can be hosted anywhere: GitHub Pages, Netlify, an S3 bucket.

## How to play

1. **Watch the frequency.** 50 Hz means supply matches demand. Below 49.0 Hz the grid sheds whole districts on its own.
2. **Stop overloads before they cascade.** A tripped line pushes its power onto its neighbours. Open any overloaded line and use **Grid analysis** to see which single action relieves it most.
3. **Protect what matters.** Two hospitals, Railway R02, the data centre that routes 112 emergency calls, and the emergency services HQ.

Every action has a cost: more generation loads the lines, transfers load the neighbouring substation, shedding darkens homes, reconnecting causes a demand surge, crews take time to drive. There is no single correct solution, and doing nothing usually ends in automatic load shedding, a stranded railway or worse.

## Modes

| Mode | Status |
| --- | --- |
| 90-Second Crisis | Playable. A new storm each time; replay any storm by seed. |
| Daily Storm | Playable. The same seed for everyone each UTC day; compare by challenge link. |
| Engineer Mode, Fault Hunt | Designed (see architecture), not built. |
| Multiplayer | Not built, and not faked. The deterministic engine makes lockstep play straightforward later. |

## Sharing

The results screen draws a 1080×1350 incident-report card (Download, or the native Share sheet on phones) and a **challenge link**. The link carries the seed and your full decision recording, not your score: the receiver's browser replays it to recompute your score and then gives them the same storm.

## Project layout

```
src/sim        deterministic engine (no DOM, clock or randomness)
src/scenario   Nova City network and the seeded Storm Front crisis
src/scoring    score, rating and the counterfactual Disaster Report (runs in a Web Worker)
src/game       real-time loop, challenge links, local storage
src/render     three.js city
src/audio      Web Audio synthesis (no samples, no licensed music)
src/share      share-card renderer
src/ui         React screens and HUD
tests          Vitest
e2e            Playwright smoke test
scripts        balancing and debugging tools (npx tsx scripts/balance.ts)
```

Runtime dependencies: `react`, `react-dom`, `three`.

## Honesty notes

Nova City, its people and every number in the game are fictional. The model is simplified and is not an engineering tool. The game reports **people kept powered**, never lives or casualties, because the model contains no such mechanics.
