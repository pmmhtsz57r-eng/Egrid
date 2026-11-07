import { createRng, round } from '../sim/rng';
import type { ScenarioDef, ScenarioEvent } from '../sim/types';
import { NOVA_CITY } from './novaCity';

export const CRISIS_DURATION = 90;

/**
 * "Storm Front": the 90-second crisis. The seed varies the details (which line the
 * lightning hits, how fast the wind farm drops out, which transformer is secretly failing,
 * which sensor lies, which hospital's transfer switch failed), never the rules.
 */
export function createCrisis(seed: number): ScenarioDef {
  const rng = createRng(seed);

  const strike = rng.pick(['L9', 'L6', 'L11'] as const);
  const strikePermanent = rng.next() < 0.5;
  const dropStart0 = round(rng.range(4, 7), 1);
  const dropLen = rng.range(12, 16);
  const windFloor = round(rng.range(12, 22), 1);
  const lull0 = round(rng.range(55, 65), 1);
  const rise1 = rng.range(18, 28);
  const rise2 = rng.range(20, 30);
  const incipientFault = rng.pick(['S04', 'S06', 'S01'] as const);
  const driftSub = rng.pick(['S03', 'S07', 'S05'] as const);
  const driftBias = round(rng.range(0.5, 0.7), 2);
  const atsFailed = rng.pick(['Z03', 'Z09'] as const);
  const secondStrike = rng.pick(['L13', 'L12', 'L14'] as const);
  const secondT = round(rng.range(46, 56), 1);
  const railT = round(rng.range(22, 30), 1);
  const dcUps = rng.int(32, 42);
  // On some storms the wind farm holds on for half a minute before it shuts down, so an
  // opening played from memory lands in the wrong half of the storm.
  const late = rng.next() < 0.45;
  const dcFuel = rng.int(50, 62);
  // early storms: shutdown 8 to 11 s in, announced 4 s ahead; late storms: about half a minute later
  const dropStart = late ? round(dropStart0 + rng.range(24, 30), 1) : round(dropStart0 + 4, 1);
  const dropEnd = round(dropStart + dropLen, 1);
  const lull = Math.max(lull0, round(dropEnd + 6, 1));
  // late storms open with gusts that already knock a third of the turbines out
  const early: [number, number][] = late ? [[round(dropStart0 + 2, 1), 90], [round(dropStart0 + 9, 1), 58], [dropStart, 56]] : [[dropStart, 90]];
  const windCurve: [number, number][] = [
    [0, 92],
    ...early,
    [round(dropStart + (dropEnd - dropStart) * 0.4, 1), round((late ? 56 : 90) - ((late ? 56 : 90) - windFloor) * 0.55, 1)],
    [dropEnd, windFloor],
    [lull, windFloor],
    [Math.min(89, round(lull + 8, 1)), round(windFloor + rise1, 1)],
    [90, round(windFloor + rise2, 1)],
  ];

  const hospital = NOVA_CITY.zones.find((z) => z.id === atsFailed)!;
  const lineName = (id: string) => NOVA_CITY.lines.find((l) => l.id === id)!.name;

  const events: ScenarioEvent[] = [
    { t: 0, type: 'notice', level: 'warning', text: `Severe storm front over Nova City. ${late ? 'Gusts are tripping some wind turbines now; full cut-out speed expected in about half a minute.' : 'Gusts above wind-farm cut-out speed expected within seconds.'}`, subject: 'G2' },
    { t: 1.5, type: 'lineFault', line: strike, permanent: strikePermanent, cause: 'lightning strike' },
    { t: round(dropStart - 4, 1), type: 'notice', level: 'warning', text: 'Nordwind turbines entering storm shutdown in a few seconds. Output will fall to about a fifth.', subject: 'G2' },
    { t: 7, type: 'notice', level: 'warning', text: `${hospital.critical!.name}: backup generator failed its automatic transfer test. It will not start by itself.`, subject: atsFailed },
    { t: 11, type: 'notice', level: 'warning', text: `Kern Data Centre: UPS string B offline, ${dcUps} s autonomy. On-site generators set to manual start, fuel for ${dcFuel} s. Carries regional 112 call routing.`, subject: 'Z06' },
    { t: railT, type: 'demandStep', zone: 'Z05', mw: 6, reason: 'Evening rush: extra trains in service on R02' },
    { t: secondT, type: 'lineFault', line: secondStrike, permanent: true, cause: 'storm damage (tree contact)' },
    { t: round(secondT - 3, 1), type: 'notice', level: 'warning', text: `Second storm cell approaching ${lineName(secondStrike)}.`, subject: secondStrike },
  ];
  events.sort((a, b) => a.t - b.t);

  return {
    id: 'storm-front',
    title: 'Storm Front',
    seed,
    duration: CRISIS_DURATION,
    network: NOVA_CITY,
    windCurve,
    demandGrowth: 0.05,
    events,
    hidden: { incipientFault, sensorDrift: { sub: driftSub, bias: driftBias } },
    atsFailed,
    dcUps,
    dcFuel,
  };
}
