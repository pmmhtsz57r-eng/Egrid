import { describe, expect, it } from 'vitest';
import { Simulation, DT, MAX_ACTIONS, UFLS_GRADE } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
import { buildReport } from '../src/scoring/report';
import { decodeChallenge, encodeChallenge } from '../src/game/challenge';
import type { TimedAction } from '../src/sim/types';
import { threats } from '../src/ui/threats';
import { runBot } from '../src/sim/bot';

const SEEDS = Array.from({ length: 20 }, (_, i) => (i + 1) * 7919);

describe('fixes from review round 1', () => {
  it('UFLS stages are time-graded, never all in one tick', () => {
    for (const seed of SEEDS) {
      const sim = Simulation.replay(createCrisis(seed), []);
      const ticks = sim.state.alerts.filter((a) => a.key.startsWith('ufls-stage-')).map((a) => a.tick);
      for (let i = 1; i < ticks.length; i++) expect((ticks[i] - ticks[i - 1]) * DT).toBeGreaterThanOrEqual(UFLS_GRADE - 1e-9);
    }
  });

  it('doing nothing never ends in a total blackout', () => {
    for (const seed of SEEDS) expect(Simulation.replay(createCrisis(seed), []).state.collapsed).toBe(false);
  });

  it('a simple sensible plan (raise the eastern hydro at the wind warning, curtail industry later) beats doing nothing on average', () => {
    const plan: TimedAction[] = [
      ...[60, 61, 62].map((tick) => ({ tick, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } })),
      { tick: 150, action: { type: 'curtail', zone: 'Z02' } },
    ];
    let idle = 0, planned = 0;
    for (const seed of SEEDS) {
      idle += score(Simulation.replay(createCrisis(seed), [])).stability;
      planned += score(Simulation.replay(createCrisis(seed), plan)).stability;
    }
    expect(planned / SEEDS.length).toBeGreaterThan(idle / SEEDS.length + 5);
  });

  it('a curtail followed by a release is reported as two different decisions, correctly named', () => {
    const rec: TimedAction[] = [
      { tick: 30, action: { type: 'curtail', zone: 'Z02' } },
      { tick: 400, action: { type: 'curtail', zone: 'Z02' } },
    ];
    const r = buildReport(createCrisis(7919), rec);
    const texts = [...r.helped, ...r.harmed].map((d) => d.text);
    for (const t of texts) expect(t).toMatch(/^(Curtailed|Released the curtailment of) Hafen Industrial$/);
    expect(r.decisions).toBe(2);
    expect(r.measured).toBe(2);
  });

  it('the decision cap keeps every recording replayable from a link', () => {
    const sim = new Simulation(createCrisis(5));
    let accepted = 0;
    for (let i = 0; i < MAX_ACTIONS + 50; i++) {
      if (sim.queue({ type: 'investigate', target: i % 2 ? 'L1' : 'L2' }).ok) accepted++;
      sim.step();
    }
    expect(sim.recording.length).toBeLessThanOrEqual(MAX_ACTIONS);
    const code = encodeChallenge({ seed: 5, name: 'x', mode: 'crisis', actions: sim.recording });
    expect(decodeChallenge(code)).not.toBeNull();
    expect(accepted).toBeLessThanOrEqual(MAX_ACTIONS);
  });

  it('an investigation result is withdrawn when the line later trips', () => {
    const sc = createCrisis(7919);
    const second = sc.events.find((e) => e.type === 'lineFault' && e.t > 30)!;
    const line = (second as { line: string }).line;
    const sim = Simulation.replay(sc, [{ tick: 50, action: { type: 'investigate', target: line } }], Math.round(20 / DT));
    expect(sim.state.known[line]).toBeTruthy();
    while (sim.state.time < (second as { t: number }).t + 0.5) sim.step();
    expect(sim.state.known[line]).toBeUndefined();
  });

  it('a snapshot of state carries everything the engine needs (no hidden fields)', () => {
    const sim = Simulation.replay(createCrisis(11), [], 300);
    expect(sim.state.internal.eventsDone).toBeGreaterThan(0);
  });
});

describe('fixes from review round 2', () => {
  const hints = (seed: number): TimedAction[] => [
    ...[50, 51, 52].map((tick) => ({ tick, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } })),
    { tick: 90, action: { type: 'dispatchCrew', target: createCrisis(seed).atsFailed } },
    { tick: 130, action: { type: 'startBackup', zone: 'Z06' } },
  ];

  it('following the in-game hints beats doing nothing on most storms and never blacks the city out', () => {
    let better = 0;
    for (const seed of SEEDS) {
      const idle = score(Simulation.replay(createCrisis(seed), [])).stability;
      const sim = Simulation.replay(createCrisis(seed), hints(seed));
      expect(sim.state.collapsed).toBe(false);
      if (score(sim).stability > idle) better++;
    }
    expect(better).toBeGreaterThanOrEqual(Math.ceil(SEEDS.length * 0.8));
  });

  it('starting the data-centre generators at the UPS warning helps on average', () => {
    let idle = 0, dc = 0;
    for (const seed of SEEDS) {
      idle += score(Simulation.replay(createCrisis(seed), [])).stability;
      dc += score(Simulation.replay(createCrisis(seed), [{ tick: 130, action: { type: 'startBackup', zone: 'Z06' } }])).stability;
    }
    expect(dc).toBeGreaterThan(idle);
  });

  it('island frequency stays physical (no wind-only islands, no runaway)', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      for (const rec of [[], hints(seed)]) {
        const sim = new Simulation(createCrisis(seed));
        let k = 0;
        while (!sim.state.ended) {
          while (k < rec.length && rec[k].tick === sim.state.tick) sim.queue(rec[k++].action);
          sim.step();
          for (const g of Object.values(sim.state.gens)) if (g.online) {
            expect(g.freq).toBeGreaterThan(44);
            expect(g.freq).toBeLessThan(55);
          }
        }
      }
    }
  });

  it('the 400th decision is accepted and applied, the 401st refused', () => {
    const sim = new Simulation(createCrisis(5));
    for (let i = 0; i < MAX_ACTIONS; i++) {
      expect(sim.queue({ type: 'protect', zone: 'Z12' }).ok).toBe(true);
      sim.step();
    }
    expect(sim.queue({ type: 'protect', zone: 'Z12' }).ok).toBe(false);
    expect(sim.state.log.filter((l) => l.ok).length).toBe(MAX_ACTIONS);
  });
});

describe('fixes from review round 3', () => {
  /** A player who reads Most Urgent and taps its suggestion two seconds later, one action every 1.5 s. */
  function reader(seed: number) {
    const sim = new Simulation(createCrisis(seed));
    const seen: Record<string, number> = {};
    let free = 0;
    while (!sim.state.ended) {
      const t = sim.state.tick;
      const list = threats(sim);
      for (const th of list) seen[th.key] ??= t;
      if (t >= free) for (const th of list) {
        if (t - seen[th.key] < 20 || !th.suggest) continue;
        if (sim.queue(th.suggest.action).ok) { free = t + 15; break; }
      }
      sim.step();
    }
    return score(sim);
  }
  const blind = (seed: number): TimedAction[] => [
    ...[1, 2, 3].map((tick) => ({ tick, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } })),
    { tick: 4, action: { type: 'curtail', zone: 'Z02' } },
    { tick: 5, action: { type: 'startBackup', zone: 'Z06' } },
    { tick: 72, action: { type: 'dispatchCrew', target: createCrisis(seed).atsFailed } },
  ];

  it('reading the alerts beats a memorised opening played before any alert', () => {
    let r = 0, b = 0, rs = 0, bs = 0;
    for (const seed of SEEDS) {
      const ro = reader(seed);
      r += ro.stability;
      if (ro.grade === 'S') rs++;
      const o = score(Simulation.replay(createCrisis(seed), blind(seed)));
      b += o.stability;
      if (o.grade === 'S') bs++;
    }
    // following the hints beats the blind opening on average; reaching S takes an operator
    // who reads the storm and anticipates (the scripted expert), not a memorised opening
    expect(r).toBeGreaterThan(b + 5 * SEEDS.length);
    const expertS = SEEDS.filter((seed) => score(runBot(createCrisis(seed))).grade === 'S').length;
    expect(expertS).toBeGreaterThan(bs);
    expect(rs).toBeLessThan(SEEDS.length / 2); // the hints alone do not hand out S
  });

  it('a wind farm cut off by opening its only line comes back when the line is closed', () => {
    const sim = Simulation.replay(createCrisis(7919), [
      { tick: 300, action: { type: 'isolateLine', line: 'L3' } },
      { tick: 320, action: { type: 'closeLine', line: 'L3' } },
    ], 340);
    expect(sim.state.gens.G2.online).toBe(true);
  });

  it('the synchro-check refuses to join islands far apart in frequency', () => {
    const sim = new Simulation(createCrisis(1));
    sim.state.subs.S04.freq = 48.0;
    sim.state.subs.S06.freq = 50.2;
    sim.state.lines.L12.closed = false;
    expect(sim.check({ type: 'closeLine', line: 'L12' }).ok).toBe(false);
    sim.state.subs.S04.freq = 50.1;
    expect(sim.check({ type: 'closeLine', line: 'L12' }).ok).toBe(true);
  });

  it('a burst of clicks across a 3-second boundary is one decision', () => {
    const rec: TimedAction[] = [28, 29, 31, 32].map((tick) => ({ tick, action: { type: 'setpoint' as const, gen: 'G3', delta: 10 } }));
    expect(buildReport(createCrisis(7919), rec).decisions).toBe(1);
  });
});

describe('fixes from review round 4', () => {
  it('Grid analysis never puts a transformer over its rating, or a known-faulty one over 70%, among clearing options', () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const sc = createCrisis(seed);
      const sim = new Simulation(sc);
      sim.state.known[sc.hidden.incipientFault] = 'Dissolved-gas test shows an incipient internal fault.';
      while (!sim.state.ended) {
        sim.step();
        if (sim.state.tick % 10) continue;
        for (const l of sim.net.lines) {
          if (sim.state.lines[l.id].loading <= 1) continue;
          for (const o of sim.reliefOptions(l.id)) {
            if (o.action.type !== 'transfer' || Math.max(o.loading, o.worstOther) > 1) continue;
            const z = sim.zoneDef(o.action.zone);
            const to = sim.state.zones[z.id].feed === 'primary' ? z.alternate! : z.primary;
            const def = sim.net.substations.find((x) => x.id === to)!;
            const after = (sim.state.subs[to].load + sim.state.zones[z.id].drawn) / def.rating;
            expect(after).toBeLessThanOrEqual(1.0001);
            if (to === sc.hidden.incipientFault) expect(after).toBeLessThanOrEqual(0.7001);
          }
        }
      }
    }
  });

  it('a transfer and the transfer back are named by direction', () => {
    const rec: TimedAction[] = [
      { tick: 30, action: { type: 'transfer', zone: 'Z01' } },
      { tick: 200, action: { type: 'transfer', zone: 'Z01' } },
    ];
    const r = buildReport(createCrisis(7919), rec);
    for (const d of [...r.helped, ...r.harmed]) expect(d.text).toMatch(/^(Transferred Altstadt to S02|Moved Altstadt back to its normal feed S01)$/);
  });

  it('the data-centre generators can be stopped to save fuel', () => {
    const sim = Simulation.replay(createCrisis(7919), [{ tick: 10, action: { type: 'startBackup', zone: 'Z06' } }], 250);
    expect(sim.state.zones.Z06.backup).toBe('running');
    const fuel = sim.state.zones.Z06.fuel;
    expect(sim.queue({ type: 'stopBackup', zone: 'Z06' }).ok).toBe(true);
    for (let i = 0; i < 20; i++) sim.step();
    expect(sim.state.zones.Z06.backup).toBe('off');
    expect(sim.state.zones.Z06.fuel).toBeCloseTo(fuel, 0);
  });
});

describe('fixes from review round 6', () => {
  /** Hint follower that keeps its recording, as in round 3. */
  function follow(seed: number, react = 20, gap = 15) {
    const sim = new Simulation(createCrisis(seed));
    const seen: Record<string, number> = {};
    let free = 0;
    while (!sim.state.ended) {
      const t = sim.state.tick;
      const list = threats(sim);
      for (const th of list) seen[th.key] ??= t;
      if (t >= free) for (const th of list) {
        if (t - seen[th.key] < react || !th.suggest) continue;
        if (sim.queue(th.suggest.action).ok) { free = t + gap; break; }
      }
      sim.step();
    }
    return sim;
  }
  const online = (sim: Simulation) => sim.net.generators.filter((g) => sim.state.gens[g.id].online).length;

  it.each([[5, 5], [10, 10], [20, 15]])('a hinted action never sets off automatic shedding or trips a generator within 5 s (tap after %i ticks)', (react, gap) => {
    for (const seed of SEEDS) {
      const sc = createCrisis(seed);
      const rec = follow(seed, react, gap).recording;
      for (let i = 0; i < rec.length; i++) {
        const until = rec[i].tick + 51;
        const withIt = Simulation.replay(sc, rec.slice(0, i + 1), until);
        const without = Simulation.replay(sc, rec.slice(0, i), until);
        const msg = `seed ${seed}, hint ${JSON.stringify(rec[i])}`;
        expect(withIt.state.uflsStage, msg).toBeLessThanOrEqual(without.state.uflsStage);
        expect(online(withIt), msg).toBeGreaterThanOrEqual(online(without));
        expect(withIt.state.collapsed && !without.state.collapsed, msg).toBe(false);
      }
    }
  }, 120_000);

  it('the overload hint names the tool, not the answer', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const sim = new Simulation(createCrisis(seed));
      while (!sim.state.ended) {
        for (const th of threats(sim)) if (th.key.startsWith('ol-') && th.suggest) expect(th.suggest.label).toMatch(/Grid analysis/);
        sim.step();
      }
    }
  });
});
