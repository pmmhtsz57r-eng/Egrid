import { LINE_HEAT_K, XFMR_ALARM, XFMR_RESET_TEMP, XFMR_TAU, XFMR_TRIP, XFMR_AMBIENT, XFMR_RISE, type Simulation } from '../sim/engine';

export type Level = 'critical' | 'warning' | 'info';

export interface Threat {
  key: string;
  id: string;
  level: Level;
  title: string;
  detail: string;
  eta?: number;
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
  if (f > 0 && f < 49.6) {
    out.push({
      key: 'freq-low', id: 'G1', level: f < 49.2 ? 'critical' : 'warning',
      title: `Frequency ${f.toFixed(2)} Hz`,
      detail: `Demand exceeds generation${deficit > 1 ? ` by ${Math.round(deficit)} MW` : ''}. Automatic shedding at 49.0 Hz.`,
      eta: f < 49.2 ? 3 : 10,
    });
  } else if (f > 50.4) {
    out.push({ key: 'freq-high', id: 'G1', level: f > 51 ? 'critical' : 'warning', title: `Frequency ${f.toFixed(2)} Hz`, detail: 'Too much generation. Lower output; generators trip at 52 Hz.', eta: 8 });
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
    const eta = xfmrEta(t.temp, t.loading);
    if (t.temp > XFMR_ALARM - 5 || eta < 25) {
      out.push({ key: `hot-${sub.id}`, id: sub.id, level: t.temp > 125 || eta < 10 ? 'critical' : 'warning', title: `${sub.id} transformer ${Math.round(t.temp)} °C`, detail: eta === Infinity ? 'Hot but stable.' : `Trips at ${XFMR_TRIP} °C in ${secs(eta)}. Move load away.`, eta });
    } else if (t.measured > 1) {
      out.push({ key: `ld-${sub.id}`, id: sub.id, level: 'warning', title: `${sub.id} reports ${Math.round(t.measured * 100)}% load`, detail: s.known[sub.id] ?? `Temperature is ${Math.round(t.temp)} °C. Investigate before acting?`, eta: 40 });
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
      if (z.id === 'Z06' && zs.backup === 'off' && s.time > 10.9) out.push({ key: 'dc-ups', id: z.id, level: 'info', title: 'Data centre UPS weak', detail: 'Generators are manual. Starting them also frees 30 MW.', eta: 60 });
    }
    if (zs.shedBy === 'ufls' && !zs.breaker) out.push({ key: `ufls-${z.id}`, id: z.id, level: 'info', title: `${z.name} shed automatically`, detail: `${(z.population / 1000).toFixed(0)}k residents dark. Reconnect when there is headroom.`, eta: 70 });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || (a.eta ?? 99) - (b.eta ?? 99));
}
