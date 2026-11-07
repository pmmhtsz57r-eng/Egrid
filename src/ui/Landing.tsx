import { useState } from 'react';
import type { Challenge } from '../game/challenge';

interface Props {
  name: string;
  setName: (n: string) => void;
  onStart: (mode: 'crisis' | 'daily') => void;
  challenge: (Challenge & { score: number; grade: string }) | null;
  onAcceptChallenge: () => void;
  dailySeed: number;
  dailyBest: number | null;
  played: number;
}

export function Landing(p: Props) {
  const [how, setHow] = useState(false);
  return (
    <div className="landing">
      <div className="landing-inner">
        {p.challenge && (
          <div className="challenge-banner">
            <div className="cb-kicker">CHALLENGE RECEIVED</div>
            <div className="cb-text">
              <b>{p.challenge.name || 'An operator'}</b> scored <b className="accent">{p.challenge.score}/100</b> city stability ({p.challenge.grade}) in storm #{p.challenge.seed}.
            </div>
            <button className="cta small" onClick={p.onAcceptChallenge}>Take the same storm</button>
          </div>
        )}
        <h1 className="title" aria-label="Blackout">
          <span data-text="BLACKOUT">BLACKOUT</span>
        </h1>
        <div className="tagline">
          <span>90 SECONDS.</span>
          <span>ONE CITY.</span>
          <span>YOUR DECISIONS.</span>
        </div>
        <p className="question">CAN YOU SAVE NOVA CITY?</p>
        <p className="lede">A storm is tearing through the power grid of a city of 250,000. Lines are tripping, the wind farm is shutting down and a hospital's backup has failed its test. You are the operator on shift.</p>
        <label className="name-field">
          <span>Operator name</span>
          <input value={p.name} maxLength={24} placeholder="optional" onChange={(e) => p.setName(e.target.value)} />
        </label>
        <button className="cta" onClick={() => p.onStart('crisis')} autoFocus>
          <span className="cta-pulse" />START EMERGENCY
        </button>
        <div className="secondary">
          <button className="ghost" onClick={() => p.onStart('daily')}>
            Daily storm #{p.dailySeed}{p.dailyBest !== null ? ` · your best ${p.dailyBest}%` : ''}
          </button>
          <button className="ghost" onClick={() => setHow(!how)}>{how ? 'Hide' : 'How it works'}</button>
        </div>
        {how && (
          <div className="how">
            <div><b>1</b><p><em>Watch the frequency.</em> 50 Hz means supply matches demand. Below 49.0 Hz the grid sheds whole districts automatically.</p></div>
            <div><b>2</b><p><em>Stop overloads before they cascade.</em> A tripped line pushes its power onto its neighbours. Use Grid analysis on any overloaded line.</p></div>
            <div><b>3</b><p><em>Protect what matters.</em> Hospitals, the railway, the 112 data centre and emergency services. Every action has a cost; there is no single right answer.</p></div>
          </div>
        )}
        <p className="fine">Sound on. No sign-up. Nova City and every figure in it are fictional; the electrical model is simplified and is not an engineering tool.{p.played ? ` You have played ${p.played} time${p.played === 1 ? '' : 's'} on this device.` : ''}</p>
      </div>
    </div>
  );
}

export function Briefing({ onGo, count }: { onGo: () => void; count: number }) {
  return (
    <div className="briefing" onClick={onGo}>
      <div className="brief-card">
        <div className="kicker">18:47 · NOVA CITY GRID CONTROL</div>
        <h2>Storm front over the city</h2>
        <ul>
          <li><b>Keep frequency near 50 Hz.</b> Balance generation and demand.</li>
          <li><b>Stop overloads</b> before protection trips them and the load cascades.</li>
          <li><b>Protect</b> the hospitals, Railway R02, the 112 data centre and emergency services.</li>
        </ul>
        <p className="muted">Tap anything on the map or in <b>Most urgent</b> to act. The clock only stops if you pause, and pausing hides the city.</p>
        <div className="count">{count > 0 ? count : 'GO'}</div>
        <p className="skip">tap to start now</p>
      </div>
    </div>
  );
}
