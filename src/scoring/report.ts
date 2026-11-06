import { Simulation, fmtTime } from '../sim/engine';
import type { Action, ScenarioDef, TimedAction } from '../sim/types';
import { score, type Outcome } from './score';

/**
 * The Disaster Report. Because the simulation is deterministic, the report does not guess
 * which decisions mattered: it replays the incident without each decision (and with each
 * missed opportunity added) and measures the difference in city stability.
 */

export interface DecisionImpact {
  tick: number;
  time: string;
  text: string;
  delta: number;
  consequence: string;
}

export interface Report {
  outcome: Outcome;
  idle: Outcome;
  helped: DecisionImpact[];
  harmed: DecisionImpact[];
  missed: DecisionImpact[];
  decisions: number;
}

const THRESHOLD = 2;

export function describeAction(sim: Simulation, a: Action): string {
  const L = (id: string) => sim.label(id);
  switch (a.type) {
    case 'setpoint': return `${a.delta > 0 ? 'Raised' : 'Lowered'} ${L(a.gen)} output by ${Math.abs(a.delta)} MW`;
    case 'shed': return `Shed ${L(a.zone)}`;
    case 'restore': return `Reconnected ${L(a.zone)}`;
    case 'transfer': return `Transferred ${L(a.zone)} to its alternative feed`;
    case 'curtail': return `Curtailed ${L(a.zone)}`;
    case 'protect': return `Exempted ${L(a.zone)} from automatic shedding`;
    case 'isolateLine': return `Opened line ${a.line} ${L(a.line)}`;
    case 'closeLine': return `Closed line ${a.line} ${L(a.line)}`;
    case 'isolateSub': return `Isolated transformer ${a.sub} ${L(a.sub)}`;
    case 'energiseSub': return `Energised transformer ${a.sub} ${L(a.sub)}`;
    case 'startBackup': return `Started backup generation at ${L(a.zone)}`;
    case 'dispatchCrew': return `Sent a repair crew to ${L(a.target)}`;
    case 'investigate': return `Investigated ${a.target} ${L(a.target)}`;
    case 'mobileGen': return `Deployed the mobile generator to ${L(a.zone)}`;
  }
}

/** Plain-language difference between two outcomes: what changes if the decision is reversed. */
function consequence(withIt: Outcome, without: Outcome): string {
  const bits: string[] = [];
  if (without.collapsed && !withIt.collapsed) bits.push(`the city would have suffered a total blackout at ${fmtTime(without.collapseTime)}`);
  if (withIt.collapsed && !without.collapsed) bits.push('the total blackout would have been avoided');
  const dc = without.criticalProtected - withIt.criticalProtected;
  const lostWithout = without.critical.filter((c) => !c.protected && withIt.critical.find((x) => x.id === c.id)!.protected).map((c) => c.name);
  const savedWithout = without.critical.filter((c) => c.protected && !withIt.critical.find((x) => x.id === c.id)!.protected).map((c) => c.name);
  if (dc < 0 && lostWithout.length) bits.push(`${lostWithout.join(' and ')} would have lost power`);
  if (savedWithout.length) bits.push(`${savedWithout.join(' and ')} would have kept power`);
  const people = without.peoplePowered - withIt.peoplePowered;
  if (Math.abs(people) >= 2000) bits.push(`${Math.abs(Math.round(people / 1000))}k ${people < 0 ? 'fewer' : 'more'} residents would have had power on average`);
  const lostDiff = without.infrastructureLost.filter((x) => !withIt.infrastructureLost.includes(x) && !x.includes('without power'));
  if (lostDiff.length) bits.push(lostDiff[0].replace(/^Transformer/, 'transformer'));
  const savedEq = withIt.infrastructureLost.filter((x) => !without.infrastructureLost.includes(x) && !x.includes('without power'));
  if (savedEq.length) bits.push(`it caused: ${savedEq[0].toLowerCase()}`);
  if (!bits.length) bits.push(`city stability would have been ${without.stability} instead of ${withIt.stability}`);
  return bits.slice(0, 2).join('; ');
}

function play(sc: ScenarioDef, rec: TimedAction[]) {
  return score(Simulation.replay(sc, rec));
}

/** Candidate interventions a strong operator might have made, timed to when the cue appeared. */
function opportunities(sc: ScenarioDef, played: Simulation, rec: TimedAction[]): TimedAction[] {
  const s = played.state;
  const out: TimedAction[] = [];
  const did = (pred: (a: Action) => boolean) => rec.some((r) => pred(r.action));
  const cue = (prefix: string) => s.alerts.find((a) => a.key.startsWith(prefix))?.tick;

  const ats = sc.atsFailed;
  if (!did((a) => a.type === 'dispatchCrew' && a.target === ats)) out.push({ tick: 72, action: { type: 'dispatchCrew', target: ats } });
  if (!did((a) => a.type === 'startBackup' && a.zone === 'Z06')) out.push({ tick: 112, action: { type: 'startBackup', zone: 'Z06' } });
  if (!did((a) => a.type === 'curtail')) out.push({ tick: 50, action: { type: 'curtail', zone: 'Z02' } });
  if (!did((a) => a.type === 'setpoint' && a.gen === 'G3' && a.delta > 0)) {
    for (const t of [60, 61, 62]) out.push({ tick: t, action: { type: 'setpoint', gen: 'G3', delta: 10 } });
  }
  const gas = s.alerts.find((a) => a.key.startsWith('gas-'));
  if (gas?.subject && !did((a) => a.type === 'investigate' && a.target === gas.subject)) out.push({ tick: gas.tick + 2, action: { type: 'investigate', target: gas.subject } });
  // the relief tool's first suggestion for the first overload the player saw
  const ol = s.alerts.find((a) => a.key.startsWith('ol-'));
  if (ol?.subject) {
    const at = Simulation.replay(sc, rec, ol.tick + 1);
    const best = at.reliefOptions(ol.subject, 1)[0];
    if (best) out.push({ tick: ol.tick + 10, action: best.action });
  }
  const fcrit = cue('f-crit');
  if (fcrit !== undefined && !did((a) => a.type === 'setpoint' && a.delta > 0 && a.gen === 'G1')) {
    out.push({ tick: fcrit + 5, action: { type: 'setpoint', gen: 'G1', delta: 10 } });
  }
  return out;
}

function groupKey(t: TimedAction) {
  // Repeated clicks on the same generator within 3 s are one decision.
  return t.action.type === 'setpoint' ? `sp-${t.action.gen}-${Math.sign(t.action.delta)}-${Math.floor(t.tick / 30)}` : `${t.tick}-${JSON.stringify(t.action)}`;
}

export function buildReport(sc: ScenarioDef, rec: TimedAction[], maxDecisions = 30): Report {
  const played = Simulation.replay(sc, rec);
  const outcome = score(played);
  const idle = play(sc, []);

  // only actions that actually did something are decisions
  const applied = played.state.log.filter((l) => l.ok);
  const appliedRec = rec.filter((r) => applied.some((l) => l.tick === r.tick && JSON.stringify(l.action) === JSON.stringify(r.action)));
  const groups = new Map<string, TimedAction[]>();
  for (const r of appliedRec) {
    const k = groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const helped: DecisionImpact[] = [];
  const harmed: DecisionImpact[] = [];
  const entries = [...groups.values()].slice(0, maxDecisions);
  for (const g of entries) {
    const without = play(sc, rec.filter((r) => !g.includes(r)));
    const delta = outcome.stability - without.stability;
    const first = g[0];
    const total = first.action.type === 'setpoint' ? g.reduce((a, r) => a + (r.action as { delta: number }).delta, 0) : 0;
    const text = first.action.type === 'setpoint'
      ? describeAction(played, { ...first.action, delta: total })
      : describeAction(played, first.action);
    const impact: DecisionImpact = { tick: first.tick, time: fmtTime(first.tick / 10), text, delta, consequence: '' };
    if (delta >= THRESHOLD) {
      impact.consequence = `Without it, ${consequence(outcome, without)}.`;
      helped.push(impact);
    } else if (delta <= -THRESHOLD) {
      impact.consequence = `Without it, ${consequence(outcome, without)}.`;
      harmed.push(impact);
    }
  }
  helped.sort((a, b) => b.delta - a.delta);
  harmed.sort((a, b) => a.delta - b.delta);

  const missed: DecisionImpact[] = [];
  const seen = new Set<string>();
  const cands = opportunities(sc, played, rec);
  // G3 +10 x3 is one opportunity
  const grouped = new Map<string, TimedAction[]>();
  for (const c of cands) {
    const k = c.action.type === 'setpoint' ? `sp-${c.action.gen}` : JSON.stringify(c.action);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(c);
  }
  for (const [k, g] of grouped) {
    if (seen.has(k)) continue;
    seen.add(k);
    const withIt = play(sc, [...rec, ...g]);
    const delta = withIt.stability - outcome.stability;
    if (delta < THRESHOLD) continue;
    const first = g[0];
    const total = first.action.type === 'setpoint' ? g.reduce((a, r) => a + (r.action as { delta: number }).delta, 0) : 0;
    const text = first.action.type === 'setpoint' ? describeAction(played, { ...first.action, delta: total }) : describeAction(played, first.action);
    missed.push({ tick: first.tick, time: fmtTime(first.tick / 10), text, delta, consequence: `Stability ${withIt.stability} instead of ${outcome.stability}${withIt.collapsed !== outcome.collapsed && !withIt.collapsed ? ', and no total blackout' : ''}.` });
  }
  missed.sort((a, b) => b.delta - a.delta);

  return { outcome, idle, helped: helped.slice(0, 4), harmed: harmed.slice(0, 4), missed: missed.slice(0, 3), decisions: groups.size };
}
