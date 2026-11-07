import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/audio';
import { decodeChallenge, encodeChallenge, type Challenge } from '../game/challenge';
import { GameController, type GameMode } from '../game/controller';
import { store } from '../game/storage';
import { CityRenderer, type Quality } from '../render/city';
import { createCrisis } from '../scenario/crisis';
import { Simulation } from '../sim/engine';
import { dailySeed } from '../sim/rng';
import type { Action, Alert } from '../sim/types';
import type { Report } from '../scoring/report';
import { buildReport } from '../scoring/report';
import { score, type Outcome } from '../scoring/score';
import { Hud } from './Hud';
import { LabelLayer } from './labels';
import { Briefing, Landing } from './Landing';
import { Results } from './Results';

type Screen = 'landing' | 'briefing' | 'playing' | 'results';

function detectQuality(): Quality {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'low' || q === 'high') return q;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if ((nav.deviceMemory ?? 8) < 4 || (navigator.hardwareConcurrency ?? 8) <= 4 || (small && matchMedia('(pointer: coarse)').matches)) return 'low';
  return 'high';
}

const randomSeed = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return 100000 + (a[0] % 900000);
};

interface RivalInfo extends Challenge {
  score: number;
  grade: string;
}

function readChallenge(): RivalInfo | null {
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return null;
  const c = decodeChallenge(m[1]);
  if (!c) return null;
  // the score is recomputed from the decisions, never read from the link
  const o = score(Simulation.replay(createCrisis(c.seed), c.actions));
  return { ...c, score: o.stability, grade: o.grade };
}

export function App() {
  const stage = useRef<HTMLDivElement>(null);
  const labelsRoot = useRef<HTMLDivElement>(null);
  const city = useRef<CityRenderer | null>(null);
  const labels = useRef<LabelLayer | null>(null);
  const audio = useRef(new AudioEngine());
  const game = useRef<GameController | null>(null);
  const selectedRef = useRef<string | null>(null);
  const screenRef = useRef<Screen>('landing');

  const stored = store.get();
  const [screen, setScreenState] = useState<Screen>('landing');
  const [, setVersion] = useState(0);
  const [selected, setSelectedState] = useState<string | null>(null);
  const [name, setNameState] = useState(stored.name ?? '');
  const [muted, setMutedState] = useState(stored.muted ?? false);
  const [volume, setVolumeState] = useState(stored.volume ?? 0.8);
  const [toast, setToast] = useState<{ text: string; ok: boolean; at: number } | null>(null);
  const [count, setCount] = useState(3);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [best, setBest] = useState<{ best: number; isNew: boolean } | null>(null);
  const [rival, setRival] = useState<RivalInfo | null>(() => readChallenge());
  const [activeRival, setActiveRival] = useState<RivalInfo | null>(null);
  const [run, setRun] = useState<{ seed: number; mode: GameMode }>({ seed: 0, mode: 'crisis' });
  const [glError, setGlError] = useState(false);
  const today = dailySeed(new Date());

  const setScreen = (s: Screen) => {
    screenRef.current = s;
    setScreenState(s);
  };
  const setSelected = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedState(id);
    city.current?.select(id);
  }, []);
  const setName = (n: string) => {
    setNameState(n);
    store.set({ name: n });
  };

  // ------------------------------------------------------------ renderer + frame loop
  useEffect(() => {
    if (!stage.current || !labelsRoot.current) return;
    let r: CityRenderer;
    try {
      r = new CityRenderer(stage.current, detectQuality());
    } catch {
      setGlError(true);
      return;
    }
    city.current = r;
    r.setMode('landing');
    labels.current = new LabelLayer(labelsRoot.current, r, (id) => {
      if (screenRef.current !== 'playing') return;
      audio.current.ui('select');
      setSelected(id);
    });
    const onResize = () => r.resize();
    window.addEventListener('resize', onResize);
    let raf = 0;
    let frames = 0;
    let t0 = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      r.render();
      const g = game.current;
      const playing = screenRef.current === 'playing';
      audio.current.update(g?.sim.state ?? null, playing && !g?.paused);
      labels.current?.update(g?.sim ?? null, selectedRef.current, playing);
      // adaptive quality: drop to low if the device can't keep up
      frames++;
      const now = performance.now();
      if (now - t0 > 4000) {
        const fps = (frames * 1000) / (now - t0);
        if (fps < 28 && r.quality === 'high' && playing) {
          r.quality = 'low';
          r.renderer.setPixelRatio(1);
          r.resize();
        }
        frames = 0;
        t0 = now;
      }
    };
    raf = requestAnimationFrame(frame);
    const onVis = () => {
      if (document.hidden && screenRef.current === 'playing' && game.current && !game.current.paused) {
        game.current.setPaused(true);
        audio.current.suspend();
        setVersion((v) => v + 1);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      labels.current?.dispose();
      r.dispose();
    };
  }, [setSelected]);

  // ------------------------------------------------------------ audio settings
  useEffect(() => {
    audio.current.setMuted(muted);
    audio.current.setVolume(volume);
    store.set({ muted, volume });
  }, [muted, volume]);

  // ------------------------------------------------------------ game flow
  const begin = (mode: GameMode, seed: number, rivalInfo: RivalInfo | null) => {
    audio.current.init();
    audio.current.ui('confirm');
    setRun({ seed, mode });
    setActiveRival(rivalInfo);
    setOutcome(null);
    setReport(null);
    setBest(null);
    setSelected(null);
    setCount(3);
    setScreen('briefing');
    city.current?.setMode('play');
  };

  // countdown
  useEffect(() => {
    if (screen !== 'briefing') return;
    if (count <= 0) {
      const t = setTimeout(() => go(), 450);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      audio.current.ui('tap');
      setCount((c) => c - 1);
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, count]);

  const go = () => {
    if (screenRef.current !== 'briefing') return;
    const sc = createCrisis(run.seed);
    const g = new GameController(sc, run.mode);
    game.current?.stop();
    game.current = g;
    city.current?.setSim(g.sim);
    g.subscribe(() => setVersion((v) => v + 1));
    g.onAlert = (a: Alert) => {
      audio.current.onAlert(a);
      if (a.level === 'critical' && a.subject) city.current?.attention(a.subject);
    };
    g.onEnd = () => finish(g);
    // ?speed=N plays the same deterministic incident faster (for testing and demos)
    const sp = Number(new URLSearchParams(location.search).get('speed'));
    if (sp > 0 && sp <= 20) g.speed = sp;
    setScreen('playing');
    audio.current.startMusic();
    g.start();
  };

  const finish = (g: GameController) => {
    const o = score(g.sim);
    setOutcome(o);
    const key = `${g.mode}-${g.scenario.seed}`;
    setBest(store.recordBest(key, o.stability));
    setSelected(null);
    setScreen('results');
    city.current?.setMode('results');
    audio.current.stopMusic(0.6);
    setTimeout(() => audio.current.finale(!o.collapsed && o.stability >= 72), 400);
    // the report replays the incident many times: do it off the main thread
    const rec = g.sim.recording;
    try {
      const w = new Worker(new URL('../scoring/report.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<Report>) => {
        setReport(e.data);
        w.terminate();
      };
      w.onerror = () => {
        w.terminate();
        setReport(buildReport(g.scenario, rec));
      };
      w.postMessage({ seed: g.scenario.seed, actions: rec });
    } catch {
      setTimeout(() => setReport(buildReport(g.scenario, rec)), 50);
    }
  };

  const act = (a: Action) => {
    const g = game.current;
    if (!g) return;
    const c = g.act(a);
    if (c.ok) {
      audio.current.relay();
      audio.current.ui('confirm');
    } else audio.current.ui('deny');
    setToast({ text: c.ok ? 'Command sent' : c.reason ?? 'Not possible', ok: c.ok, at: performance.now() });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const togglePause = () => {
    const g = game.current;
    if (!g) return;
    g.setPaused(!g.paused);
    if (g.paused) audio.current.suspend();
    else audio.current.resume();
  };

  // map picking (tap without drag)
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    const pd = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const pu = (e: PointerEvent) => {
      if (!down || screenRef.current !== 'playing') return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const id = city.current?.pick(e.clientX, e.clientY) ?? null;
      if (id) audio.current.ui('select');
      setSelected(id);
    };
    el.addEventListener('pointerdown', pd);
    el.addEventListener('pointerup', pu);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointerdown', pd);
      el.removeEventListener('pointerup', pu);
      window.removeEventListener('keydown', key);
    };
  }, [setSelected]);

  const selectFromUi = (id: string | null) => {
    setSelected(id);
    if (id) {
      audio.current.ui('select');
      city.current?.focusEntity(id, 150);
    }
  };

  const challengeUrl = (() => {
    const g = game.current;
    if (!g || screen !== 'results') return location.origin + location.pathname;
    const code = encodeChallenge({ seed: g.scenario.seed, name: name || 'Operator', mode: g.mode, actions: g.sim.recording });
    return `${location.origin}${location.pathname}#c=${code}`;
  })();

  const g = game.current;
  return (
    <div className={`app screen-${screen}`}>
      <div className="stage" ref={stage} />
      <div className="labels" ref={labelsRoot} />
      <div className="vignette" />
      {g && screen === 'playing' && g.sim.state.collapsed && <div className="collapse-fx" />}
      {glError && <div className="gl-error">Your browser could not start 3D graphics (WebGL). BLACKOUT needs WebGL to draw the city. Try another browser or enable hardware acceleration.</div>}

      {screen === 'landing' && (
        <Landing
          name={name}
          setName={setName}
          onStart={(mode) => begin(mode, mode === 'daily' ? today : randomSeed(), null)}
          challenge={rival}
          onAcceptChallenge={() => rival && begin(rival.mode, rival.seed, rival)}
          dailySeed={today}
          dailyBest={store.get().best?.[`daily-${today}`] ?? null}
          played={store.get().played ?? 0}
        />
      )}
      {screen === 'briefing' && <Briefing count={count} onGo={() => { setCount(0); go(); }} />}
      {screen === 'playing' && g && (
        <>
          <Hud
            sim={g.sim}
            selected={selected}
            onSelect={selectFromUi}
            onAct={act}
            paused={g.paused}
            onPause={togglePause}
            toast={toast}
            audio={{ muted, volume, setMuted: setMutedState, setVolume: setVolumeState }}
            seed={g.scenario.seed}
            mode={g.mode}
          />
          {g.paused && (
            <div className="pause" onClick={togglePause}>
              <div><h2>PAUSED</h2><p>The city is hidden while paused. Tap to resume.</p></div>
            </div>
          )}
        </>
      )}
      {screen === 'results' && outcome && g && (
        <Results
          outcome={outcome}
          report={report}
          name={name}
          setName={setName}
          seed={g.scenario.seed}
          mode={g.mode}
          timeline={g.sim.state.metrics.timeline}
          challengeUrl={challengeUrl}
          rival={activeRival ? { name: activeRival.name, score: activeRival.score, grade: activeRival.grade } : null}
          best={best}
          decisions={g.sim.state.log.filter((l) => l.ok).length}
          onReplay={() => begin(g.mode, g.scenario.seed, activeRival)}
          onNew={() => begin('crisis', randomSeed(), null)}
          onMenu={() => {
            setScreen('landing');
            city.current?.setSim(null);
            city.current?.setMode('landing');
            game.current = null;
            setRival(null);
            history.replaceState(null, '', location.pathname + location.search);
          }}
        />
      )}
    </div>
  );
}
