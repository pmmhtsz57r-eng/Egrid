import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Simulation, DT, XFMR_TRIP } from '../src/sim/engine';
import { createCrisis } from '../src/scenario/crisis';
import { NOVA_CITY } from '../src/scenario/novaCity';
import type { ScenarioDef, TimedAction } from '../src/sim/types';

/** A calm version of the city: no storm, steady wind, no events. */
function calm(): ScenarioDef {
  const sc = createCrisis(1);
  return { ...sc, events: [], windCurve: [[0, 90], [90, 90]], demandGrowth: 0, hidden: { incipientFault: 'none', sensorDrift: { sub: 'none', bias: 0 } }, atsFailed: 'none' };
}
const run = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) sim.step();
};

describe('Nova City data', () => {
  it('matches the brief: 250,000 people, 3 sources, 8 substations, 12 zones', () => {
    expect(NOVA_CITY.population).toBe(250_000);
    expect(NOVA_CITY.zones.reduce((a, z) => a + z.population, 0)).toBe(250_000);
    expect(NOVA_CITY.generators).toHaveLength(3);
    expect(NOVA_CITY.substations).toHaveLength(8);
    expect(NOVA_CITY.zones).toHaveLength(12);
    expect(NOVA_CITY.zones.filter((z) => z.kind === 'hospital')).toHaveLength(2);
    expect(NOVA_CITY.zones.filter((z) => z.kind === 'rail')).toHaveLength(1);
    expect(NOVA_CITY.zones.filter((z) => z.kind === 'datacentre')).toHaveLength(1);
    expect(NOVA_CITY.zones.filter((z) => z.kind === 'industrial')).toHaveLength(1);
  });

  it('starts balanced: generation equals demand', () => {
    const gen = NOVA_CITY.generators.reduce((a, g) => a + g.initial, 0);
    const load = NOVA_CITY.zones.reduce((a, z) => a + z.load, 0);
    expect(gen).toBe(load);
  });

  it('the simulation code never uses Math.random, Date or the DOM', () => {
    for (const f of readdirSync('src/sim')) {
      const src = readFileSync(`src/sim/${f}`, 'utf8');
      expect(src, f).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|window\.|document\./);
    }
  });
});

describe('steady state', () => {
  it('a calm city holds 50 Hz with every zone served and no line overloaded', () => {
    const sim = new Simulation(calm());
    run(sim, 20);
    expect(Math.abs(sim.state.freq - 50)).toBeLessThan(0.05);
    expect(Object.values(sim.state.zones).every((z) => z.served)).toBe(true);
    expect(Object.values(sim.state.lines).every((l) => l.loading < 1)).toBe(true);
  });
});

describe('determinism', () => {
  it('the same seed builds the same scenario; different seeds differ', () => {
    expect(createCrisis(42)).toEqual(createCrisis(42));
    const variants = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(createCrisis(i + 1).hidden)));
    expect(variants.size).toBeGreaterThan(3);
  });

  it('replaying a recording reproduces the run exactly', () => {
    const sc = createCrisis(7);
    const live = new Simulation(sc);
    const plan: Record<number, Parameters<Simulation['queue']>[0]> = {
      20: { type: 'setpoint', gen: 'G3', delta: 10 }, 55: { type: 'curtail', zone: 'Z02' },
      80: { type: 'dispatchCrew', target: sc.atsFailed }, 120: { type: 'startBackup', zone: 'Z06' }, 300: { type: 'shed', zone: 'Z07' },
    };
    while (!live.done) {
      if (plan[live.state.tick]) live.queue(plan[live.state.tick]);
      live.step();
    }
    const replayed = Simulation.replay(sc, live.recording);
    expect(JSON.stringify(replayed.state)).toBe(JSON.stringify(live.state));
  });
});

describe('network physics', () => {
  it('tripping a line reroutes its flow onto the rest of the network', () => {
    const sim = new Simulation(calm());
    run(sim, 1);
    const before = sim.state.lines.L12.flow;
    sim.state.lines.L11.tripped = true;
    run(sim, 0.2);
    expect(sim.state.lines.L11.flow).toBe(0);
    expect(Math.abs(sim.state.lines.L12.flow)).toBeGreaterThan(Math.abs(before) + 5);
  });

  it('a sustained overload trips a line; the thermal model gives time first', () => {
    const sim = new Simulation(calm());
    sim.state.lines.L11.tripped = true; // pushes L12 over its limit
    run(sim, 1);
    expect(sim.state.lines.L12.loading).toBeGreaterThan(1);
    expect(sim.state.lines.L12.tripped).toBe(false);
    run(sim, 60);
    expect(sim.state.lines.L12.tripped).toBe(true);
  });

  it('isolating a substation de-energises its downstream zones; a transfer restores them', () => {
    const sim = new Simulation(calm());
    run(sim, 1);
    expect(sim.queue({ type: 'isolateSub', sub: 'S06' }).ok).toBe(true);
    run(sim, 0.2);
    expect(sim.state.zones.Z06.served).toBe(false);
    expect(sim.state.zones.Z09.served).toBe(false);
    expect(sim.queue({ type: 'transfer', zone: 'Z09' }).ok).toBe(true);
    run(sim, 2);
    expect(sim.state.zones.Z09.served).toBe(true);
    expect(sim.state.zones.Z09.feed).toBe('alternate');
    expect(sim.state.zones.Z06.served).toBe(false); // the data centre has no alternative feed
  });

  it('an overheated transformer trips and takes its zones with it', () => {
    const sim = new Simulation(calm());
    sim.state.subs.S08.temp = XFMR_TRIP + 1;
    run(sim, 0.2);
    expect(sim.state.subs.S08.tripped).toBe(true);
    run(sim, 0.2);
    expect(sim.state.zones.Z12.served).toBe(false);
  });

  it('disconnecting load raises frequency; adding a deficit lowers it', () => {
    const a = new Simulation(calm());
    a.queue({ type: 'shed', zone: 'Z10' });
    run(a, 2);
    expect(a.state.freq).toBeGreaterThan(50.05);
    const b = new Simulation(calm());
    b.state.gens.G1.setpoint = 110;
    let low = 50;
    for (let i = 0; i < 50; i++) { b.step(); low = Math.min(low, b.state.freq); }
    expect(low).toBeLessThan(49.9);
  });

  it('under-frequency load shedding disconnects stage-1 zones but spares exempted ones', () => {
    const sim = new Simulation(calm());
    sim.queue({ type: 'protect', zone: 'Z07' });
    run(sim, 0.1);
    sim.state.gens.G1.setpoint = 70;
    sim.state.gens.G1.pm = 70;
    let t = 0;
    while (sim.state.uflsStage === 0 && t++ < 200) sim.step();
    expect(sim.state.uflsStage).toBeGreaterThan(0);
    expect(sim.state.zones.Z12.shedBy).toBe('ufls');
    expect(sim.state.zones.Z07.served).toBe(true);
    expect(sim.state.zones.Z03.served).toBe(true); // hospitals are never in the scheme
  });

  it('a gas unit at emergency rating trips once its overload time runs out', () => {
    const base = calm();
    const network = { ...base.network, lines: base.network.lines.map((l) => ({ ...l, limit: l.limit * 3 })) };
    const sim = new Simulation({ ...base, network, windCurve: [[0, 90], [25, 0], [90, 0]] });
    for (let i = 0; i < 6; i++) sim.queue({ type: 'setpoint', gen: 'G1', delta: 10 });
    for (let i = 0; i < 3; i++) sim.queue({ type: 'setpoint', gen: 'G3', delta: 10 });
    run(sim, 26);
    expect(sim.state.gens.G1.pm).toBeGreaterThan(190);
    expect(sim.state.gens.G1.online).toBe(true);
    run(sim, 40);
    expect(sim.state.gens.G1.online).toBe(false);
    expect(sim.state.gens.G1.trip).toMatch(/over-temperature/);
  });

  it('cold-load pickup: a zone reconnected after an outage draws more for a while', () => {
    const sim = new Simulation(calm());
    sim.queue({ type: 'shed', zone: 'Z12' });
    run(sim, 20);
    sim.queue({ type: 'restore', zone: 'Z12' });
    run(sim, 0.3);
    expect(sim.state.zones.Z12.demand).toBeGreaterThan(25 * 1.2);
    run(sim, 15);
    expect(sim.state.zones.Z12.demand).toBeCloseTo(25, 0);
  });
});

describe('backup generation and crews', () => {
  it('a hospital whose transfer switch failed cannot start its backup until a crew repairs it', () => {
    const sc = { ...calm(), atsFailed: 'Z03' };
    const sim = new Simulation(sc);
    expect(sim.check({ type: 'startBackup', zone: 'Z03' }).ok).toBe(false);
    sim.queue({ type: 'shed', zone: 'Z03' });
    run(sim, 14);
    expect(sim.state.zones.Z03.criticalUp).toBe(false); // UPS (12 s) exhausted, no backup
    expect(sim.state.zones.Z03.backup).toBe('off');
    expect(sim.queue({ type: 'dispatchCrew', target: 'Z03' }).ok).toBe(true);
    run(sim, 30);
    expect(sim.state.zones.Z03.atsFailed).toBe(false);
    expect(['starting', 'running']).toContain(sim.state.zones.Z03.backup);
    run(sim, 10);
    expect(sim.state.zones.Z03.criticalUp).toBe(true);
  });

  it('a healthy hospital backup starts itself, bridged by its UPS', () => {
    const sim = new Simulation(calm());
    sim.queue({ type: 'shed', zone: 'Z09' });
    run(sim, 1);
    expect(sim.state.zones.Z09.backup).toBe('starting');
    expect(sim.state.zones.Z09.criticalUp).toBe(true);
    run(sim, 9);
    expect(sim.state.zones.Z09.backup).toBe('running');
    expect(sim.state.metrics.criticalDown.H2).toBe(0);
  });

  it('running the data centre on its own generators takes 10 s and frees grid capacity', () => {
    const sim = new Simulation(calm());
    run(sim, 1);
    const before = sim.state.subs.S06.load;
    sim.queue({ type: 'startBackup', zone: 'Z06' });
    run(sim, 5);
    expect(sim.state.subs.S06.load).toBeCloseTo(before, 0);
    run(sim, 6);
    expect(sim.state.subs.S06.load).toBeLessThan(before - 25);
  });

  it('closing a line onto a permanent fault trips it again; after a crew repair it holds', () => {
    const sc = { ...calm(), events: [{ t: 0.5, type: 'lineFault' as const, line: 'L9', permanent: true, cause: 'test' }] };
    const sim = new Simulation(sc);
    run(sim, 1);
    expect(sim.state.lines.L9.tripped).toBe(true);
    sim.queue({ type: 'closeLine', line: 'L9' });
    run(sim, 0.2);
    expect(sim.state.lines.L9.tripped).toBe(true);
    expect(sim.state.alerts.some((a) => a.key.startsWith('closefault'))).toBe(true);
    sim.queue({ type: 'dispatchCrew', target: 'L9' });
    run(sim, 30);
    expect(sim.state.lines.L9.faulted).toBe(false);
    sim.queue({ type: 'closeLine', line: 'L9' });
    run(sim, 0.5);
    expect(sim.state.lines.L9.tripped).toBe(false);
  });

  it('investigation reveals a drifting sensor and the true loading', () => {
    const sc = createCrisis(1);
    const sim = new Simulation(sc);
    const sub = sc.hidden.sensorDrift.sub;
    expect(sim.state.subs[sub].measured - sim.state.subs[sub].loading).toBeCloseTo(sc.hidden.sensorDrift.bias, 6);
    sim.queue({ type: 'investigate', target: sub });
    run(sim, 5);
    expect(sim.state.known[sub]).toMatch(/drifting/);
  });

  it('a transformer with an incipient fault fails if left loaded, survives if relieved', () => {
    const sc = { ...calm(), hidden: { incipientFault: 'S04', sensorDrift: { sub: 'none', bias: 0 } } };
    const loaded = new Simulation(sc);
    run(loaded, 90);
    expect(loaded.state.subs.S04.damaged).toBe(true);
    const relieved = new Simulation(sc);
    relieved.queue({ type: 'transfer', zone: 'Z07' });
    run(relieved, 90);
    expect(relieved.state.subs.S04.damaged).toBe(false);
  });

  it('rejects impossible actions with a reason instead of faking them', () => {
    const sim = new Simulation(calm());
    expect(sim.check({ type: 'transfer', zone: 'Z06' })).toEqual({ ok: false, reason: 'This zone has no alternative feed.' });
    expect(sim.check({ type: 'curtail', zone: 'Z01' }).ok).toBe(false);
    expect(sim.check({ type: 'energiseSub', sub: 'S01' }).ok).toBe(false);
    const rec: TimedAction[] = [{ tick: 0, action: { type: 'mobileGen', zone: 'Z01' } }, { tick: 5, action: { type: 'mobileGen', zone: 'Z02' } }];
    const r = Simulation.replay(calm(), rec);
    expect(r.state.log.filter((l) => l.ok)).toHaveLength(1);
  });
});
