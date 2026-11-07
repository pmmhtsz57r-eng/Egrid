import type { Action } from '../sim/types';
import { FREQ_BAND_HIGH, FREQ_BAND_LOW, LINE_HEAT_K, XFMR_DAMAGE_START, XFMR_ALARM, XFMR_RESET_TEMP, XFMR_TAU, XFMR_TRIP, XFMR_AMBIENT, XFMR_RISE, windAt, type Simulation } from '../sim/engine';

export type Level = 'critical' | 'warning' | 'info';

export interface Threat {
  key: string;
  id: string;
  level: Level;
  title: string;
  detail: string;
  eta?: number;
  /** One-tap suggestion computed from the same model as Grid analysis. */
  suggest?: { action: Action; label: string };
}

/** Seconds until a line's overcurrent protection trips at the present loading. */
export function lineEta(heat: number, loading: number) {
  if (loading <= 1) return Infinity;
  if (loading > 2) return 0;
  return Math.max(0, (1 - heat) / ((loading * loading - 1) / LINE_HEAT_K));
}

/** Seconds until a transformer reaches its trip temperature at the present loading. */
export function xfmrEta(temp: number, loading: number) {
  const tss = XFMR_AMBIENT + XFMR_RISE * loading * loading;
  if (tss <= XFMR_TRIP) return Infinity;
  if (temp >= XFMR_TRIP) return 0;
  return -XFMR_TAU * Math.log((tss - XFMR_TRIP) / (tss - temp));
}

const secs = (t: number) => (t === Infinity ? '' : t < 1 ? 'now' : `${Math.ceil(t)} s`);

/** What the operator should look at, most urgent first. Derived only from visible state. */
export function threats(sim: Simulation): Threat[] {
  const s = sim.state;
  const n = sim.net;
  const out: Threat[] = [];
  if (s.ended) return out;

  const f = s.freq;
  const deficit = s.totalServed - s.totalGen;
  if (f > 0 && f < FREQ_BAND_LOW + 0.1) {
    out.push({
      key: 'freq-low', id: 'G1', level: f < 49.2 ? 'critical' : 'warning',
      title: `Frequency ${f.toFixed(2)} Hz`,
      detail: `${deficit > 1 ? `Short by ${Math.round(deficit)} MW. ` : ''}${headroom(sim)}${curtailHint(sim)} ${f < 49.0 ? 'Automatic shedding is operating.' : 'Automatic shedding at 49.0 Hz.'}`,
      eta: f < 49.2 ? 3 : 10,
    });
  } else if (f > FREQ_BAND_HIGH) {
    out.push({ key: 'freq-high', id: 'G1', level: f > 51 ? 'critical' : 'warning', title: `Frequency ${f.toFixed(2)} Hz`, detail: 'Too much generation: time outside 49.7 to 50.3 Hz costs points. Lower output; generators trip at 52 Hz.', eta: 8 });
  }

  const wind = n.generators.find((g) => g.kind === 'wind');
  if (wind && s.gens[wind.id].online && f >= 49.6) {
    const gs = s.gens[wind.id];
    const ahead = windAt(sim.scenario.windCurve, s.time + 10);
    if (gs.pe - ahead > 12) out.push({ key: 'wind-drop', id: wind.id, level: 'warning', title: `${wind.short} output falling`, detail: `Forecast ${Math.round(ahead)} MW in 10 s (now ${Math.round(gs.pe)}). Raise other generation before the frequency drops.`, eta: 15 });
  }

  for (const l of n.lines) {
    const ls = s.lines[l.id];
    if (!ls.closed || ls.tripped) continue;
    if (ls.loading > 1) {
      const eta = lineEta(ls.heat, ls.loading);
      out.push({ key: `ol-${l.id}`, id: l.id, level: 'critical', title: `${l.id} overloaded ${Math.round(ls.loading * 100)}%`, detail: `${l.name}. Trips in ${secs(eta)}. Open Grid analysis.`, eta });
    } else if (ls.loading > 0.92) {
      out.push({ key: `nl-${l.id}`, id: l.id, level: 'warning', title: `${l.id} at ${Math.round(ls.loading * 100)}%`, detail: `${l.name} is close to its limit.`, eta: 30 });
    }
  }

  for (const sub of n.substations) {
    const t = s.subs[sub.id];
    if (t.damaged) continue;
    if (t.tripped) {
      const ready = t.temp < XFMR_RESET_TEMP;
      out.push({ key: `tr-${sub.id}`, id: sub.id, level: 'warning', title: `${sub.id} ${sub.name} tripped`, detail: ready ? 'Cool enough: send a crew to reset it.' : `Cooling (${Math.round(t.temp)} °C). Transfer its zones meanwhile.`, eta: 20 });
      continue;
    }
    if (!t.closed || !t.energised) continue;
    // forecast from the oil temperature trend (the temperature probe is always honest)
    const eta = xfmrEta(t.temp, t.loading);
    if (t.temp > XFMR_ALARM - 5 || eta < 25) {
      const damaging = t.temp > XFMR_DAMAGE_START;
      const detail = eta !== Infinity
        ? `Trips at ${XFMR_TRIP} °C in ${secs(eta)}.${damaging ? ' Insulation is being damaged now.' : ''} Move load away.`
        : damaging ? `Above ${XFMR_DAMAGE_START} °C the insulation is being damaged. Move load away.` : 'Hot, but settling below the trip temperature.';
      out.push({ key: `hot-${sub.id}`, id: sub.id, level: damaging || eta < 10 ? 'critical' : 'warning', title: `${sub.id} transformer ${Math.round(t.temp)} °C`, detail, eta: damaging ? Math.min(eta, 8) : eta });
    } else if (t.measured > 1) {
      const driftKnown = !!s.known[sub.id]?.includes('drifting');
      if (!driftKnown) out.push({ key: `ld-${sub.id}`, id: sub.id, level: 'warning', title: `${sub.id} reports ${Math.round(t.measured * 100)}% load`, detail: 'Check the oil temperature, or investigate before acting.', eta: 40 });
      else if (t.loading > 1) out.push({ key: `ld-${sub.id}`, id: sub.id, level: 'warning', title: `${sub.id} truly at ${Math.round(t.loading * 100)}% load`, detail: 'Sensor is faulty, but the real loading is still high. Move load away.', eta: 30 });
    }
    if (s.alertKeys[`gas-${sub.id}`] !== undefined && !s.known[sub.id]) {
      out.push({ key: `gas-${sub.id}`, id: sub.id, level: 'warning', title: `${sub.id} gas-in-oil alarm`, detail: 'Unknown cause. Investigate.', eta: 25 });
    }
    if (s.known[sub.id]?.includes('incipient') && t.loading > 0.7) {
      out.push({ key: `inc-${sub.id}`, id: sub.id, level: 'critical', title: `${sub.id} failing under load`, detail: `Loading ${Math.round(t.loading * 100)}%: get it below 70% or isolate it.`, eta: 12 });
    }
  }

  for (const z of n.zones) {
    const zs = s.zones[z.id];
    const c = z.critical;
    if (c) {
      if (!zs.criticalUp) out.push({ key: `down-${z.id}`, id: z.id, level: 'critical', title: `${c.name} has NO POWER`, detail: zs.atsFailed ? 'Backup blocked: send a crew to the transfer switch.' : 'Restore its feed or start backup.', eta: 0 });
      else if (!zs.served && zs.backup !== 'running') out.push({ key: `ups-${z.id}`, id: z.id, level: 'critical', title: `${c.name} on battery`, detail: `${Math.ceil(zs.ups)} s left${zs.backup === 'starting' ? ', generators starting' : ''}.`, eta: zs.ups });
      else if (zs.criticalDegraded) out.push({ key: `deg-${z.id}`, id: z.id, level: 'warning', title: `${c.name} degraded`, detail: 'Supply voltage below minimum: trains slowed. Relieve its substation.', eta: 30 });
      if (zs.atsFailed && zs.criticalUp && s.time > 6.9) out.push({ key: `ats-${z.id}`, id: z.id, level: 'warning', title: `${c.name}: backup won't auto-start`, detail: sim.crewOn(z.id) ? 'Crew on the way.' : 'Send a crew before this hospital loses its feed.', eta: 45 });
      if (z.id === 'Z06' && zs.backup === 'off' && zs.served && s.time > 10.9) out.push({ key: 'dc-ups', id: z.id, level: 'info', title: 'Data centre UPS weak', detail: `Generators are manual, fuel for ${Math.ceil(zs.fuel)} s. Running on them protects 112 routing and takes 30 MW off Südstadt, at the far end of the west-to-east lines.`, eta: 60 });
    }
    if (zs.shedBy === 'ufls' && !zs.breaker) out.push({ key: `ufls-${z.id}`, id: z.id, level: 'info', title: `${z.name} shed automatically`, detail: `${(z.population / 1000).toFixed(0)}k residents dark. Reconnect when there is headroom.`, eta: 70 });
  }
  for (const t of out) {
    const sg = suggestFor(sim, t);
    if (sg && sim.check(sg.action).ok) t.suggest = sg;
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || (a.eta ?? 99) - (b.eta ?? 99));
}

/** Where spare generation is, east first because the west-to-east lines are the usual bottleneck. */
function headroom(sim: Simulation): string {
  const s = sim.state;
  const spare = sim.net.generators
    .filter((g) => g.kind !== 'wind' && s.gens[g.id].online)
    .map((g) => ({ g, mw: Math.max(0, g.capacity - s.gens[g.id].setpoint) }))
    .filter((x) => x.mw >= 5)
    .sort((a, b) => busX(sim, b.g.bus) - busX(sim, a.g.bus));
  if (!spare.length) return 'No generation headroom left: reduce demand.';
  return 'Headroom: ' + spare.map((x) => `${x.g.short} +${Math.round(x.mw)} MW${busX(sim, x.g.bus) < 0 ? ' (west: loads the lines eastwards)' : ''}`).join(', ') + '.';
}

const busX = (sim: Simulation, id: string) => sim.net.buses.find((b) => b.id === id)?.pos[0] ?? 0;

function curtailHint(sim: Simulation): string {
  const z = sim.net.zones.find((x) => x.kind === 'industrial');
  if (!z) return '';
  const zs = sim.state.zones[z.id];
  if (!zs.served || zs.curtailing) return '';
  return ` Or curtail ${z.name} (about ${Math.round(zs.demand - (z.processMinimum ?? 0))} MW over 12 s, paid per MWh).`;
}

/** The single most sensible next action for a threat, or nothing when it needs judgement. */
function suggestFor(sim: Simulation, t: Threat): { action: Action; label: string } | undefined {
  const s = sim.state;
  const n = sim.net;
  const k = t.key;
  const gen = (id: string) => n.generators.find((g) => g.id === id)!;
  const ok = (a: Action) => sim.check(a).ok;
  if (k === 'freq-low' || k === 'wind-drop') {
    const east = n.generators.filter((g) => g.kind !== 'wind' && s.gens[g.id].online && busX(sim, g.bus) > 0 && s.gens[g.id].setpoint < g.capacity - 1);
    if (east.length) return { action: { type: 'setpoint', gen: east[0].id, delta: 10 }, label: `Raise ${east[0].short} +10` };
    const ind = n.zones.find((z) => z.kind === 'industrial');
    if (ind && s.zones[ind.id].served && !s.zones[ind.id].curtailing) return { action: { type: 'curtail', zone: ind.id }, label: `Curtail ${ind.name}` };
    const dc = n.zones.find((z) => z.kind === 'datacentre');
    if (dc && ok({ type: 'startBackup', zone: dc.id })) return { action: { type: 'startBackup', zone: dc.id }, label: 'Data centre to own generators' };
    if (k === 'freq-low') {
      const west = n.generators.find((g) => g.kind !== 'wind' && s.gens[g.id].online && s.gens[g.id].setpoint < g.capacity - 1);
      if (west) return { action: { type: 'setpoint', gen: west.id, delta: 10 }, label: `Raise ${west.short} +10` };
    }
    return undefined;
  }
  if (k === 'freq-high') {
    const g = [...n.generators].filter((x) => x.kind !== 'wind' && s.gens[x.id].online && s.gens[x.id].setpoint > x.min + 10).sort((a, b) => busX(sim, a.bus) - busX(sim, b.bus))[0];
    return g ? { action: { type: 'setpoint', gen: g.id, delta: -10 }, label: `Lower ${gen(g.id).short} −10` } : undefined;
  }
  if (k.startsWith('ol-')) {
    const best = sim.reliefOptions(t.id, 1)[0];
    return best && best.worstOther <= 1 ? { action: best.action, label: best.label } : undefined;
  }
  if (k.startsWith('tr-') && t.detail.startsWith('Cool')) return { action: { type: 'dispatchCrew', target: t.id }, label: 'Send crew' };
  if (k.startsWith('gas-') || (k.startsWith('ld-') && !s.known[t.id])) return { action: { type: 'investigate', target: t.id }, label: 'Investigate' };
  if (k.startsWith('hot-') || k.startsWith('inc-') || k.startsWith('ld-')) return offload(sim, t.id);
  if (k.startsWith('deg-')) return offload(sim, sim.feedingSub(t.id));
  if (k.startsWith('ats-')) return sim.crewOn(t.id) ? undefined : { action: { type: 'dispatchCrew', target: t.id }, label: 'Send crew' };
  if (k.startsWith('down-') || k.startsWith('ups-')) {
    const zs = s.zones[t.id];
    if (zs.atsFailed) return sim.crewOn(t.id) ? undefined : { action: { type: 'dispatchCrew', target: t.id }, label: 'Send crew' };
    if (ok({ type: 'startBackup', zone: t.id })) return { action: { type: 'startBackup', zone: t.id }, label: 'Start backup' };
    return undefined;
  }
  if (k === 'dc-ups') return { action: { type: 'startBackup', zone: t.id }, label: 'Start generators' };
  if (k.startsWith('ufls-')) {
    const z = n.zones.find((x) => x.id === t.id)!;
    const spare = n.generators.filter((g) => g.kind !== 'wind' && s.gens[g.id].online).reduce((a, g) => a + Math.max(0, g.capacity - s.gens[g.id].pm), 0);
    return s.freq > 49.9 && spare > z.load * 1.5 ? { action: { type: 'restore', zone: z.id }, label: 'Reconnect' } : undefined;
  }
  return undefined;
}

/** Move the zone that best relieves a substation onto its other feed, if that feed can take it. */
function offload(sim: Simulation, subId: string): { action: Action; label: string } | undefined {
  const s = sim.state;
  let best: { action: Action; label: string; after: number } | undefined;
  for (const z of sim.net.zones) {
    if (!z.alternate || sim.feedingSub(z.id) !== subId || !s.zones[z.id].served) continue;
    const to = s.zones[z.id].feed === 'primary' ? z.alternate : z.primary;
    const def = sim.net.substations.find((x) => x.id === to)!;
    const t = s.subs[to];
    if (!t.closed || t.tripped || t.damaged || !t.energised) continue;
    const seen = (s.known[to]?.includes('drifting') ? t.loading : t.measured) * def.rating;
    const after = (seen + s.zones[z.id].drawn) / def.rating;
    if (after > 0.9 || (s.known[to]?.includes('incipient') && after > 0.7)) continue;
    if (!best || after < best.after) best = { action: { type: 'transfer', zone: z.id }, label: `Transfer ${z.name} to ${to}`, after };
  }
  return best && { action: best.action, label: best.label };
}
