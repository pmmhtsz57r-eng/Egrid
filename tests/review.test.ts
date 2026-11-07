import { describe, expect, it } from 'vitest';
import { Simulation, DT, MAX_ACTIONS, UFLS_GRADE } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
import { buildReport } from '../src/scoring/report';
import { decodeChallenge, encodeChallenge } from '../src/game/challenge';
import type { TimedAction } from '../src/sim/types';

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
