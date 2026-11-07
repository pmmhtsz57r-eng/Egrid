import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
const seed = Number(process.argv[2] ?? 7919);
const sc = createCrisis(seed);
for (const [k, rec] of Object.entries({ idle: [], dc: [{ tick: 130, action: { type: 'startBackup' as const, zone: 'Z06' } }] })) {
  const sim = Simulation.replay(sc, rec);
  const o = score(sim);
  console.log(k, o.stability, o.breakdown.map((b) => `${b.label}:${b.points}`).join(' '), '| crit', o.critical.filter((c) => !c.protected).map((c) => c.id).join(','));
  console.log('   ', sim.state.alerts.filter((a) => a.level === 'critical').map((a) => `${(a.tick / 10).toFixed(0)} ${a.text.slice(0, 60)}`).join('\n    '));
}
