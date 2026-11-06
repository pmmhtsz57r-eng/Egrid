import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
const sim = new Simulation(createCrisis(1));
const show = (label: string) => console.log(label, sim.net.lines.map(l => `${l.id}:${sim.state.lines[l.id].flow.toFixed(0)}/${l.limit}`).join(' '));
show('t0');
for (const id of ['L9','L6','L11','L13','L12','L14','L1','L2']) {
  const s2 = new Simulation(createCrisis(1));
  s2.state.lines[id].tripped = true; (s2 as any).solveNetwork();
  console.log('trip', id, s2.net.lines.map(l => `${l.id}:${Math.round(s2.state.lines[l.id].loading*100)}`).join(' '));
}
