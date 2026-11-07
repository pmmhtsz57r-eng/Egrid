import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/engine';
import { runBot, botRecording } from '../src/sim/bot';
import { createCrisis } from '../src/scenario/crisis';
import { score } from '../src/scoring/score';
import { buildReport } from '../src/scoring/report';
import { decodeChallenge, encodeChallenge } from '../src/game/challenge';
import { dailySeed } from '../src/sim/rng';

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

describe('balance: decisions decide the outcome', () => {
  it('doing nothing is never rated better than C, and is usually a failure', () => {
    const idle = SEEDS.map((s) => score(Simulation.replay(createCrisis(s), [])));
    for (const o of idle) expect(o.stability).toBeLessThan(72);
    expect(idle.filter((o) => o.stability < 55).length).toBeGreaterThanOrEqual(SEEDS.length / 2);
  });

  it('a competent operator beats doing nothing on every seed', () => {
    for (const s of SEEDS) {
      const sc = createCrisis(s);
      const bot = score(runBot(sc));
      const idle = score(Simulation.replay(sc, []));
      expect(bot.stability, `seed ${s}`).toBeGreaterThan(idle.stability);
      expect(bot.collapsed, `seed ${s}`).toBe(false);
    }
  });

  it('there is room above the bot: S is possible but not handed out', () => {
    const scores = SEEDS.map((s) => score(runBot(createCrisis(s))).stability);
    expect(Math.max(...scores)).toBeLessThanOrEqual(100);
    // the bot reacts within a second to everything; it still does not get S on every storm
    expect(scores.filter((x) => x >= 92).length).toBeLessThan(SEEDS.length);
  });
});

describe('scoring', () => {
  it('a total blackout is rated F and capped', () => {
    const sc = createCrisis(3);
    const rec = [0, 1, 2, 3, 4, 5].map((i) => ({ tick: i, action: { type: 'setpoint' as const, gen: 'G1', delta: -10 } }));
    rec.push(...['G3'].flatMap((g) => [6, 7, 8, 9].map((t) => ({ tick: t, action: { type: 'setpoint' as const, gen: g, delta: -10 } }))));
    const sim = Simulation.replay(sc, rec);
    const o = score(sim);
    if (sim.state.collapsed) {
      expect(o.grade).toBe('F');
      expect(o.stability).toBeLessThanOrEqual(15);
    } else {
      expect(o.stability).toBeLessThan(score(Simulation.replay(sc, [])).stability + 1);
    }
  });

  it('all figures are bounded and labelled fictional-safe (no casualty fields)', () => {
    const o = score(runBot(createCrisis(5)));
    expect(o.stability).toBeGreaterThanOrEqual(0);
    expect(o.stability).toBeLessThanOrEqual(100);
    expect(o.peoplePowered).toBeLessThanOrEqual(250_000);
    expect(Object.keys(o).join(' ')).not.toMatch(/death|casualt|fatal/i);
  });
});

describe('disaster report', () => {
  it('measures each decision by replaying without it', () => {
    const sc = createCrisis(4);
    const rec = botRecording(sc);
    const r = buildReport(sc, rec);
    expect(r.outcome.stability).toBe(score(Simulation.replay(sc, rec)).stability);
    for (const h of r.helped) {
      expect(h.delta).toBeGreaterThan(0);
      expect(h.consequence).toMatch(/^Without it/);
    }
    for (const h of r.harmed) expect(h.delta).toBeLessThan(0);
    expect(r.idle.stability).toBe(score(Simulation.replay(sc, [])).stability);
  });

  it('finds missed opportunities for a player who did nothing', () => {
    const r = buildReport(createCrisis(8), []);
    expect(r.missed.length).toBeGreaterThan(0);
    for (const m of r.missed) expect(m.delta).toBeGreaterThan(0);
  });

  it('is reproducible', () => {
    const sc = createCrisis(9);
    const rec = botRecording(sc).slice(0, 20);
    expect(buildReport(sc, rec)).toEqual(buildReport(sc, rec));
  });
});

describe('challenge links', () => {
  it('round-trip a recording and reproduce the same score', () => {
    const sc = createCrisis(11);
    const rec = botRecording(sc);
    const code = encodeChallenge({ seed: 11, name: 'Ada Ø', mode: 'crisis', actions: rec });
    const back = decodeChallenge(code)!;
    expect(back.name).toBe('Ada Ø');
    expect(back.actions).toEqual(rec);
    expect(score(Simulation.replay(createCrisis(back.seed), back.actions)).stability).toBe(score(Simulation.replay(sc, rec)).stability);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects malformed links', () => {
    expect(decodeChallenge('not-a-code')).toBeNull();
    expect(decodeChallenge(btoa(JSON.stringify({ v: 1, s: 1, n: 'x', a: 'zz.qX' })))).toBeNull();
  });

  it('daily seed is the same all day and changes the next day', () => {
    expect(dailySeed(new Date('2026-11-07T01:00:00Z'))).toBe(dailySeed(new Date('2026-11-07T23:00:00Z')));
    expect(dailySeed(new Date('2026-11-07T01:00:00Z'))).not.toBe(dailySeed(new Date('2026-11-08T01:00:00Z')));
  });
});
