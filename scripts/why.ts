import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import type { TimedAction } from '../src/sim/types';
const strat: Record<string, (seed: number) => TimedAction[]> = {
  idle: () => [], curtail: () => [{ tick: 20, action: { type: 'curtail', zone: 'Z02' } }],
  dc: () => [{ tick: 120, action: { type: 'startBackup', zone: 'Z06' } }],
  combo: (s) => [{ tick: 20, action: { type: 'curtail', zone: 'Z02' } }, { tick: 120, action: { type: 'startBackup', zone: 'Z06' } }],
  g3: () => [20, 21, 22].map((t) => ({ tick: t, action: { type: 'setpoint', gen: 'G3', delta: 10 } })),
};
const which = process.argv[2] ?? 'curtail';
for (let i = 1; i <= 40; i++) {
  const seed = i * 7919;
  const sim = Simulation.replay(createCrisis(seed), strat[which](seed));
  if (!sim.state.collapsed) continue;
  const crit = sim.state.alerts.filter((a) => a.level === 'critical' && /TRIPPED|tripped|shedding|BLACKOUT/.test(a.text)).map((a) => `${(a.tick / 10).toFixed(1)} ${a.text.slice(0, 90)}`);
  console.log('seed', seed); crit.forEach((c) => console.log('   ', c));
}
