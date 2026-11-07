import { useState } from 'react';
import type { Simulation } from '../sim/engine';
import { MOBILE_GEN_MW, XFMR_TRIP, XFMR_RESET_TEMP, CREW_WORK, INCIPIENT_THRESHOLD } from '../sim/engine';
import type { Action } from '../sim/types';
import { lineEta, xfmrEta } from './threats';

interface Props {
  sim: Simulation;
  id: string;
  onAct: (a: Action) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mw = (v: number) => `${Math.round(v)} MW`;

function Meter({ value, max, warn, crit, label, right }: { value: number; max: number; warn: number; crit: number; label: string; right: string }) {
  const r = Math.max(0, Math.min(1, value / max));
  const cls = value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><b className={cls}>{right}</b></div>
      <div className="meter-bar"><i className={cls} style={{ width: `${r * 100}%` }} /><em style={{ left: `${(crit / max) * 100}%` }} /></div>
    </div>
  );
}

function Btn({ sim, action, onAct, label, cost, primary, danger }: { sim: Simulation; action: Action; onAct: (a: Action) => void; label: string; cost?: string; primary?: boolean; danger?: boolean }) {
  const c = sim.check(action);
  return (
    <button className={`act ${primary ? 'primary' : ''} ${danger ? 'danger' : ''}`} disabled={!c.ok} onClick={() => onAct(action)} title={c.ok ? cost : c.reason}>
      <span className="act-label">{label}</span>
      <span className="act-cost">{c.ok ? cost : c.reason}</span>
    </button>
  );
}

function Status({ level, children }: { level: 'ok' | 'warn' | 'crit' | 'dead'; children: React.ReactNode }) {
  return <span className={`pill ${level}`}>{children}</span>;
}

export function AssetPanel({ sim, id, onAct, onSelect, onClose }: Props) {
  const n = sim.net;
  const s = sim.state;
  const gen = n.generators.find((g) => g.id === id);
  const sub = n.substations.find((x) => x.id === id);
  const line = n.lines.find((x) => x.id === id);
  const zone = n.zones.find((x) => x.id === id);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const crewFree = s.crews.filter((c) => c.status === 'idle').length;

  let body: React.ReactNode = null;
  let title = id;
  let kicker = '';

  if (gen) {
    const g = s.gens[gen.id];
    kicker = gen.kind === 'gas' ? 'Gas power station' : gen.kind === 'wind' ? 'Offshore wind farm' : 'Hydro-electric dam';
    title = gen.name;
    const lines = n.lines.filter((l) => l.from === gen.bus || l.to === gen.bus);
    body = (
      <>
        <div className="row-pills">
          {g.online ? <Status level="ok">ONLINE</Status> : <Status level="dead">TRIPPED</Status>}
          {gen.kind === 'wind' && <Status level={s.wind < 40 ? 'warn' : 'ok'}>Wind available {mw(s.wind)}</Status>}
        </div>
        {!g.online && <p className="note crit">{g.trip}</p>}
        <Meter label="Output" value={g.pm} max={gen.capacity * gen.emergencyRating} warn={gen.capacity * 0.95} crit={gen.capacity + 0.01} right={`${mw(g.pm)} / ${mw(gen.capacity)}`} />
        {gen.kind !== 'wind' && <div className="kv"><span>Setpoint</span><b>{mw(g.setpoint)}</b><span>Ramp</span><b>{gen.ramp} MW/s</b></div>}
        {gen.overloadSeconds > 0 && g.overload > 0 && <Meter label="Emergency rating used" value={g.overload} max={gen.overloadSeconds} warn={gen.overloadSeconds * 0.5} crit={gen.overloadSeconds * 0.8} right={`${Math.round(g.overload)} / ${gen.overloadSeconds} s`} />}
        <p className="hint">
          {gen.kind === 'wind'
            ? 'Wind output follows the storm. Turbines shut down above cut-out speed; you can only curtail them.'
            : `More output raises frequency but pushes more power through ${lines.map((l) => l.id).join(' and ')}.${gen.emergencyRating > 1 ? ` Above ${gen.capacity} MW it runs on its emergency rating for at most ${gen.overloadSeconds} s.` : ''}`}
        </p>
        {gen.kind !== 'wind' && (
          <div className="actions two">
            <Btn sim={sim} onAct={onAct} action={{ type: 'setpoint', gen: gen.id, delta: -10 }} label="−10 MW" cost="Lower setpoint" />
            <Btn sim={sim} onAct={onAct} primary action={{ type: 'setpoint', gen: gen.id, delta: 10 }} label="+10 MW" cost={`Ramps at ${gen.ramp} MW/s`} />
          </div>
        )}
        {gen.kind === 'wind' && (
          <div className="actions two">
            <Btn sim={sim} onAct={onAct} action={{ type: 'setpoint', gen: gen.id, delta: -10 }} label="Curtail 10 MW" cost="Reduce output" />
            <Btn sim={sim} onAct={onAct} action={{ type: 'setpoint', gen: gen.id, delta: 10 }} label="Release 10 MW" cost="Allow more output" />
          </div>
        )}
        <Links sim={sim} ids={lines.map((l) => l.id)} onSelect={onSelect} label="Export lines" />
      </>
    );
  } else if (sub) {
    const t = s.subs[sub.id];
    kicker = 'Substation and transformer';
    title = `${sub.id} ${sub.name}`;
    const fed = n.zones.filter((z) => sim.feedingSub(z.id) === sub.id);
    const lines = n.lines.filter((l) => l.from === sub.id || l.to === sub.id);
    const known = s.known[sub.id];
    // Until the analyst finds a drifting sensor, the operator sees only the sensor reading.
    const driftKnown = !!known?.includes('drifting');
    const shown = driftKnown ? t.loading : t.measured;
    // the trip forecast can only use what the operator can see (honest oil temperature, the loading reading)
    const eta = xfmrEta(t.temp, shown);
    const level = t.damaged ? 'dead' : t.tripped || !t.closed ? 'dead' : t.temp > 120 || shown > 1 ? 'crit' : t.temp > 105 ? 'warn' : 'ok';
    body = (
      <>
        <div className="row-pills">
          <Status level={level}>{t.damaged ? 'DESTROYED' : t.tripped ? 'TRIPPED' : !t.closed ? 'ISOLATED' : !t.energised ? 'NO SUPPLY' : 'IN SERVICE'}</Status>
          {s.alertKeys[`gas-${sub.id}`] !== undefined && !t.damaged && <Status level="warn">GAS ALARM</Status>}
        </div>
        <Meter label={driftKnown ? 'Loading (true, sensor faulty)' : 'Loading (sensor)'} value={shown} max={1.5} warn={0.9} crit={1.0} right={`${pct(shown)} · ${mw(shown * sub.rating)} of ${mw(sub.rating)}${driftKnown ? ` · sensor says ${pct(t.measured)}` : ''}`} />
        <Meter label="Oil temperature" value={t.temp} max={160} warn={105} crit={XFMR_TRIP} right={`${Math.round(t.temp)} °C${eta !== Infinity && !t.tripped ? ` · trips in ${Math.ceil(eta)} s` : ''}`} />
        {known && <p className="note info">Investigation: {known}</p>}
        <p className="hint">Hot transformers trip at {XFMR_TRIP} °C and need a crew to reset once below {XFMR_RESET_TEMP} °C. Above 125 °C the insulation is being damaged.</p>
        <div className="actions">
          <Btn sim={sim} onAct={onAct} action={{ type: 'investigate', target: sub.id }} label="Investigate" cost="Analyst, 4 s: sensors and dissolved gas" />
          {t.tripped
            ? <Btn sim={sim} onAct={onAct} primary action={{ type: 'dispatchCrew', target: sub.id }} label="Send crew to reset" cost={`${crewFree} crew free · ${CREW_WORK.sub} s on site`} />
            : t.closed
              ? <Btn sim={sim} onAct={onAct} danger action={{ type: 'isolateSub', sub: sub.id }} label="Isolate transformer" cost={`Protects it; ${fed.map((z) => z.name).join(', ') || 'nothing'} go dark unless transferred`} />
              : <Btn sim={sim} onAct={onAct} primary action={{ type: 'energiseSub', sub: sub.id }} label="Energise transformer" cost="Reconnects its zones" />}
        </div>
        <Links sim={sim} ids={fed.map((z) => z.id)} onSelect={onSelect} label="Feeds" />
        <Links sim={sim} ids={lines.map((l) => l.id)} onSelect={onSelect} label="Lines" />
      </>
    );
  } else if (line) {
    const l = s.lines[line.id];
    kicker = 'Transmission line';
    title = `${line.id} ${line.name}`;
    const eta = lineEta(l.heat, l.loading);
    const options = analysis === line.id ? sim.reliefOptions(line.id) : null;
    const dir = l.flow >= 0 ? `${line.from} → ${line.to}` : `${line.to} → ${line.from}`;
    body = (
      <>
        <div className="row-pills">
          {l.tripped ? <Status level="dead">TRIPPED</Status> : !l.closed ? <Status level="dead">OPEN</Status> : l.loading > 1 ? <Status level="crit">OVERLOADED</Status> : <Status level="ok">IN SERVICE</Status>}
          {l.closed && !l.tripped && <Status level="ok">Flow {dir}</Status>}
        </div>
        <Meter label="Loading" value={l.loading} max={1.6} warn={0.9} crit={1.0} right={`${mw(Math.abs(l.flow))} / ${mw(line.limit)}${eta !== Infinity ? ` · trips in ${Math.ceil(eta)} s` : ''}`} />
        {s.known[line.id] && <p className="note info">Investigation: {s.known[line.id]}</p>}
        {l.tripped && !s.known[line.id] && <p className="note warn">Tripped{l.faultCause ? ` after a ${l.faultCause}` : ' on overload'}. Is the fault still there? Investigate before reclosing.</p>}
        {l.closed && !l.tripped && (
          <div className="analysis">
            <button className="act primary" onClick={() => setAnalysis(analysis === line.id ? null : line.id)}>
              <span className="act-label">{analysis === line.id ? 'Hide grid analysis' : 'Grid analysis'}</span>
              <span className="act-cost">Single actions that relieve this line, cheapest that clears it first</span>
            </button>
            {options && (
              <ol className="relief">
                {options.length === 0 && <li className="muted">No single action relieves this line right now.</li>}
                {options.map((o, i) => (
                  <li key={i}>
                    <div><b>{o.label}</b><span>{pct(l.loading)} → {pct(o.loading)}{o.note ? ` · ${o.note}` : o.worstOther > 1 ? ` · overloads another line (${pct(o.worstOther)})` : ''}</span></div>
                    <button className="mini" disabled={!sim.check(o.action).ok} onClick={() => onAct(o.action)}>Do it</button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        <div className="actions">
          <Btn sim={sim} onAct={onAct} action={{ type: 'investigate', target: line.id }} label="Investigate" cost="Analyst, 4 s: is there a fault?" />
          {l.closed && !l.tripped
            ? <Btn sim={sim} onAct={onAct} danger action={{ type: 'isolateLine', line: line.id }} label="Open line" cost={openLineCost(sim, line.id)} />
            : <Btn sim={sim} onAct={onAct} primary action={{ type: 'closeLine', line: line.id }} label="Close line" cost="Closing onto a fault trips it again" />}
          {(l.tripped || l.faulted) && <Btn sim={sim} onAct={onAct} action={{ type: 'dispatchCrew', target: line.id }} label="Send repair crew" cost={`${crewFree} crew free · ${CREW_WORK.line} s on site`} />}
        </div>
        <Links sim={sim} ids={[line.from, line.to]} onSelect={onSelect} label="Ends" />
      </>
    );
  } else if (zone) {
    const z = s.zones[zone.id];
    kicker = zone.kind === 'residential' ? 'Residential district' : zone.kind === 'industrial' ? 'Industrial district' : zone.kind === 'hospital' ? 'Hospital district' : zone.kind === 'rail' ? 'Railway' : zone.kind === 'datacentre' ? 'Data centre' : 'Emergency services';
    title = zone.name;
    const feed = sim.feedingSub(zone.id);
    const other = zone.alternate ? (z.feed === 'primary' ? zone.alternate : zone.primary) : null;
    const c = zone.critical;
    body = (
      <>
        <div className="row-pills">
          {z.served ? <Status level="ok">POWERED</Status> : z.transferTimer > 0 ? <Status level="warn">SWITCHING</Status> : <Status level="dead">{z.shedBy === 'ufls' ? 'SHED BY UFLS' : z.shedBy === 'player' ? 'SHED' : 'NO SUPPLY'}</Status>}
          {z.protected && <Status level="ok">EXEMPT FROM UFLS</Status>}
          {zone.kind === 'industrial' && z.curtail < 0.99 && <Status level="warn">CURTAILED {pct(z.curtail)}</Status>}
          {z.mobileGen && <Status level="ok">MOBILE GEN</Status>}
        </div>
        <div className="kv">
          <span>Residents</span><b>{zone.population ? zone.population.toLocaleString('en-GB') : '—'}</b>
          <span>Demand</span><b>{mw(z.demand)}</b>
          <span>Fed from</span><b className="link" onClick={() => onSelect(feed)}>{feed} {sim.label(feed)}</b>
          <span>Alternative</span><b>{other ? <span className="link" onClick={() => onSelect(other)}>{other} {sim.label(other)}</span> : 'none'}</b>
        </div>
        {c && (
          <div className="critical-box">
            <div className="cb-head"><b>{c.name}</b><Status level={!z.criticalUp ? 'crit' : z.criticalDegraded ? 'warn' : z.served ? 'ok' : 'warn'}>{!z.criticalUp ? 'DOWN' : z.criticalDegraded ? 'DEGRADED' : z.served ? (z.backup === 'running' ? 'ON OWN GENERATORS' : 'GRID') : z.backup === 'running' ? 'BACKUP' : 'BATTERY'}</Status></div>
            <p>{zone.kind === 'datacentre' ? 'Routes 112 emergency calls for the whole city (fictional).' : `${c.dependants.toLocaleString('en-GB')} people depend on it directly (fictional).`}</p>
            {c.backup && <div className="kv"><span>Backup</span><b>{z.atsFailed ? 'Transfer switch FAULTY' : z.backup === 'none' ? '—' : z.backup}</b><span>Battery</span><b>{Math.ceil(z.ups)} s</b>{z.fuel < 1e8 && <><span>Fuel</span><b className={z.fuel < 15 ? 'crit' : ''}>{Math.ceil(z.fuel)} s</b></>}</div>}
            {c.minVoltage && <div className="kv"><span>Supply voltage</span><b className={s.subs[feed].voltage < c.minVoltage ? 'crit' : ''}>{(s.subs[feed].voltage * 100).toFixed(1)}% (min {c.minVoltage * 100}%)</b></div>}
          </div>
        )}
        <div className="actions">
          {c?.backup && (z.backup === 'running' || z.backup === 'starting') && z.served && <Btn sim={sim} onAct={onAct} action={{ type: 'stopBackup', zone: zone.id }} label="Return to the grid" cost={`Stops the generators${z.fuel < 1e8 ? ` · saves the ${Math.ceil(z.fuel)} s of fuel left` : ''} · ${mw(Math.min(c.load, c.backup.capacity))} back on ${feed}`} />}
          {c?.backup && z.backup !== 'running' && z.backup !== 'starting' && <Btn sim={sim} onAct={onAct} primary action={{ type: 'startBackup', zone: zone.id }} label={zone.id === 'Z06' ? 'Start on-site generators' : 'Start backup generators'} cost={`${c.backup.startDelay} s to start · carries ${c.backup.capacity} MW${z.fuel < 1e8 ? ` · fuel for ${Math.ceil(z.fuel)} s` : ''}`} />}
          {z.atsFailed && <Btn sim={sim} onAct={onAct} primary action={{ type: 'dispatchCrew', target: zone.id }} label="Send crew to transfer switch" cost={`${crewFree} crew free · ${CREW_WORK.ats} s on site`} />}
          {zone.kind === 'industrial' && <Btn sim={sim} onAct={onAct} primary={!z.curtailing} action={{ type: 'curtail', zone: zone.id }} label={z.curtailing ? 'Release curtailment' : 'Request curtailment'} cost={z.curtailing ? 'Ramps back up over 12 s' : `Controlled ramp to ${zone.processMinimum} MW over 12 s`} />}
          {other && <Btn sim={sim} onAct={onAct} action={{ type: 'transfer', zone: zone.id }} label={z.feed === 'primary' ? `Transfer to ${other}` : `Back to normal feed ${other}`} cost={transferCost(sim, zone.id, other)} />}
          {z.breaker
            ? <Btn sim={sim} onAct={onAct} danger action={{ type: 'shed', zone: zone.id }} label="Shed this zone" cost={zone.kind === 'industrial' ? 'Unsafe: uncontrolled process trip' : zone.population ? `${(zone.population / 1000).toFixed(0)}k residents lose power` : 'Disconnect the feeder'} />
            : <Btn sim={sim} onAct={onAct} primary action={{ type: 'restore', zone: zone.id }} label="Reconnect" cost="Cold-load pickup: up to +40% demand for 10 s" />}
          {zone.uflsStage > 0 && <Btn sim={sim} onAct={onAct} action={{ type: 'protect', zone: zone.id }} label={z.protected ? 'Remove UFLS exemption' : 'Exempt from automatic shedding'} cost={`Stage ${zone.uflsStage} zone · max 3 exemptions`} />}
          <Btn sim={sim} onAct={onAct} action={{ type: 'mobileGen', zone: zone.id }} label="Deploy mobile generator" cost={`One unit, ${MOBILE_GEN_MW} MW · travel time from the depot`} />
        </div>
      </>
    );
  }

  return (
    <div className="panel asset">
      <div className="panel-head">
        <div>
          <div className="kicker">{kicker}</div>
          <h3>{title}</h3>
        </div>
        <button className="icon" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {body}
    </div>
  );
}

function Links({ sim, ids, onSelect, label }: { sim: Simulation; ids: string[]; onSelect: (id: string) => void; label: string }) {
  if (!ids.length) return null;
  const s = sim.state;
  return (
    <div className="links">
      <span>{label}</span>
      {ids.map((id) => {
        const bad = s.lines[id] ? s.lines[id].tripped || s.lines[id].loading > 1 : s.subs[id] ? s.subs[id].tripped || s.subs[id].damaged || s.subs[id].temp > 120 : s.zones[id] ? !s.zones[id].served : false;
        return <button key={id} className={`chip ${bad ? 'bad' : ''}`} onClick={() => onSelect(id)}>{id} <small>{sim.label(id)}</small></button>;
      })}
    </div>
  );
}

/** What opening a line does: reroutes its flow, or cuts off a power station on a single line. */
function openLineCost(sim: Simulation, lineId: string): string {
  const def = sim.net.lines.find((l) => l.id === lineId)!;
  for (const end of [def.from, def.to]) {
    const g = sim.net.generators.find((x) => x.bus === end);
    if (!g) continue;
    const others = sim.net.lines.filter((l) => l.id !== lineId && (l.from === end || l.to === end) && sim.state.lines[l.id].closed && !sim.state.lines[l.id].tripped);
    if (!others.length) return `Cuts off ${g.name}: its ${Math.round(sim.state.gens[g.id].pe)} MW is lost at once`;
  }
  const e = sim.openLineEffect(lineId);
  if (e.worstId && e.worst > 1) return `Its flow moves to other lines at once: ${e.worstId} would be at ${Math.round(e.worst * 100)}% and start heating`;
  if (e.worstId) return `Its flow moves to other lines at once: worst becomes ${e.worstId} at ${Math.round(e.worst * 100)}%`;
  return 'Its flow moves to other lines at once';
}

/** What a transfer does to the substation that takes the zone, as the operator can see it. */
function transferCost(sim: Simulation, zoneId: string, to: string): string {
  const s = sim.state;
  const z = s.zones[zoneId];
  const def = sim.net.substations.find((x) => x.id === to)!;
  const t = s.subs[to];
  const drift = s.known[to]?.includes('drifting');
  const now = (drift ? t.loading : t.measured) * def.rating;
  const after = (now + z.drawn) / def.rating;
  const warn = s.known[to]?.includes('incipient') && after > INCIPIENT_THRESHOLD ? ' · KNOWN FAULT: it fails above 70%' : after > 1 ? ' · over its rating' : '';
  return `1.5 s interruption · adds ${Math.round(z.drawn)} MW: ${to} to about ${Math.round(after * 100)}%${warn}`;
}
