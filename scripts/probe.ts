import { Simulation } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import type { TimedAction } from '../src/sim/types';

const seed = Number(process.argv[2] ?? 1);
const sc = createCrisis(seed);
const plan: TimedAction[] = JSON.parse(process.argv[3] ?? '[]');
const sim = new Simulation(sc);
const sorted = [...plan].sort((a, b) => a.tick - b.tick);
let i = 0;
let ai = 0;
console.log('seed', seed, 'strike', sc.events.filter(e=>e.type==='lineFault').map(e=>(e as any).line), 'hidden', sc.hidden, 'ats', sc.atsFailed);
while (!sim.done) {
  while (i < sorted.length && sorted[i].tick <= sim.state.tick) sim.queue(sorted[i++].action);
  sim.step();
  const s = sim.state;
  while (ai < s.alerts.length) { const a = s.alerts[ai++]; console.log(`  ${(a.tick/10).toFixed(1)} [${a.level}] ${a.text}`); }
  if (s.tick % 50 === 0) {
    const g = Object.entries(s.gens).map(([k, v]) => `${k}:${v.online ? v.pe.toFixed(0) : 'X'}`).join(' ');
    const lines = Object.entries(s.lines).filter(([, l]) => l.loading > 0.8 || l.tripped).map(([k, l]) => `${k}:${l.tripped ? 'T' : Math.round(l.loading * 100)}`).join(' ');
    const subs = Object.entries(s.subs).map(([k, t]) => `${k}:${Math.round(t.loading * 100)}/${Math.round(t.temp)}${t.tripped ? 'T' : ''}${t.damaged ? 'D' : ''}`).join(' ');
    console.log(`t=${s.time.toFixed(0)} f=${s.freq.toFixed(2)} dem=${s.totalDemand.toFixed(0)} srv=${s.totalServed.toFixed(0)} ${g} | ${lines} | ${subs}`);
  }
}
const m = sim.state.metrics;
console.log('served', (m.servedEnergy / m.demandEnergy).toFixed(3), 'resident', (m.residentSeconds / 90 / 250000).toFixed(3), 'crit', JSON.stringify(m.criticalDown), 'collapsed', sim.state.collapsed, sim.state.collapseTick/10);
