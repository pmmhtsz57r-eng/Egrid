import { Simulation } from '../src/sim/engine';
import { runBot } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
const N = Number(process.argv[2] ?? 20);
const summary = (sim: Simulation) => {
  const m = sim.state.metrics;
  const crit = Object.entries(m.criticalDown).filter(([, v]) => v > 0.5).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(',');
  return `srv ${(m.servedEnergy / m.demandEnergy * 100).toFixed(0)}% res ${(m.residentSeconds / 90 / 2500).toFixed(0)}% ${sim.state.collapsed ? 'COLLAPSE@' + (sim.state.collapseTick / 10).toFixed(0) : '        '} crit[${crit}] dmg[${Object.entries(sim.state.subs).filter(([, t]) => t.damaged).map(([k]) => k).join(',')}]`;
};
for (let seed = 1; seed <= N; seed++) {
  const sc = createCrisis(seed);
  const idle = Simulation.replay(sc, []);
  const bot = runBot(sc, { reactionTicks: Number(process.env.RT ?? 10) });
  console.log(String(seed).padStart(3), 'idle:', summary(idle).padEnd(70), '| bot:', summary(bot), bot.recording.length);
}
