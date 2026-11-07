import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
import { runBot } from '../src/sim/bot';
import type { TimedAction } from '../src/sim/types';
const N = Number(process.argv[2] ?? 40);
const strategies: Record<string, (s: number) => TimedAction[]> = {
  idle: () => [],
  curtail: () => [{ tick: 20, action: { type: 'curtail', zone: 'Z02' } }],
  dc: () => [{ tick: 120, action: { type: 'startBackup', zone: 'Z06' } }],
  g3: () => [20, 21, 22].map((t) => ({ tick: t, action: { type: 'setpoint', gen: 'G3', delta: 10 } })),
  g3curt: () => [...[20, 21, 22].map((t) => ({ tick: t, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } })), { tick: 150, action: { type: 'curtail' as const, zone: 'Z02' } }],
  g3dc: () => [...[20, 21, 22].map((t) => ({ tick: t, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } })), { tick: 120, action: { type: 'startBackup' as const, zone: 'Z06' } }],
  g1g3: () => [20, 21, 22].flatMap((t) => [{ tick: t, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } }, { tick: t + 30, action: { type: 'setpoint' as const, gen: 'G1', delta: 10 } }]),
  combo: (s) => [{ tick: 20, action: { type: 'curtail', zone: 'Z02' } }, { tick: 120, action: { type: 'startBackup', zone: 'Z06' } }, { tick: 75, action: { type: 'dispatchCrew', target: createCrisis(s).atsFailed } }],
};
const res: Record<string, number[]> = {};
let collapses: Record<string, number> = {};
for (let seed = 1; seed <= N; seed++) {
  const sc = createCrisis(seed * 7919);
  for (const [k, f] of Object.entries(strategies)) {
    const sim = Simulation.replay(sc, f(seed * 7919));
    (res[k] ??= []).push(score(sim).stability);
    if (sim.state.collapsed) collapses[k] = (collapses[k] ?? 0) + 1;
  }
  const b = runBot(sc); (res.bot ??= []).push(score(b).stability); if (b.state.collapsed) collapses.bot = (collapses.bot ?? 0) + 1;
}
for (const [k, v] of Object.entries(res)) console.log(k.padEnd(8), (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), 'min', Math.min(...v), 'collapses', collapses[k] ?? 0);
