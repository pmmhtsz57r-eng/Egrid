import { Simulation } from '../src/sim/engine';
import { botRecording } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
const sc = createCrisis(4);
const rec = botRecording(sc);
for (let t = 200; t <= 262; t += 4) {
  const sim = Simulation.replay(sc, rec, t);
  const s = sim.state;
  console.log((t/10).toFixed(1), s.freq.toFixed(2), Object.entries(s.gens).map(([k,g])=>`${k} pm${g.pm.toFixed(0)} pe${g.pe.toFixed(0)} sp${g.setpoint} f${g.freq.toFixed(2)}`).join(' | '), 'srv', s.totalServed.toFixed(0), 'islands?', Object.values(s.subs).map(x=>x.freq.toFixed(1)).join(','));
}
