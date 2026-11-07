import { useMemo, useState } from 'react';
import type { Simulation } from '../sim/engine';
import { fmtTime } from '../sim/engine';
import type { Action, Alert } from '../sim/types';
import { AssetPanel } from './AssetPanel';
import { threats } from './threats';

interface Props {
  sim: Simulation;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onAct: (a: Action) => void;
  paused: boolean;
  onPause: () => void;
  toast: { text: string; ok: boolean; at: number } | null;
  audio: { muted: boolean; volume: number; setMuted: (m: boolean) => void; setVolume: (v: number) => void };
  seed: number;
  mode: 'crisis' | 'daily';
}

const LEVEL_ICON: Record<string, string> = { critical: '▲', warning: '◆', info: '●', success: '✓' };

export function Hud(p: Props) {
  const { sim } = p;
  const s = sim.state;
  const remaining = Math.max(0, sim.scenario.duration - s.time);
  const list = threats(sim);
  const [sheet, setSheet] = useState<'urgent' | 'log' | 'assets'>('urgent');
  const dark = Math.round(sim.net.zones.reduce((a, z) => a + z.population * (1 - s.zones[z.id].powered), 0));
  const freq = s.freq;
  const fcls = freq <= 0 ? 'dead' : freq < 49.2 || freq > 50.8 ? 'crit' : freq < 49.7 || freq > 50.3 ? 'warn' : 'ok';
  const needle = Math.max(-1, Math.min(1, (freq - 50) / 1.5));
  const crit = sim.net.zones.filter((z) => z.critical);
  const alerts = s.alerts.slice(-40).reverse();

  return (
    <div className={`hud ${p.selected ? 'has-sel' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">BLACKOUT</span>
          <span className="sub">{p.mode === 'daily' ? 'DAILY STORM' : 'STORM'} #{p.seed}</span>
        </div>
        <div className={`timer ${remaining < 15 ? 'hot' : ''}`}>
          <div className="t">{fmtTime(remaining)}<small>.{Math.floor((remaining * 10) % 10)}</small></div>
          <div className="bar"><i style={{ width: `${(remaining / sim.scenario.duration) * 100}%` }} /></div>
        </div>
        <div className="controls">
          <button className="icon" aria-label={p.audio.muted ? 'Unmute' : 'Mute'} onClick={() => p.audio.setMuted(!p.audio.muted)}>{p.audio.muted ? '🔇' : '🔊'}</button>
          <input className="vol" type="range" min={0} max={1} step={0.05} value={p.audio.volume} aria-label="Volume" onChange={(e) => p.audio.setVolume(Number(e.target.value))} />
          <button className="icon" aria-label="Pause" onClick={p.onPause}>❚❚</button>
        </div>
      </header>

      <section className="gauges">
        <div className={`gauge freq ${fcls}`} onClick={() => p.onSelect('G1')}>
          <label>GRID FREQUENCY</label>
          <div className="big">{freq > 0 ? freq.toFixed(2) : '—'}<small>Hz</small></div>
          <div className="dial"><span className="z49" /><span className="z51" /><i style={{ left: `${50 + needle * 50}%` }} /></div>
        </div>
        <div className="gauge">
          <label>GENERATION / DEMAND</label>
          <div className="big">{Math.round(s.totalGen)}<small>/ {Math.round(s.totalDemand)} MW</small></div>
          <div className="split">{sim.net.generators.map((g) => (
            <button key={g.id} className={`gen ${s.gens[g.id].online ? '' : 'off'}`} onClick={() => p.onSelect(g.id)}>{g.short} <b>{Math.round(s.gens[g.id].pe)}</b></button>
          ))}</div>
        </div>
        <div className={`gauge ${dark > 60000 ? 'crit' : dark > 0 ? 'warn' : 'ok'}`}>
          <label>RESIDENTS IN THE DARK</label>
          <div className="big">{dark.toLocaleString('en-GB')}</div>
          <div className="mini-note">of 250,000 · fictional</div>
        </div>
        <div className="gauge critical-strip">
          <label>CRITICAL SERVICES</label>
          <div className="crit-icons">{crit.map((z) => {
            const zs = s.zones[z.id];
            const st = !zs.criticalUp ? 'crit' : zs.criticalDegraded ? 'warn' : !zs.served ? 'warn' : 'ok';
            return (
              <button key={z.id} className={`ci ${st}`} onClick={() => p.onSelect(z.id)} title={z.critical!.name}>
                <span>{z.kind === 'hospital' ? '✚' : z.kind === 'rail' ? '🚆' : z.kind === 'datacentre' ? '⌘' : '☎'}</span>
                <small>{z.critical!.id}</small>
              </button>
            );
          })}</div>
        </div>
      </section>

      <aside className={`left sheet-${sheet}`}>
        <div className="panel urgent">
          <div className="panel-title">MOST URGENT <span className="count">{list.length}</span></div>
          {list.length === 0 && <p className="muted">Nothing urgent. Watch the frequency and the feed.</p>}
          <ul>
            {list.slice(0, 6).map((t) => (
              <li key={t.key} className={`${t.level} ${p.selected === t.id ? 'on' : ''}`} onClick={() => p.onSelect(t.id)}>
                <b>{t.title}</b>
                <span>{t.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel feed">
          <div className="panel-title">INCIDENT LOG</div>
          <ul>
            {alerts.map((a: Alert) => (
              <li key={a.key + a.tick} className={a.level} onClick={() => a.subject && p.onSelect(a.subject)}>
                <time>{fmtTime(a.tick / 10)}</time>
                <i>{LEVEL_ICON[a.level]}</i>
                <span>{a.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <AssetList sim={sim} onSelect={p.onSelect} selected={p.selected} />
      </aside>

      <aside className="right">
        {p.selected ? (
          <AssetPanel key={p.selected} sim={sim} id={p.selected} onAct={p.onAct} onSelect={p.onSelect} onClose={() => p.onSelect(null)} />
        ) : (
          <div className="panel empty">
            <h3>Select anything</h3>
            <p>Tap a substation ring, a power line, a district or a power station on the map, or pick an item under <b>Most urgent</b>.</p>
            <CrewStatus sim={sim} />
          </div>
        )}
      </aside>

      <nav className="sheet-tabs">
        {(['urgent', 'log', 'assets'] as const).map((k) => (
          <button key={k} className={sheet === k ? 'on' : ''} onClick={() => { p.onSelect(null); setSheet(k); }}>
            {k === 'urgent' ? `Urgent${list.length ? ` (${list.length})` : ''}` : k === 'log' ? 'Log' : 'Grid'}
          </button>
        ))}
      </nav>

      {p.toast && <div key={p.toast.at} className={`toast ${p.toast.ok ? 'ok' : 'bad'}`}>{p.toast.text}</div>}
    </div>
  );
}

function CrewStatus({ sim }: { sim: Simulation }) {
  const s = sim.state;
  return (
    <div className="crews">
      {s.crews.map((c) => (
        <div key={c.id} className={`crew ${c.status}`}><b>{c.id}</b><span>{c.status === 'idle' ? 'At depot, ready' : `${c.status === 'travelling' ? 'Driving to' : 'Working at'} ${sim.label(c.target!)} · ${Math.ceil(c.timer)} s`}</span></div>
      ))}
      <div className={`crew ${s.investigation ? 'working' : 'idle'}`}><b>Analyst</b><span>{s.investigation ? `Investigating ${s.investigation.target} · ${Math.ceil(s.investigation.timer)} s` : 'Ready'}</span></div>
      <div className={`crew ${s.mobile.status === 'ready' ? 'idle' : 'working'}`}><b>Mobile generator</b><span>{s.mobile.status === 'ready' ? 'At depot, 8 MW' : s.mobile.status === 'travelling' ? `En route to ${sim.label(s.mobile.zone!)} · ${Math.ceil(s.mobile.timer)} s` : `Connected at ${sim.label(s.mobile.zone!)}`}</span></div>
    </div>
  );
}

function AssetList({ sim, onSelect, selected }: { sim: Simulation; onSelect: (id: string) => void; selected: string | null }) {
  const s = sim.state;
  const groups = useMemo(() => [
    { title: 'Power stations', ids: sim.net.generators.map((g) => g.id) },
    { title: 'Substations', ids: sim.net.substations.map((x) => x.id) },
    { title: 'Districts', ids: sim.net.zones.map((x) => x.id) },
    { title: 'Lines', ids: sim.net.lines.map((x) => x.id) },
  ], [sim]);
  const status = (id: string) => {
    if (s.gens[id]) return s.gens[id].online ? `${Math.round(s.gens[id].pe)} MW` : 'TRIPPED';
    if (s.subs[id]) { const t = s.subs[id]; return t.damaged ? 'DESTROYED' : t.tripped ? 'TRIPPED' : !t.closed ? 'ISOLATED' : `${Math.round(t.measured * 100)}% · ${Math.round(t.temp)}°`; }
    if (s.zones[id]) return s.zones[id].served ? 'ON' : 'DARK';
    if (s.lines[id]) { const l = s.lines[id]; return l.tripped ? 'TRIPPED' : !l.closed ? 'OPEN' : `${Math.round(l.loading * 100)}%`; }
    return '';
  };
  const bad = (id: string) => {
    const st = status(id);
    return /TRIP|DESTROY|DARK|ISOL|OPEN/.test(st) || (s.lines[id] && s.lines[id].loading > 1) || (s.subs[id] && s.subs[id].temp > 115);
  };
  return (
    <div className="panel assets">
      <div className="panel-title">GRID</div>
      {groups.map((g) => (
        <div key={g.title} className="group">
          <h4>{g.title}</h4>
          <div className="grid-list">
            {g.ids.map((id) => (
              <button key={id} className={`asset ${bad(id) ? 'bad' : ''} ${selected === id ? 'on' : ''}`} onClick={() => onSelect(id)}>
                <b>{id}</b><span>{sim.label(id)}</span><em>{status(id)}</em>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
