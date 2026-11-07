import { useEffect, useRef, useState } from 'react';
import type { Report } from '../scoring/report';
import type { Outcome } from '../scoring/score';
import { cardBlob, drawCard, downloadCard, shareCard } from '../share/card';

interface Props {
  outcome: Outcome;
  report: Report | null;
  name: string;
  setName: (n: string) => void;
  seed: number;
  mode: 'crisis' | 'daily';
  timeline: { t: number; freq: number; served: number }[];
  challengeUrl: string;
  rival: { name: string; score: number; grade: string } | null;
  best: { best: number; isNew: boolean; first?: boolean } | null;
  decisions: number;
  onReplay: () => void;
  onNew: () => void;
  onMenu: () => void;
}

const pts = (n: number) => `${n} point${n === 1 ? '' : 's'}`;

const GRADE_CLASS: Record<string, string> = { S: 'g-s', A: 'g-a', B: 'g-b', C: 'g-c', D: 'g-d', F: 'g-f' };

export function Results(p: Props) {
  const o = p.outcome;
  const [shown, setShown] = useState(0);
  const [stamp, setStamp] = useState(false);
  const [msg, setMsg] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const blob = useRef<Blob | null>(null);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 2200);
      setShown(Math.round(o.stability * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
      else setStamp(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [o.stability]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    blob.current = null;
    let live = true;
    void drawCard(c, { name: p.name, outcome: o, seed: p.seed, mode: p.mode, timeline: p.timeline, url: p.challengeUrl })
      .then(() => cardBlob(c))
      .then((b) => { if (live) blob.current = b; })
      .catch(() => {});
    return () => { live = false; };
  }, [p.name, o, p.seed, p.mode, p.timeline, p.challengeUrl]);

  const flash = (t: string) => {
    setMsg(t);
    setTimeout(() => setMsg(''), 2600);
  };
  const text = `I scored ${o.stability}/100 city stability (${o.grade}: ${o.title}) in BLACKOUT. Same storm, your decisions. Would you have done better?`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${p.challengeUrl}`);
      flash('Challenge link copied');
    } catch {
      window.prompt('Copy your challenge link', p.challengeUrl);
    }
  };
  const share = async () => {
    if (!canvas.current) return;
    try {
      const ok = await shareCard(blob.current ?? canvas.current, text, p.challengeUrl);
      if (!ok) await copy();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') flash('Sharing failed. Try Download or Copy link.');
    }
  };
  const download = async () => {
    if (!canvas.current) return;
    await downloadCard(canvas.current, `blackout-nova-city-${p.seed}-${o.stability}.png`);
    flash('Image saved');
  };

  const r = p.report;
  return (
    <div className="results">
      <div className="results-inner">
        <div className="res-hero">
          <div className="kicker">{o.collapsed ? 'INCIDENT FAILED' : 'INCIDENT CLOSED'} · STORM #{p.seed}</div>
          <h1 className={o.collapsed ? 'crit' : ''}>{o.collapsed ? 'TOTAL BLACKOUT' : 'NOVA CITY INCIDENT REPORT'}</h1>
          <div className="score-row">
            <div className="stability">
              <label>CITY STABILITY</label>
              <div className="num">{shown}<small>/100</small></div>
            </div>
            <div className={`grade ${GRADE_CLASS[o.grade]} ${stamp ? 'stamp' : ''}`}>
              <div className="letter">{o.grade}</div>
              <div className="gt">{o.title}</div>
            </div>
          </div>
          {p.best && (p.best.isNew ? <div className="badge-new">NEW PERSONAL BEST</div> : p.best.first ? <div className="muted">Your first result on this storm. Replay it to beat it.</div> : <div className="muted">Your best on this storm: {p.best.best}/100</div>)}
          {p.rival && (
            <div className={`versus ${o.stability > p.rival.score ? 'win' : o.stability < p.rival.score ? 'lose' : 'draw'}`}>
              <div><small>YOU</small><b>{o.stability}</b></div>
              <div className="vs">{o.stability > p.rival.score ? 'YOU WIN' : o.stability < p.rival.score ? 'THEY WIN' : 'DRAW'}</div>
              <div><small>{p.rival.name.toUpperCase() || 'RIVAL'}</small><b>{p.rival.score}</b></div>
            </div>
          )}
        </div>

        <div className="stats">
          <Stat label="People kept powered" value={o.peoplePowered.toLocaleString('en-GB')} sub={`average over 90 s, of 250,000 (${Math.round(o.peoplePoweredPct * 100)}%)`} />
          <Stat label="Peak in the dark" value={o.peakDark.toLocaleString('en-GB')} sub="residents at the worst moment" />
          <Stat label="Critical services protected" value={`${o.criticalProtected} / ${o.critical.length}`} sub={o.critical.filter((c) => !c.protected).map((c) => c.name).join(', ') || 'all kept running'} />
          <Stat label="Power restored at the end" value={`${Math.round(o.powerRestoredPct * 100)}%`} sub={`lowest frequency ${o.minFreq.toFixed(2)} Hz`} />
          <Stat label="Infrastructure lost" value={o.infrastructureLost.length ? String(o.infrastructureLost.length) : 'None'} sub={o.infrastructureLost.join(' · ') || 'all equipment intact'} bad={o.infrastructureLost.length > 0} />
          <Stat label="Decisions made" value={String(p.decisions)} sub={o.uflsShedMW > 0 ? `automatic shedding cut ${Math.round(o.uflsShedMW)} MW` : 'no automatic shedding'} />
        </div>

        <div className="report">
          <h2>Your disaster report</h2>
          <p className="method">Every judgement below comes from replaying this exact storm without (or with) one decision and comparing the outcome. Nothing is guessed.</p>
          {!r && <div className="replaying"><span className="spinner" />Replaying your decisions…</div>}
          {r && (
            <>
              <Section title="Decisions that helped" cls="good" items={r.helped} empty={r.decisions === 0 ? 'You made no decisions.' : 'No single decision gained 2 points or more on its own.'} sign="+" />
              <Section title="Decisions that caused damage" cls="bad" items={r.harmed} empty={r.decisions === 0 ? 'You made no decisions.' : o.stability < r.idle.stability ? `No single decision cost 2 points or more on its own, but together they finished ${r.idle.stability - o.stability} points below doing nothing.` : 'No single decision cost 2 points or more on its own.'} sign="" />
              <Section title="Missed opportunities" cls="miss" items={r.missed} empty="We could not find a single extra action that would have helped. Impressive." sign="+" />
              <div className="idle">
                <b>If nobody had touched the controls:</b> {r.idle.collapsed ? `total blackout at ${Math.floor(r.idle.collapseTime / 60)}:${String(Math.floor(r.idle.collapseTime % 60)).padStart(2, '0')}` : `${r.idle.stability}/100 stability (${r.idle.grade})`}
                {r.idle.critical.filter((c) => !c.protected).length > 0 && `, ${r.idle.critical.filter((c) => !c.protected).map((c) => c.name).join(' and ')} would have lost power`}.
                {' '}{o.stability === r.idle.stability ? 'Your shift ended exactly where doing nothing would have.' : o.stability > r.idle.stability ? `All your decisions together: ${pts(o.stability - r.idle.stability)} better.` : `All your decisions together: ${pts(r.idle.stability - o.stability)} worse.`}
                {r.measured < r.decisions && <span className="muted"> The first {r.measured} of your {r.decisions} decisions were measured one by one; this comparison covers all of them.</span>}
              </div>
            </>
          )}
          <div className="breakdown">
            {o.breakdown.map((b) => (
              <div key={b.label} className="bd">
                <span>{b.label}</span>
                {b.max > 0 ? <div className="bd-bar"><i style={{ width: `${(b.points / b.max) * 100}%` }} /></div> : <div className="bd-bar neg" />}
                <b>{b.points}{b.max > 0 ? `/${b.max}` : ''}</b>
              </div>
            ))}
          </div>
        </div>

        <div className="share">
          <div className="card-wrap"><canvas ref={canvas} aria-label="Shareable incident report image" /></div>
          <div className="share-side">
            <h2>Challenge someone</h2>
            <p>Your link carries this storm and every decision you made. Their browser replays it to check your score, then gives them the same storm.</p>
            <label className="name-field">
              <span>Operator name on the card</span>
              <input value={p.name} maxLength={24} placeholder="ANONYMOUS" onChange={(e) => p.setName(e.target.value)} />
            </label>
            <div className="share-btns">
              <button className="cta small" onClick={share}>Share</button>
              <button className="ghost" onClick={download}>Download image</button>
              <button className="ghost" onClick={copy}>Copy challenge link</button>
            </div>
            {msg && <div className="flash">{msg}</div>}
            <div className="again">
              <button className="cta small" onClick={p.onReplay}>Replay this storm</button>
              <button className="ghost" onClick={p.onNew}>New storm</button>
              <button className="ghost" onClick={p.onMenu}>Menu</button>
            </div>
          </div>
        </div>
        <p className="fine">All figures are fictional simulation results for a fictional city. BLACKOUT uses a simplified electrical model (DC power flow, aggregated frequency dynamics) and does not predict real-world outcomes.</p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <div className={`stat ${bad ? 'bad' : ''}`}>
      <label>{label}</label>
      <b>{value}</b>
      <span>{sub}</span>
    </div>
  );
}

function Section({ title, items, empty, cls, sign }: { title: string; items: { time: string; text: string; delta: number; consequence: string }[]; empty: string; cls: string; sign: string }) {
  return (
    <div className={`rsec ${cls}`}>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="muted">{empty}</p> : (
        <ul>
          {items.map((i, k) => (
            <li key={k}>
              <time>{i.time}</time>
              <div><b>{i.text}</b><span>{i.consequence}</span></div>
              <em>{sign}{i.delta}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
