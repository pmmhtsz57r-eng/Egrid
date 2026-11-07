import { runBot } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
const sim = runBot(createCrisis(Number(process.argv[2])));
const until = Number(process.argv[3] ?? 90);
const ev = [...sim.state.log.map(l => ({ t: l.tick / 10, s: `   >> ${l.ok ? '' : 'FAILED '}${l.note}` })), ...sim.state.alerts.map(a => ({ t: a.tick / 10, s: `[${a.level}] ${a.text}` }))].sort((a, b) => a.t - b.t);
for (const e of ev) if (e.t <= until) console.log(e.t.toFixed(1), e.s);
