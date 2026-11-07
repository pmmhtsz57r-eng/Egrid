import type { Simulation } from '../sim/engine';

/**
 * Scoring. Every figure is computed from the simulation state; nothing is estimated or invented.
 * "People" are the fictional residents of Nova City. No casualty figures exist in this model.
 */

export interface CriticalResult {
  id: string;
  name: string;
  downtime: number;
  protected: boolean;
  dependants: number;
}

export interface Outcome {
  stability: number;
  /** Time-averaged residents with power. */
  peoplePowered: number;
  peoplePoweredPct: number;
  peakDark: number;
  energyServedPct: number;
  /** Share of demand being served at the final second. */
  powerRestoredPct: number;
  critical: CriticalResult[];
  criticalProtected: number;
  infrastructureLost: string[];
  collapsed: boolean;
  collapseTime: number;
  minFreq: number;
  uflsShedMW: number;
  unsafeTrip: boolean;
  grade: string;
  title: string;
  breakdown: { label: string; points: number; max: number }[];
}

const CRITICAL_WEIGHT: Record<string, number> = { H1: 7, H2: 7, DC: 5, ES: 3, R02: 3 };
/** Seconds of outage after which a critical service scores zero. */
const CRITICAL_TOLERANCE = 20;
export const CURTAIL_MWS_PER_POINT = 300;

export const RATINGS: { min: number; grade: string; title: string }[] = [
  { min: 92, grade: 'S', title: 'GRID GUARDIAN' },
  { min: 84, grade: 'A', title: 'CONTROL ROOM ACE' },
  { min: 72, grade: 'B', title: 'STEADY HANDS' },
  { min: 58, grade: 'C', title: 'HELD THE LINE, BARELY' },
  { min: 42, grade: 'D', title: 'ROLLING BLACKOUTS' },
  { min: 0, grade: 'F', title: 'LIGHTS OUT' },
];

export function rate(stability: number, collapsed: boolean) {
  if (collapsed) return { grade: 'F', title: 'TOTAL BLACKOUT' };
  return RATINGS.find((r) => stability >= r.min)!;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function score(sim: Simulation): Outcome {
  const s = sim.state;
  const m = s.metrics;
  const n = sim.net;
  const duration = Math.max(s.time, 1e-6);

  const energy = m.demandEnergy > 0 ? m.servedEnergy / m.demandEnergy : 0;
  const peoplePowered = m.residentSeconds / duration;

  const critical: CriticalResult[] = n.zones
    .filter((z) => z.critical)
    .map((z) => ({
      id: z.critical!.id,
      name: z.critical!.name,
      downtime: m.criticalDown[z.critical!.id],
      protected: m.criticalDown[z.critical!.id] < 0.5,
      dependants: z.critical!.dependants,
    }));

  const lost: string[] = [];
  for (const sub of n.substations) if (s.subs[sub.id].damaged) lost.push(`Transformer ${sub.id} ${sub.name} destroyed`);
  for (const g of n.generators) if (!s.gens[g.id].online) lost.push(`${g.name} tripped, out for the rest of the incident`);
  // outages of critical services are reported under critical services, not here

  let finalDemand = 0;
  let finalServed = 0;
  for (const z of n.zones) {
    const zs = s.zones[z.id];
    const base = zs.demand / (1 + zs.coldLoad);
    finalDemand += base;
    if (zs.served) finalServed += base;
  }
  const restored = finalDemand > 0 ? finalServed / finalDemand : 0;

  const pPeople = 40 * clamp01((peoplePowered / n.population - 0.5) / 0.5);
  const pCritical = critical.reduce((a, c) => a + (CRITICAL_WEIGHT[c.id] ?? 4) * (1 - clamp01(c.downtime / CRITICAL_TOLERANCE)), 0);
  const destroyed = n.substations.filter((x) => s.subs[x.id].damaged).length;
  const tripped = n.generators.filter((g) => !s.gens[g.id].online).length;
  const pEquipment = Math.max(0, 15 - 6 * destroyed - 5 * tripped);
  const pFreq = 10 * clamp01(1 - m.freqOutside / duration) * (m.minFreq < 49.0 ? 0.5 : 1);
  const pEnd = 10 * restored;
  const pUfls = -4 * s.uflsStage;
  // the curtailment contract is paid per MWh: about 1 point per 300 MW·s, at most 6
  const pCurtail = -Math.min(6, m.curtailedMWs / CURTAIL_MWS_PER_POINT);
  let stability = pPeople + pCritical + pEquipment + pFreq + pEnd + pUfls + pCurtail - (m.unsafeTrip ? 5 : 0);
  if (s.collapsed) stability = Math.min(stability, 15);
  stability = Math.max(0, Math.min(100, Math.round(stability)));
  const r = rate(stability, s.collapsed);

  return {
    stability,
    peoplePowered: Math.round(peoplePowered / 100) * 100,
    peoplePoweredPct: peoplePowered / n.population,
    peakDark: Math.round(m.peakDark),
    energyServedPct: energy,
    powerRestoredPct: restored,
    critical,
    criticalProtected: critical.filter((c) => c.protected).length,
    infrastructureLost: lost,
    collapsed: s.collapsed,
    collapseTime: s.collapsed ? s.collapseTick / 10 : -1,
    minFreq: m.minFreq,
    uflsShedMW: m.uflsShed,
    unsafeTrip: m.unsafeTrip,
    grade: r.grade,
    title: r.title,
    breakdown: [
      { label: 'Residents kept powered', points: Math.round(pPeople), max: 40 },
      { label: "Critical services", points: Math.round(pCritical), max: 25 },
      { label: 'Equipment intact', points: Math.round(pEquipment), max: 15 },
      { label: 'Frequency quality', points: Math.round(pFreq), max: 10 },
      { label: 'Supply at the end', points: Math.round(pEnd), max: 10 },
      ...(pUfls ? [{ label: 'Automatic load shedding', points: pUfls, max: 0 }] : []),
      ...(pCurtail <= -0.5 ? [{ label: 'Industrial curtailment paid', points: Math.round(pCurtail), max: 0 }] : []),
      ...(m.unsafeTrip ? [{ label: 'Unsafe industrial trip', points: -5, max: 0 }] : []),
    ],
  };
}
