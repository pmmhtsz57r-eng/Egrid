import { Simulation } from '../src/sim/engine';
import { runBot } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
const t0 = performance.now();
for (let seed = 1; seed <= 15; seed++) {
  const sc = createCrisis(seed);
  const i = score(Simulation.replay(sc, []));
  const b = score(runBot(sc));
  const b3 = score(runBot(sc, { reactionTicks: 30 }));
  console.log(seed, 'idle', i.stability, i.grade, '| bot', b.stability, b.grade, '| slow bot', b3.stability, b3.grade, b3.infrastructureLost.join('; '));
}
const t1 = performance.now();
for (let k = 0; k < 20; k++) Simulation.replay(createCrisis(1), []);
console.log('ms/replay', ((performance.now() - t1) / 20).toFixed(1), 'total', (t1 - t0).toFixed(0));
