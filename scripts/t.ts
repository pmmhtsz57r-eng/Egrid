import { Simulation, DT } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
const sc0 = createCrisis(1);
const base = { ...sc0, events: [], windCurve: [[0, 90], [1, 0], [90, 0]] as [number,number][], demandGrowth: 0, hidden: { incipientFault: 'none', sensorDrift: { sub: 'none', bias: 0 } }, atsFailed: 'none' };
const sim = new Simulation(base);
for (let i = 0; i < 6; i++) console.log(sim.queue({ type: 'setpoint', gen: 'G1', delta: 10 }));
for (let k = 0; k < 200; k++) { sim.step(); if (k % 20 === 0) console.log(k, sim.state.freq.toFixed(2), sim.state.gens.G1.pm.toFixed(0), sim.state.gens.G1.setpoint, sim.state.uflsStage, sim.state.totalServed.toFixed(0)); }
console.log(sim.state.log);
