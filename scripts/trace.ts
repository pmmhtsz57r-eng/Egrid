import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import type { TimedAction } from '../src/sim/types';
const seed = Number(process.argv[2] ?? 7919);
const which = process.argv[3] ?? 'curtail';
const recs: Record<string, TimedAction[]> = {
  idle: [], curtail: [{ tick: 20, action: { type: 'curtail', zone: 'Z02' } }],
  dc: [{ tick: 120, action: { type: 'startBackup', zone: 'Z06' } }],
};
const sc = createCrisis(seed);
const sim = new Simulation(sc);
const rec = recs[which];
let k = 0; let lastA = 0;
while (!sim.state.ended) {
  while (k < rec.length && rec[k].tick === sim.state.tick) sim.queue(rec[k++].action);
  sim.step();
  const s = sim.state;
  if (s.tick % 10 === 0) {
    const g = Object.entries(s.gens).map(([id, x]) => `${id}:${x.online ? x.pe.toFixed(0) + '/' + x.setpoint.toFixed(0) : 'X'}`).join(' ');
    const lines = Object.entries(s.lines).filter(([, l]) => l.tripped || l.loading > 0.95).map(([id, l]) => `${id}${l.tripped ? 'T' : (l.loading * 100).toFixed(0)}`).join(',');
    console.log(s.time.toFixed(0).padStart(3), s.freq.toFixed(2), 'gen', s.totalGen.toFixed(0), 'dem', s.totalDemand.toFixed(0), g, '|', lines);
  }
  for (; lastA < s.alerts.length; lastA++) if (s.alerts[lastA].level === 'critical') console.log('   !', s.alerts[lastA].text);
}
