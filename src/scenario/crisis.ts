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
  const dropStart = round(rng.range(4, 7), 1);
  const dropEnd = round(dropStart + rng.range(12, 16), 1);
  const windFloor = round(rng.range(12, 22), 1);
  const lull = round(rng.range(55, 65), 1);
  const windCurve: [number, number][] = [
    [0, 92],
    [dropStart, 90],
    [round(dropStart + (dropEnd - dropStart) * 0.4, 1), round(90 - (90 - windFloor) * 0.55, 1)],
    [dropEnd, windFloor],
    [lull, windFloor],
    [round(lull + 8, 1), round(windFloor + rng.range(18, 28), 1)],
    [90, round(windFloor + rng.range(20, 30), 1)],
  ];

  const incipientFault = rng.pick(['S04', 'S06', 'S01'] as const);
  const driftSub = rng.pick(['S03', 'S07', 'S05'] as const);
  const driftBias = round(rng.range(0.5, 0.7), 2);
  const atsFailed = rng.pick(['Z03', 'Z09'] as const);
  const secondStrike = rng.pick(['L13', 'L12', 'L14'] as const);
  const secondT = round(rng.range(46, 56), 1);
  const railT = round(rng.range(22, 30), 1);
  const dcUps = rng.int(32, 42);

  const hospital = NOVA_CITY.zones.find((z) => z.id === atsFailed)!;
  const lineName = (id: string) => NOVA_CITY.lines.find((l) => l.id === id)!.name;

  const events: ScenarioEvent[] = [
    { t: 0, type: 'notice', level: 'warning', text: 'Severe storm front over Nova City. Gusts above wind-farm cut-out speed expected.', subject: 'G2' },
    { t: 1.5, type: 'lineFault', line: strike, permanent: strikePermanent, cause: 'lightning strike' },
    { t: round(dropStart - 1.5, 1), type: 'notice', level: 'warning', text: 'Nordwind turbines entering storm shutdown. Output falling.', subject: 'G2' },
    { t: 7, type: 'notice', level: 'warning', text: `${hospital.critical!.name}: backup generator failed its automatic transfer test. It will not start by itself.`, subject: atsFailed },
    { t: 11, type: 'notice', level: 'warning', text: `Kern Data Centre: UPS string B offline, ${dcUps} s autonomy. On-site generators set to manual start. Carries regional 112 call routing.`, subject: 'Z06' },
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
  };
}
