import { botRecording } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
import { buildReport } from '../src/scoring/report';
const sc = createCrisis(Number(process.argv[2] ?? 3));
const rec = botRecording(sc);
const t = performance.now();
const r = buildReport(sc, rec.filter((_, i) => i % 3 === 0));
console.log('ms', (performance.now() - t).toFixed(0), 'decisions', r.decisions);
console.log(JSON.stringify({ ...r, outcome: { ...r.outcome, critical: undefined }, idle: r.idle.stability }, null, 1));
