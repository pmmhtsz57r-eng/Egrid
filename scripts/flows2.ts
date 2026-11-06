import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
// stress state: wind lost, G1/G3 raised, no shedding
for (const strike of ['none','L9','L6','L11']) {
  const sim = new Simulation(createCrisis(1));
  const s = sim.state;
  s.lines.L6.tripped = false;
  if (strike !== 'none') s.lines[strike].tripped = true;
  s.gens.G1.pm = 185; s.gens.G2.pm = 20; s.gens.G3.pm = 78;
  for (const z of Object.values(s.zones)) z.demand *= 1.0;
  (sim as any).solveNetwork();
  console.log(strike.padEnd(5), sim.net.lines.map(l => `${l.id}:${Math.round(s.lines[l.id].flow)}`).join(' '));
}
