# The BLACKOUT electrical model

BLACKOUT uses a **simplified, documented** model of a power system. It is built so that every outcome has a physical cause you can trace. It is **not** an engineering-grade grid simulator and must not be used to plan or operate real networks.

All constants live at the top of `src/sim/engine.ts`.

## Time

- Fixed step `DT = 0.1 s`; the crisis is 900 ticks.
- Order of work inside one tick: player actions (queued during the previous tick) → scenario events → timers → demand → network solution → protections → governors → critical services → metrics.
- All engine state, including its bookkeeping (event cursor, relay timers), lives in `SimState`, so a state snapshot resumes exactly.
- The engine never reads the clock or `Math.random`. Scenario variation comes from a seeded integer PRNG (mulberry32) used once, when the scenario is built. The engine uses only `+ − × ÷ √` and rounding (no `Math.pow`, `exp` or trigonometry), all of which IEEE 754 defines exactly, so the same recording gives bit-identical results in every browser.

## Network

- 11 buses: 3 generator buses and 8 substation buses (110 kV level, notional). 15 lines with a reactance `x` (per unit, 100 MVA base) and a thermal limit in MW.
- Each substation has one transformer (rating in MW) feeding 1 or 2 distribution zones. 9 zones have a normally-open tie to a second substation.
- **Islands.** Every tick the closed, untripped lines define connected components. An island with no running generator is dead.

## Power flow (DC approximation)

For each island the engine solves `B·θ = P` (bus 0 of the island as angle reference, Gaussian elimination with partial pivoting) and sets the flow on line *i–j* to `(θi − θj) / x`. This is the classic DC load flow: lossless lines, flat 1.0 pu voltages, small angles, no reactive power. Tripping a line redistributes its flow over the remaining paths in inverse proportion to their reactance, which is the mechanism behind every cascade in the game.

## Frequency

Each island has one frequency, the inertia-weighted average of its machines. It follows the aggregated swing equation

`df/dt = f0 · (ΣPm − ΣPload) / (2 · Σ(H·S))`

with `H` the inertia constant and `S` the rating of each machine (wind has a near-zero synthetic inertia). Load falls with frequency (`LOAD_DAMPING = 1.5`, i.e. 1.5% load per 1% frequency). The instantaneous electrical output of each machine is its mechanical power minus its inertia share of the imbalance, so the injections in the DC flow always balance.

## Generators

- **Governors**: droop of 4% (2 Hz for 100% output). Upward response limited to 8% (gas) or 12% (hydro) of rating. Downward the full droop range applies, down to the unit's minimum stable output (gas 20 MW, hydro 10 MW), and over-speed control closes valves at up to 100% of rating per second, so an island left with too much generation settles instead of tripping. Above 51 Hz a unit may drop below its minimum stable output to no-load (load rejection).
- **No load left**: a unit whose island has no load drops to speed-no-load on its own breaker and waits to be reconnected.
- **Synchro-check**: closing a line between two live islands is refused when their frequencies differ by more than 0.5 Hz.
- **Wind in an island**: the wind farm's inverters are grid-following. If a line trip leaves it in an island with no synchronous machine, it disconnects at once rather than trying to hold a frequency it cannot set, and reconnects (ramping from zero) as soon as it is joined again to an island with a synchronous machine.
- **Ramp limits**: gas 3 MW/s, hydro 8 MW/s, wind 20 MW/s (wind follows the available-wind curve and can only curtail).
- **Emergency rating**: the gas station may run to 110% for 25 s, then trips on exhaust over-temperature.
- **Frequency protection**: a machine trips after 1 s below 47.5 Hz or above 52 Hz.

## Protection

- **Lines**: a thermal accumulator rises at `(loading² − 1) / 5` per second above 100% and trips the line at 1 (120% trips in about 11 s, 150% in 4 s); above 200% it trips at once. Operator-opened lines and lines tripped on overload can be reclosed; lines with a permanent fault trip again and heat the transformers at both ends by 12 °C.
- **Transformers**: oil temperature follows `T∞ = 35 + 70·L²` °C with a 10 s time constant (accelerated for the 90-second format). Alarm at 110 °C, insulation damage above 125 °C, protection trip at 140 °C. A tripped transformer needs a crew to reset it once below 90 °C. Health reaching zero destroys it.
- **Incipient fault** (hidden, one transformer per seed): above 70% loading a fault-progress counter rises at `(L − 0.7)/6` per second. At 0.35 a gas-in-oil (Buchholz) alarm appears; at 1 the transformer is destroyed. Investigation reveals it.
- **Lying sensor** (hidden, one substation per seed): the displayed loading over-reads by 50 to 70 points. The temperature reading is honest, so an attentive operator can spot it; investigation confirms it.
- **Under-frequency load shedding (UFLS)**: stage 1 at 49.0 Hz, stage 2 at 48.7 Hz, stage 3 at 48.4 Hz, each after 0.3 s below its threshold. Stages are time-graded: after one stage operates, the next can operate only 0.2 s later and only if the frequency is still below its own threshold, so a fast dip does not dump all three stages in one instant. Hospitals, the data centre, emergency services and industry are not in the scheme; operators can exempt up to three further zones.

## Demand

- Base demand 290 MW for 250,000 fictional residents, growing 5% over the 90 s (evening peak), plus a 6 MW rail step.
- **Cold-load pickup**: a zone reconnected after more than 3 s off draws up to 40% extra, decaying over 10 s.
- **Curtailment**: the industrial district ramps to its 9 MW process minimum over 12 s and is paid per MW·s curtailed (a score cost); disconnecting it outright is an unsafe trip.

## Critical services

| Service | Load | Backup | Battery |
| --- | --- | --- | --- |
| Central Hospital (H1) | 6 MW | 6 MW, auto, 8 s start | 12 s |
| St. Aurel Hospital (H2) | 5 MW | 5 MW, auto, 8 s start | 12 s |
| Kern Data Centre, 112 call routing (DC), at Südstadt | 30 MW | 32 MW, manual, 10 s start, fuel for 50 to 62 s | 32 to 42 s |
| Emergency Services HQ (ES) | 3 MW | 3 MW, auto, 6 s start | 20 s |
| Railway R02 | 14 MW | none; degraded below 95.5% supply voltage | none |

One hospital's automatic transfer switch has failed its test (seeded): its backup cannot start until a crew repairs it. A service running on its own generators while the grid is healthy draws nothing from the grid, which is how the data centre can free about 30 MW.

Substation voltage is a proxy: `V = 1 − 0.07·L²` of transformer loading.

## Crews, investigation and the mobile generator

Two crews start at the depot and drive at 9 map units per second (storm conditions), then work 6 to 10 s. One analyst investigates one asset at a time (4 s); a line's finding is withdrawn if the line trips again later. One 8 MW mobile generator can be sent once.

A shift accepts at most 400 decisions, so every recording fits in a challenge link.

## Where the difficulty comes from

The gas station is in the west and most of the load that loses wind supply is in the north and east. When the wind farm shuts down, the replacement power has to cross the west-to-east lines L6, L9 and L12. Raising the gas station or freeing load in the west (curtailing the industrial district) fixes the frequency but pushes more power east over those lines. Raising the eastern hydro dam, or cutting load in the east (the data centre at Südstadt running on its own generators), helps both. The frequency warning lists generation headroom east first and flags western headroom. Grid analysis on any overloaded line evaluates each single action with the same flow model.

## Scoring

See `src/scoring/score.ts` and section 7 of [ARCHITECTURE.md](ARCHITECTURE.md). "People kept powered" is the time-averaged number of fictional residents with supply. There are no casualty figures anywhere in the model.

## Known simplifications

- No reactive power, voltage collapse, losses or AC stability; voltage is a loading proxy.
- One frequency per island; no inter-area oscillation.
- Thermal time constants are shortened to fit 90 seconds.
- Protection is idealised (no relay mis-operation), so outcomes are caused by the network, the storm or the operator, never by chance.
