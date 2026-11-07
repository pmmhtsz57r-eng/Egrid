# BLACKOUT: architecture and plan

BLACKOUT: 90 Seconds to Save a City is a browser game about running a fictional city's electrical grid through a storm. This document covers the architecture, the simulation design, the data model, the scenario, the UI structure and the milestones. The electrical model is described in full in [SIMULATION.md](SIMULATION.md).

## 1. Product thesis

The hook is **"Wait, what is this? Let me try."** Three design decisions follow from it:

1. **Fast start, no account.** One tap on the landing screen starts the emergency. The first 5 seconds teach the controls through the first alarm.
2. **Every outcome can be explained.** The simulation is deterministic, so the Disaster Report doesn't judge you by opinion. It **replays the incident without each of your decisions** and tells you what that decision was worth ("Without it, St. Aurel Hospital would have lost power"). This is the shareable insight, and no other grid game has it.
3. **Challenges you can't fake.** A challenge link holds the seed plus the full decision recording, not a score. The friend's browser replays it and recomputes the score, then gives them *the same storm*.

## 2. Architecture

```
src/
  sim/        Pure TypeScript simulation: types, RNG, DC power flow, engine, bot. No DOM, clock or randomness.
  scenario/   Nova City network (static data) and the seeded "Storm Front" crisis generator.
  scoring/    Score (city stability, rating) and the counterfactual Disaster Report.
  game/       Real-time loop (fixed 0.1 s ticks), challenge-link codec, daily seed, local best scores.
  render/     three.js city: buildings, grid, flow particles, weather, lightning, camera director.
  audio/      Web Audio synthesiser: grid hum locked to frequency, alarms, sirens, relays, score.
  share/      Canvas renderer for the 1080×1350 share card; download, Web Share, copy link.
  ui/         React components: landing, HUD, incident feed, asset panel, results, report.
tests/        Vitest: power flow, engine rules, determinism, balance, scoring, report, challenge links.
```

Dependency rule: `sim` and `scenario` depend on nothing else; `scoring` depends on `sim`; `game` on `sim` and `scoring`; `render`, `audio` and `ui` read state but never change it except through `Simulation.queue(action)`.

**Why plain three.js and not React Three Fiber:** the scene is one imperative object with a per-frame update from the sim state. R3F would add a reconciler and two dependencies for no gain here. React is used for the UI layer, where it fits.

Runtime dependencies: `react`, `react-dom`, `three`. Nothing else.

## 3. Simulation design (summary)

- Fixed step: 0.1 s, 900 ticks for 90 s. Rendering interpolates; the sim never reads the wall clock.
- Network: 11 transmission buses (3 generator buses, 8 substations), 15 lines, 8 transformers, 12 distribution zones.
- Each tick: scenario events, player actions, timers (crews, transfers, backup starts, investigation), demand, topology and islands, island frequency (swing equation with inertia), DC power flow, protections (line thermal, transformer temperature, incipient faults, UFLS, generator frequency and overload trips), governors (droop with ramp limits), critical services (UPS, backup), metrics.
- Determinism: integer PRNG (mulberry32) only in scenario generation; the engine uses `+ - * / sqrt` only, so results are identical across browsers.
- Reproducibility: `Simulation.replay(scenario, recording)` rebuilds any run. A test checks a live run and its replay are byte-identical.

## 4. Data model

See `src/sim/types.ts`. Definitions (`NetworkDef`, `GeneratorDef`, `LineDef`, `SubstationDef`, `ZoneDef`, `CriticalDef`, `BackupDef`, `ScenarioDef`) are static. `SimState` holds the per-tick state. `Action` is a discriminated union of the 14 player actions; `TimedAction = { tick, action }` is the recording unit.

## 5. Scenario: Storm Front (Nova City)

Nova City: 250,000 fictional residents, 3 generation sources (Harbour Gas, Nordwind wind farm, Talsperre hydro dam), 8 substations, 12 distribution zones including 2 hospitals, Railway Network R02, Kern Data Centre (regional 112 call routing), the Hafen industrial district, the Emergency Services HQ and 7 residential districts.

At 0:00 a storm hits. The seed chooses:

| Variable | Options |
| --- | --- |
| First lightning strike | L9, L6 or L11, permanent or transient fault |
| Wind-farm storm shutdown | Early storms (55%): shutdown 8 to 11 s in. Late storms (45%): gusts take a third of the output at about 10 s, full shutdown 30 to 37 s in. Either way it falls to 12 to 22 MW over 12 to 16 s, is announced at 0:00 and again 4 s ahead, and partly recovers later |
| Data-centre generator fuel | 50 to 62 s at full load (start them too early and they run dry mid-storm) |
| Hidden incipient transformer fault | S04, S06 or S01 |
| Lying loading sensor | S03, S07 or S05, over-reads by 50 to 70 points |
| Hospital whose transfer switch failed its test | Central Hospital or St. Aurel |
| Second strike | L13, L12 or L14 at 46 to 56 s |
| Rail rush-hour demand step | 22 to 30 s |
| Data-centre UPS autonomy | 32 to 42 s |

Doing nothing typically ends in automatic load shedding, a stranded railway and (on some seeds) a destroyed transformer or a dark data centre. A test asserts that doing nothing never rates better than C and that a scripted competent operator beats it on every seed.

## 6. Player actions

| Action | Cost and constraint |
| --- | --- |
| Raise or lower generation (±10 MW) | Ramp limits (gas 3 MW/s, hydro 8 MW/s). Gas can run to 110% for 25 s, then trips. More generation moves flow onto lines. |
| Shed a zone | Residents lose power. Reconnecting later causes cold-load pickup (up to +40% for 10 s). |
| Transfer a zone to its alternative feed | 1.5 s interruption; loads the other substation. |
| Curtail the industrial district | Controlled 12 s ramp to process minimum. Shedding it instead is an unsafe trip (−5 points). |
| Exempt a zone from automatic shedding | At most 3; the scheme then sheds others or frequency falls further. |
| Open or close a line | Closing onto a permanent fault trips again and heats the neighbouring transformers. |
| Isolate or energise a transformer | Protects it, but its zones go dark unless transferred. |
| Start backup generation | Hospital and data-centre generators take 6 to 10 s; a failed transfer switch needs a crew first. The data centre (at Südstadt, east end of the west-to-east lines) on its own generators frees ~30 MW where it relieves both the frequency and those lines, for as long as its fuel lasts. |
| Return the data centre to the grid | Stops its generators to save fuel for later; its 30 MW returns to Südstadt. |
| Dispatch a repair crew (2 crews) | Travel time from the depot plus 6 to 10 s of work. Repairs lines, transfer switches, resets tripped transformers once cool. |
| Investigate | 4 s, one at a time. Reveals permanent faults, incipient transformer faults and lying sensors. |
| Deploy the mobile generator (once) | 8 MW, travel time; powers part of a dark zone or offloads a live one. |
| Grid analysis (on an overloaded line) | Free. Shows the three single actions that relieve it most, computed with the same power-flow model. |

No action is always right: generation raises frequency but loads lines; transfers relieve one substation by loading another; shedding stops cascades but darkens homes.

## 7. Scoring and the Disaster Report

City stability (0 to 100): residents kept powered (40), critical services (25), equipment intact (15), frequency quality (10), supply at the end (10), minus 4 per automatic shedding stage, minus the industrial curtailment contract (1 point per 300 MW·s curtailed, at most 6) and minus 5 for an unsafe industrial trip. Frequency quality counts time outside 49.7 to 50.3 Hz, the band where the dial turns amber. A total blackout caps it at 15. Ratings: S Grid Guardian (92+), A Control Room Ace (84+), B Steady Hands (72+), C Held the Line, Barely (58+), D Rolling Blackouts (42+), F Lights Out; a collapse is F Total Blackout.

The report replays the run without each decision (helped or harmed, by how many points and why), with each missed opportunity added, and with no decisions at all ("If nobody had touched the controls"). Each missed opportunity (curtail industry, raise the hydro dam, start the data-centre generators, send a crew to the hospital transfer switch, investigate the gas alarm, the relief tool's best answer to the first overload, raise the gas station when frequency is critical) is placed two seconds after the alert that cued it in the player's own run, never earlier. Clicks on the same generator, each within 3 s of the last, are one decision. Curtail and protect are switches, so "without this decision" removes that press and every later press of the same switch. Up to 60 decisions are measured one by one; the comparison with doing nothing always covers all of them. All figures are labelled as fictional simulation results. There are no casualty numbers.

## 8. UI structure

- **Landing:** live 3D city at night, BLACKOUT title, "90 SECONDS. ONE CITY. YOUR DECISIONS. CAN YOU SAVE NOVA CITY?", operator name field (optional), START EMERGENCY, Daily Challenge, and a challenge banner when opened from a friend's link.
- **Crisis HUD:** Most Urgent lists threats in a stable order (level, then first seen) with a hint computed by the same model as Grid analysis. A hint never pushes a transformer past its rating or a known-faulty one past 70%, never leaves the overload it targets uncleared, only names units in the island on the dial, and never fights the frequency. Hints only move load within one island, check line loadings before a transfer, give back fuel-limited or paid load (data-centre generators, curtailment) only when the island's surplus covers it, never lower generation ahead of a forecast wind drop, and never lower an island's last controllable unit while it leans on the data centre's fuel. Overload hints name the tool (Grid analysis) rather than the answer, and there is no reconnect hint: when to restore shed districts is the player's call. A test replays every hinted action against the same run without it and checks it never sets off automatic shedding, loses a generator or collapses the grid within 5 s. Tapping the item opens the asset that holds the hinted control; the player still decides; countdown, grid frequency dial, generation versus demand, residents without power, critical services strip; incident feed (left on desktop, top sheet on mobile); asset panel with actions for whatever is selected (right on desktop, bottom sheet on mobile); asset list tab for touch screens.
- **3D city:** buildings per zone with lit windows that black out, hospitals with beacons, the railway with moving trains, substations with status rings, transmission lines with flowing particles coloured by loading, wind turbines that stop, rain, fog and lightning; the camera drifts to each new incident and to whatever you select.
- **Results:** cinematic stability counter, rating, people kept powered, critical services, infrastructure lost, decisions that helped, decisions that hurt, missed opportunities, "if nobody had acted", share card preview with Download, Share and Copy challenge link, Replay same storm, New storm.

## 9. Game modes

| Mode | Status |
| --- | --- |
| 1. 90-Second Crisis | Built. |
| 4. Daily Challenge | Built: one seed per UTC day for everyone, best score saved locally; comparison is through challenge links. A global leaderboard needs a server (see below). |
| 2. Engineer Mode | Architecture ready: the same engine at 0.25× speed with the relief tool, line flows and temperatures always visible. Not built. |
| 3. Fault Hunt | Architecture ready: investigation, hidden faults and crews exist; needs scenarios where faults are the main mechanic. Not built. |
| 5. Multiplayer | Not built and not faked. Plan: a server runs the same deterministic engine; clients send `TimedAction`s; lockstep at 10 Hz is trivial because the state is a pure function of the recording. |

## 10. Milestones

1. Plan and architecture (this file). Done.
2. Simulation engine and tests. Done.
3. Playable 3D city.
4. The 90-second experience: HUD, actions, alerts, camera, timer.
5. Report and sharing: counterfactual report, share card, challenge links, daily seed.
6. Polish: graphics, sound, mobile layout, performance tiers.
7. Browser tests (Playwright, desktop and phone) and fixes.

## 11. Strategic notes (pushback)

- **Modes 2 to 5 are a distraction until Mode 1 retains.** The daily challenge is the only one worth building now because it multiplies sharing at almost no cost. Engineer Mode and Fault Hunt are content on the same engine; build them only if players replay Mode 1.
- **A global leaderboard is the next highest-leverage feature**, not multiplayer. It needs a small server that re-simulates submitted recordings (the anti-cheat is free because the engine is deterministic).
- **"Lives protected" was renamed "People kept powered".** The model has no casualty mechanics; a lives number would be invented, and invented death tolls are what gets a game like this called tasteless when it goes viral.
- **The share image should carry the challenge, not just the score.** The card says "Same storm. Your decisions." and the link reproduces the exact storm.
