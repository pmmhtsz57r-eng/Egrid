import { Simulation } from './engine';
import type { Action, ScenarioDef, TimedAction } from './types';

/**
 * A scripted "competent operator" used by tests and balancing scripts. It only sees what the
 * player sees (alerts, measured loadings, investigation results, the relief tool) and acts at
 * most once per second, like a quick human.
 */
export function runBot(scenario: ScenarioDef, opts: { reactionTicks?: number } = {}): Simulation {
  const sim = new Simulation(scenario);
  const every = opts.reactionTicks ?? 10;
  while (!sim.done) {
    if (sim.state.tick % every === 0) {
      const a = decide(sim);
      if (a) sim.queue(a);
    }
    sim.step();
  }
  return sim;
}

export function botRecording(scenario: ScenarioDef): TimedAction[] {
  return runBot(scenario).recording;
}

function decide(sim: Simulation): Action | null {
  const s = sim.state;
  const n = sim.net;
  const ok = (a: Action) => sim.check(a).ok;
  // 1. hospital with a failed transfer switch: send a crew early
  for (const z of n.zones) if (s.zones[z.id].atsFailed && s.time > 7 && ok({ type: 'dispatchCrew', target: z.id })) return { type: 'dispatchCrew', target: z.id };
  // 2. overloaded lines: best relief
  const over = n.lines.filter((l) => s.lines[l.id].loading > 1.0).sort((a, b) => s.lines[b.id].loading - s.lines[a.id].loading);
  for (const l of over) {
    const opts = sim.reliefOptions(l.id).filter((o) => o.worstOther < 1.0);
    if (opts.length) return opts[0].action;
  }
  // 3. investigate alarms
  for (const a of [...s.alerts].reverse()) {
    if (!a.subject || s.known[a.subject]) continue;
    if ((a.key.startsWith('gas-') || a.key.startsWith('load-')) && ok({ type: 'investigate', target: a.subject })) return { type: 'investigate', target: a.subject };
  }
  // 4. known incipient fault: get its loading below the threshold
  for (const sub of n.substations) {
    const info = s.known[sub.id];
    if (!info || !info.includes('incipient') || s.subs[sub.id].damaged) continue;
    if (s.subs[sub.id].loading > 0.66) {
      const zones = n.zones.filter((z) => sim.feedingSub(z.id) === sub.id && s.zones[z.id].served);
      for (const z of zones) if (z.alternate && ok({ type: 'transfer', zone: z.id })) return { type: 'transfer', zone: z.id };
      for (const z of zones) if (z.critical?.backup && ok({ type: 'startBackup', zone: z.id })) return { type: 'startBackup', zone: z.id };
      for (const z of zones) if (z.kind === 'industrial' && !s.zones[z.id].curtailing) return { type: 'curtail', zone: z.id };
    }
  }
  // 5. hot transformers
  for (const sub of n.substations) {
    const t = s.subs[sub.id];
    if (t.temp < 118 || t.damaged || t.tripped) continue;
    const zones = n.zones.filter((z) => sim.feedingSub(z.id) === sub.id && s.zones[z.id].served);
    for (const z of zones) if (z.alternate && ok({ type: 'transfer', zone: z.id })) return { type: 'transfer', zone: z.id };
  }
  // 6. data centre: start its generators once the UPS warning is out
  if (s.time > 11 && ok({ type: 'startBackup', zone: 'Z06' })) return { type: 'startBackup', zone: 'Z06' };
  // 7. frequency
  const f = s.freq;
  if (f > 0 && f < 49.75) {
    if (!s.zones.Z02.curtailing) return { type: 'curtail', zone: 'Z02' };
    for (const g of ['G3', 'G1']) if (ok({ type: 'setpoint', gen: g, delta: 10 }) && s.gens[g].setpoint < n.generators.find((x) => x.id === g)!.capacity) return { type: 'setpoint', gen: g, delta: 10 };
  }
  if (f > 50.25) for (const g of ['G1', 'G3']) if (ok({ type: 'setpoint', gen: g, delta: -10 })) return { type: 'setpoint', gen: g, delta: -10 };
  // 8. tripped transformers: send a crew to reset once cool
  for (const sub of n.substations) if (s.subs[sub.id].tripped && s.subs[sub.id].temp < 95 && ok({ type: 'dispatchCrew', target: sub.id })) return { type: 'dispatchCrew', target: sub.id };
  // 9. restore shed zones when there is headroom
  if (f > 49.9) {
    const head = n.generators.reduce((a, g) => a + (s.gens[g.id].online ? (g.kind === 'wind' ? 0 : g.capacity - s.gens[g.id].pm) : 0), 0);
    for (const z of n.zones) {
      const zs = s.zones[z.id];
      if (zs.breaker || !ok({ type: 'restore', zone: z.id })) continue;
      if (head > zs.demand * 1.5 + 5) return { type: 'restore', zone: z.id };
    }
  }
  return null;
}
