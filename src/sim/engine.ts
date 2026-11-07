import { components, dcFlow, type FlowLine } from './powerflow';
import type {
  Action, Alert, AlertLevel, GenState, LineState, ScenarioDef, ScenarioEvent, SimState, SubState,
  TimedAction, Vec2, ZoneDef, ZoneState,
} from './types';

// ------------------------------------------------------------------ model constants
// Every constant is part of the documented simplified model (docs/SIMULATION.md).

export const DT = 0.1;
export const TICKS_PER_SECOND = 10;
export const F0 = 50;
/** Load-frequency damping: % change in load per % change in frequency. */
export const LOAD_DAMPING = 1.5;
/** Governor droop (fraction of nominal frequency for 100% output change). */
export const DROOP = 0.04;
export const UFLS_STAGES = [49.0, 48.7, 48.4] as const;
export const UFLS_DELAY = 0.3;
/** Decisions per shift. Keeps every recording small enough to travel in a challenge link. */
export const MAX_ACTIONS = 400;
/** Over-speed (load rejection) response of synchronous units, fraction of rating per second. */
export const OVERSPEED_RATE = 1.0;
/** Minimum time between two UFLS stages operating (stage grading), so the frequency can respond before more load is cut. */
export const UFLS_GRADE = 0.2;
export const GEN_UF_TRIP = 47.5;
export const GEN_OF_TRIP = 52.0;
export const GEN_FREQ_DELAY = 1.0;
/** Line thermal accumulator: (loading² - 1) / LINE_HEAT_K per second; trips at 1. */
export const LINE_HEAT_K = 5;
export const LINE_INSTANT_TRIP = 2.0;
export const XFMR_AMBIENT = 35;
export const XFMR_RISE = 70;
export const XFMR_TAU = 10;
export const XFMR_ALARM = 110;
export const XFMR_TRIP = 140;
export const XFMR_DAMAGE_START = 125;
export const XFMR_RESET_TEMP = 90;
export const INCIPIENT_THRESHOLD = 0.7;
export const INCIPIENT_RATE = 1 / 6;
export const TRANSFER_SECONDS = 1.5;
export const CURTAIL_SECONDS = 12;
export const MAX_PROTECTED = 3;
export const CREW_SPEED = 9;
export const CREW_WORK: Record<string, number> = { line: 10, ats: 8, sub: 6 };
export const INVESTIGATE_SECONDS = 4;
export const MOBILE_GEN_MW = 8;
export const MOBILE_GEN_SPEED = 7;
export const COLD_LOAD_MAX = 0.4;
export const COLD_LOAD_DECAY = 10;
export const FAULT_CLOSE_HEAT = 12;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const dist = (a: Vec2, b: Vec2) => { const dx = a[0] - b[0]; const dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); };

export function windAt(curve: [number, number][], t: number): number {
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i];
    const [t0, v0] = curve[i - 1];
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return curve[curve.length - 1][1];
}

export const fmtTime = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export interface Check {
  ok: boolean;
  reason?: string;
}

/**
 * The engine. Owns one SimState and advances it in fixed 0.1 s ticks.
 * Player actions are queued and applied at the start of the next tick, so a recording of
 * (tick, action) pairs replays exactly.
 */
export class Simulation {
  readonly scenario: ScenarioDef;
  state: SimState;
  private pending: Action[] = [];
  private busIndex = new Map<string, number>();
  readonly recording: TimedAction[] = [];

  constructor(scenario: ScenarioDef) {
    this.scenario = scenario;
    scenario.network.buses.forEach((b, i) => this.busIndex.set(b.id, i));
    this.state = this.initialState();
    this.solveNetwork();
  }

  get net() {
    return this.scenario.network;
  }

  zoneDef(id: string) {
    return this.net.zones.find((z) => z.id === id)!;
  }

  // ---------------------------------------------------------------- setup

  private initialState(): SimState {
    const sc = this.scenario;
    const gens: Record<string, GenState> = {};
    for (const g of sc.network.generators) {
      gens[g.id] = { online: true, pm: g.initial, pe: g.initial, setpoint: g.initial, freq: F0, overload: 0, freqTripTimer: 0 };
    }
    const lines: Record<string, LineState> = {};
    for (const l of sc.network.lines) {
      lines[l.id] = { closed: true, tripped: false, faulted: false, heat: 0, flow: 0, loading: 0, energised: true };
    }
    const subs: Record<string, SubState> = {};
    for (const s of sc.network.substations) {
      const load = sc.network.zones.filter((z) => z.primary === s.id).reduce((a, z) => a + z.load, 0);
      const L = load / s.rating;
      subs[s.id] = {
        closed: true, tripped: false, damaged: false, temp: XFMR_AMBIENT + XFMR_RISE * L * L, health: 1,
        faultProgress: 0, load, loading: L, measured: L, voltage: 1, energised: true, freq: F0,
      };
    }
    const zones: Record<string, ZoneState> = {};
    for (const z of sc.network.zones) {
      zones[z.id] = {
        breaker: true, feed: 'primary', transferTimer: 0, served: true, shedBy: null, demand: z.load, drawn: z.load,
        powered: 1, offTime: 0, coldLoad: 0, curtail: 1, curtailing: false, protected: false,
        backup: z.critical?.backup ? 'off' : 'none', backupTimer: 0,
        ups: z.id === 'Z06' ? sc.dcUps : (z.critical?.backup?.ups ?? 0),
        atsFailed: z.id === sc.atsFailed, criticalUp: true, criticalDegraded: false, criticalDown: 0, mobileGen: false,
      };
    }
    const criticalIds = sc.network.zones.filter((z) => z.critical).map((z) => z.critical!.id);
    return {
      tick: 0, time: 0, gens, lines, subs, zones,
      crews: [
        { id: 'Crew A', pos: sc.network.depot, status: 'idle', timer: 0 },
        { id: 'Crew B', pos: sc.network.depot, status: 'idle', timer: 0 },
      ],
      investigation: null, known: {},
      mobile: { status: 'ready', timer: 0 },
      internal: { eventsDone: 0, extraDemand: {}, uflsTimers: {}, uflsLastTick: -1000 },
      uflsStage: 0, wind: windAt(sc.windCurve, 0), totalDemand: 0, totalServed: 0, totalGen: 0, freq: F0,
      alerts: [], alertKeys: {}, collapsed: false, collapseTick: -1, ended: false,
      metrics: {
        servedEnergy: 0, demandEnergy: 0, residentSeconds: 0,
        criticalDown: Object.fromEntries(criticalIds.map((id) => [id, 0])),
        criticalLost: Object.fromEntries(criticalIds.map((id) => [id, -1])),
        freqOutside: 0, minFreq: F0, maxFreq: F0, peakDark: 0, uflsShed: 0, unsafeTrip: false, timeline: [],
      },
      log: [],
    };
  }

  // ---------------------------------------------------------------- public API

  /** Queue an action for the next tick. Returns false (and does nothing) if it is not allowed now. */
  queue(action: Action): Check {
    if (this.recording.length + this.pending.length >= MAX_ACTIONS) return { ok: false, reason: `Decision limit reached (${MAX_ACTIONS} per shift).` };
    const c = this.check(action);
    if (c.ok) this.pending.push(action);
    return c;
  }

  get done() {
    return this.state.ended;
  }

  step() {
    if (this.state.ended) return;
    const s = this.state;
    const actions = this.pending;
    this.pending = [];
    for (const a of actions) {
      this.recording.push({ tick: s.tick, action: a });
      this.apply(a);
    }
    this.runEvents();
    this.updateTimers();
    this.updateDemand();
    this.solveNetwork();
    this.protections();
    this.governors();
    this.criticalServices();
    this.accumulate();
    s.tick += 1;
    s.time = s.tick * DT;
    if (s.time >= this.scenario.duration - 1e-9) s.ended = true;
  }

  /** Runs a whole recording to the end (or to `untilTick`). */
  static replay(scenario: ScenarioDef, actions: TimedAction[], untilTick = Infinity): Simulation {
    const sim = new Simulation(scenario);
    const sorted = [...actions].sort((a, b) => a.tick - b.tick);
    let i = 0;
    while (!sim.done && sim.state.tick < untilTick) {
      while (i < sorted.length && sorted[i].tick <= sim.state.tick) {
        sim.queue(sorted[i].action);
        i++;
      }
      sim.step();
    }
    return sim;
  }

  // ---------------------------------------------------------------- checks

  check(a: Action): Check {
    const s = this.state;
    if (s.ended) return { ok: false, reason: 'The incident is over.' };
    const no = (reason: string): Check => ({ ok: false, reason });
    switch (a.type) {
      case 'setpoint': {
        const g = this.net.generators.find((x) => x.id === a.gen);
        const gs = s.gens[a.gen];
        if (!g || !gs) return no('Unknown generator.');
        if (!gs.online) return no(`${g.short} has tripped and cannot be dispatched.`);
        if (g.kind === 'wind' && a.delta > 0 && gs.setpoint >= g.capacity) return no('The wind farm is not curtailed: output is limited by the wind.');
        const max = g.capacity * g.emergencyRating;
        if (a.delta > 0 && gs.setpoint >= max - 1e-6) return no(g.emergencyRating > 1 ? 'Already at emergency rating.' : 'Already at full output.');
        if (a.delta < 0 && gs.setpoint <= g.min + 1e-6) return no('Already at minimum stable output.');
        return { ok: true };
      }
      case 'shed': {
        const z = s.zones[a.zone];
        if (!z) return no('Unknown zone.');
        if (!z.breaker) return no('Already disconnected.');
        return { ok: true };
      }
      case 'restore': {
        const z = s.zones[a.zone];
        if (!z) return no('Unknown zone.');
        if (z.breaker) return no('Feeder breaker is already closed.');
        const sub = this.feedingSub(a.zone);
        if (!this.subAvailable(sub)) return no(`Substation ${sub} is not available.`);
        return { ok: true };
      }
      case 'transfer': {
        const d = this.zoneDef(a.zone);
        const z = s.zones[a.zone];
        if (!d?.alternate) return no('This zone has no alternative feed.');
        if (z.transferTimer > 0) return no('Transfer in progress.');
        const target = z.feed === 'primary' ? d.alternate : d.primary;
        if (!this.subAvailable(target)) return no(`Substation ${target} is not available.`);
        return { ok: true };
      }
      case 'curtail': {
        const d = this.zoneDef(a.zone);
        if (d?.kind !== 'industrial') return no('Only the industrial district has a curtailment contract.');
        if (s.zones[a.zone].curtailing) return { ok: true };
        return { ok: true };
      }
      case 'protect': {
        const d = this.zoneDef(a.zone);
        const z = s.zones[a.zone];
        if (!d || d.uflsStage === 0) return no('This zone is already exempt from automatic load shedding.');
        if (!z.protected && Object.values(s.zones).filter((x) => x.protected).length >= MAX_PROTECTED) return no(`At most ${MAX_PROTECTED} zones can be exempted.`);
        return { ok: true };
      }
      case 'isolateLine': {
        const l = s.lines[a.line];
        if (!l) return no('Unknown line.');
        if (!l.closed || l.tripped) return no('Line is already open.');
        return { ok: true };
      }
      case 'closeLine': {
        const l = s.lines[a.line];
        if (!l) return no('Unknown line.');
        if (l.closed && !l.tripped) return no('Line is already in service.');
        if (this.crewOn(a.line)) return no('A crew is working on this line.');
        return { ok: true };
      }
      case 'isolateSub': {
        const t = s.subs[a.sub];
        if (!t) return no('Unknown substation.');
        if (!t.closed || t.tripped || t.damaged) return no('Transformer is already out of service.');
        return { ok: true };
      }
      case 'energiseSub': {
        const t = s.subs[a.sub];
        if (!t) return no('Unknown substation.');
        if (t.damaged) return no('Transformer is destroyed. It cannot be repaired during the incident.');
        if (t.tripped) return no('Protection operated: a crew must inspect and reset it.');
        if (t.closed) return no('Transformer is already in service.');
        return { ok: true };
      }
      case 'startBackup': {
        const d = this.zoneDef(a.zone);
        const z = s.zones[a.zone];
        if (!d?.critical?.backup) return no('No backup generation here.');
        if (z.backup === 'running' || z.backup === 'starting') return no('Backup generation is already on.');
        if (z.atsFailed) return no('The transfer switch is faulty. Send a repair crew first.');
        return { ok: true };
      }
      case 'dispatchCrew': {
        if (!s.crews.some((c) => c.status === 'idle')) return no('Both crews are busy.');
        if (this.crewOn(a.target)) return no('A crew is already assigned here.');
        const job = this.crewJob(a.target);
        if (!job) return no('Nothing a crew can fix here right now.');
        return { ok: true };
      }
      case 'investigate': {
        if (s.investigation) return no('The analyst is busy with another investigation.');
        if (s.known[a.target]) return no('Already investigated.');
        if (!s.lines[a.target] && !s.subs[a.target]) return no('Only lines and substations can be investigated.');
        return { ok: true };
      }
      case 'mobileGen': {
        if (s.mobile.status !== 'ready') return no('The mobile generator has already been deployed.');
        if (!s.zones[a.zone]) return no('Unknown zone.');
        return { ok: true };
      }
    }
  }

  crewOn(target: string) {
    return this.state.crews.some((c) => c.target === target && c.status !== 'idle');
  }

  /** What a crew would do at a target, or null. */
  crewJob(target: string): 'line' | 'ats' | 'sub' | null {
    const s = this.state;
    if (s.lines[target]) return s.lines[target].tripped || s.lines[target].faulted ? 'line' : null;
    if (s.subs[target]) return s.subs[target].tripped && !s.subs[target].damaged ? 'sub' : null;
    if (s.zones[target]) return s.zones[target].atsFailed ? 'ats' : null;
    return null;
  }

  feedingSub(zone: string) {
    const d = this.zoneDef(zone);
    return this.state.zones[zone].feed === 'primary' ? d.primary : d.alternate!;
  }

  subAvailable(id: string | undefined) {
    if (!id) return false;
    const t = this.state.subs[id];
    return !!t && t.closed && !t.tripped && !t.damaged && t.energised;
  }

  targetPos(target: string): Vec2 {
    const n = this.net;
    const bus = (id: string) => n.buses.find((b) => b.id === id)!.pos;
    const line = n.lines.find((l) => l.id === target);
    if (line) {
      const a = bus(line.from);
      const b = bus(line.to);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    const sub = n.substations.find((x) => x.id === target);
    if (sub) return sub.pos;
    const z = n.zones.find((x) => x.id === target);
    if (z) return z.pos;
    return n.depot;
  }

  label(id: string): string {
    const n = this.net;
    return (
      n.zones.find((z) => z.id === id)?.name ??
      n.substations.find((z) => z.id === id)?.name ??
      n.lines.find((z) => z.id === id)?.name ??
      n.generators.find((z) => z.id === id)?.short ??
      id
    );
  }

  // ---------------------------------------------------------------- grid analysis

  /** Bus loads and generator outputs as they stand this tick. */
  private snapshot() {
    const s = this.state;
    const busLoad = new Array<number>(this.net.buses.length).fill(0);
    for (const z of this.net.zones) {
      const zs = s.zones[z.id];
      if (zs.served) busLoad[this.busIndex.get(this.feedingSub(z.id))!] += zs.drawn;
    }
    const gen: Record<string, number> = {};
    for (const g of this.net.generators) gen[g.id] = s.gens[g.id].online ? s.gens[g.id].pe : 0;
    return { busLoad, gen };
  }

  /**
   * Steady-state flows for a hypothetical dispatch: any mismatch in an island is shared by
   * its synchronous generators in proportion to rating (what droop would do).
   */
  flowsFor(busLoad: number[], gen: Record<string, number>): Record<string, number> {
    const s = this.state;
    const n = this.net;
    const edges: [number, number][] = [];
    for (const l of n.lines) if (s.lines[l.id].closed && !s.lines[l.id].tripped) edges.push([this.busIndex.get(l.from)!, this.busIndex.get(l.to)!]);
    const comp = components(n.buses.length, edges);
    const out: Record<string, number> = {};
    const roots = new Set(comp);
    for (const root of roots) {
      const buses = n.buses.map((_, i) => i).filter((i) => comp[i] === root);
      const local = new Map<number, number>();
      buses.forEach((b, i) => local.set(b, i));
      const gens = n.generators.filter((g) => s.gens[g.id].online && comp[this.busIndex.get(g.bus)!] === root);
      if (!gens.length) continue;
      const inj = new Array<number>(buses.length).fill(0);
      let mismatch = 0;
      for (const b of buses) {
        inj[local.get(b)!] -= busLoad[b];
        mismatch -= busLoad[b];
      }
      for (const g of gens) {
        inj[local.get(this.busIndex.get(g.bus)!)!] += gen[g.id];
        mismatch += gen[g.id];
      }
      const sync = gens.filter((g) => g.kind !== 'wind');
      const share = sync.length ? sync : gens;
      const cap = share.reduce((a, g) => a + g.capacity, 0);
      for (const g of share) inj[local.get(this.busIndex.get(g.bus)!)!] -= (mismatch * g.capacity) / cap;
      const fl: FlowLine[] = [];
      const ids: string[] = [];
      for (const l of n.lines) {
        const ls = s.lines[l.id];
        if (!ls.closed || ls.tripped || comp[this.busIndex.get(l.from)!] !== root) continue;
        fl.push({ index: fl.length, from: local.get(this.busIndex.get(l.from)!)!, to: local.get(this.busIndex.get(l.to)!)!, x: l.x });
        ids.push(l.id);
      }
      const f = dcFlow(buses.length, fl, inj);
      ids.forEach((id, i) => (out[id] = f[i]));
    }
    return out;
  }

  /**
   * For an overloaded line: which single action would relieve it most, and what it would do to
   * the worst other line. This is the operator's contingency tool; it reads the same model the
   * simulation uses, so its advice is exactly as good as the model.
   */
  reliefOptions(lineId: string, limit = 3): { action: Action; label: string; loading: number; worstOther: number }[] {
    const s = this.state;
    const n = this.net;
    const lineDef = n.lines.find((l) => l.id === lineId);
    if (!lineDef || !s.lines[lineId].closed || s.lines[lineId].tripped) return [];
    const base = this.snapshot();
    const out: { action: Action; label: string; loading: number; worstOther: number }[] = [];
    const evaluate = (action: Action, label: string, busLoad: number[], gen: Record<string, number>) => {
      if (!this.check(action).ok) return;
      const f = this.flowsFor(busLoad, gen);
      let worst = 0;
      for (const l of n.lines) if (l.id !== lineId && f[l.id] !== undefined) worst = Math.max(worst, Math.abs(f[l.id]) / l.limit);
      out.push({ action, label, loading: Math.abs(f[lineId] ?? 0) / lineDef.limit, worstOther: worst });
    };
    for (const z of n.zones) {
      const zs = s.zones[z.id];
      if (!zs.served || zs.drawn <= 0) continue;
      const bi = this.busIndex.get(this.feedingSub(z.id))!;
      if (z.kind === 'industrial' && !zs.curtailing) {
        const bl = [...base.busLoad];
        bl[bi] -= zs.drawn * (1 - (z.processMinimum ?? 0) / z.load);
        evaluate({ type: 'curtail', zone: z.id }, `Curtail ${z.name}`, bl, base.gen);
      }
      if (z.critical?.backup && zs.backup === 'off' && !zs.atsFailed) {
        const bl = [...base.busLoad];
        bl[bi] -= Math.min(z.critical.load, z.critical.backup.capacity);
        evaluate({ type: 'startBackup', zone: z.id }, `Run ${z.critical.name} on its own generators`, bl, base.gen);
      }
      if (z.alternate) {
        const target = zs.feed === 'primary' ? z.alternate : z.primary;
        const bl = [...base.busLoad];
        bl[bi] -= zs.drawn;
        bl[this.busIndex.get(target)!] += zs.drawn;
        evaluate({ type: 'transfer', zone: z.id }, `Transfer ${z.name} to ${target}`, bl, base.gen);
      }
      if (!z.critical && z.kind !== 'industrial') {
        const bl = [...base.busLoad];
        bl[bi] -= zs.drawn;
        evaluate({ type: 'shed', zone: z.id }, `Shed ${z.name} (${(z.population / 1000).toFixed(0)}k residents)`, bl, base.gen);
      }
    }
    for (const g of n.generators) {
      if (g.kind === 'wind' || !s.gens[g.id].online) continue;
      for (const d of [10, -10]) {
        const gen = { ...base.gen, [g.id]: base.gen[g.id] + d };
        evaluate({ type: 'setpoint', gen: g.id, delta: d }, `${d > 0 ? 'Raise' : 'Lower'} ${g.short}`, base.busLoad, gen);
      }
    }
    // Rank: options that clear every overload first, cheapest (fewest residents darkened) first;
    // then the rest by how far they get.
    const current = s.lines[lineId].loading;
    const worst = (o: (typeof out)[number]) => Math.max(o.loading, o.worstOther);
    const dark = (o: (typeof out)[number]) => (o.action.type === 'shed' ? this.zoneDef(o.action.zone).population : 0);
    return out
      .filter((o) => o.loading < current - 0.03)
      .sort((a, b) => {
        const fa = worst(a) <= 1 ? 0 : 1;
        const fb = worst(b) <= 1 ? 0 : 1;
        if (fa !== fb) return fa - fb;
        if (fa === 0 && dark(a) !== dark(b)) return dark(a) - dark(b);
        return worst(a) - worst(b);
      })
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- actions

  private note(a: Action, ok: boolean, note: string) {
    this.state.log.push({ tick: this.state.tick, action: a, ok, note });
  }

  private apply(a: Action) {
    const s = this.state;
    const c = this.check(a);
    if (!c.ok) {
      this.note(a, false, c.reason ?? 'not allowed');
      return;
    }
    switch (a.type) {
      case 'setpoint': {
        const g = this.net.generators.find((x) => x.id === a.gen)!;
        const gs = s.gens[a.gen];
        gs.setpoint = clamp(gs.setpoint + a.delta, g.min, g.capacity * g.emergencyRating);
        this.note(a, true, `${g.short} setpoint ${Math.round(gs.setpoint)} MW`);
        break;
      }
      case 'shed': {
        const z = s.zones[a.zone];
        const d = this.zoneDef(a.zone);
        z.breaker = false;
        z.shedBy = 'player';
        if (d.kind === 'industrial' && z.curtail > (d.processMinimum ?? 0) / d.load + 0.05) {
          s.metrics.unsafeTrip = true;
          this.alert('critical', `${d.name} tripped without warning: unsafe process shutdown, gas flaring at the chemical works.`, a.zone, `unsafe-${a.zone}`);
        }
        this.note(a, true, `Disconnected ${d.name}`);
        break;
      }
      case 'restore': {
        const z = s.zones[a.zone];
        z.breaker = true;
        z.shedBy = null;
        this.note(a, true, `Reconnected ${this.zoneDef(a.zone).name}`);
        break;
      }
      case 'transfer': {
        const z = s.zones[a.zone];
        z.transferTimer = TRANSFER_SECONDS;
        this.note(a, true, `Transferring ${this.zoneDef(a.zone).name} to ${z.feed === 'primary' ? this.zoneDef(a.zone).alternate : this.zoneDef(a.zone).primary}`);
        break;
      }
      case 'curtail': {
        const z = s.zones[a.zone];
        z.curtailing = !z.curtailing;
        this.note(a, true, z.curtailing ? 'Requested controlled curtailment of Hafen Industrial' : 'Released Hafen Industrial curtailment');
        if (z.curtailing) this.alert('info', 'Hafen Industrial: controlled ramp-down to process minimum started (12 s).', a.zone, `curtail-${s.tick}`);
        break;
      }
      case 'protect': {
        const z = s.zones[a.zone];
        z.protected = !z.protected;
        this.note(a, true, `${z.protected ? 'Exempted' : 'Removed exemption for'} ${this.zoneDef(a.zone).name} ${z.protected ? 'from' : 'from'} automatic shedding`);
        break;
      }
      case 'isolateLine': {
        s.lines[a.line].closed = false;
        this.note(a, true, `Opened line ${a.line}`);
        break;
      }
      case 'closeLine': {
        const l = s.lines[a.line];
        if (l.faulted) {
          l.closed = true;
          l.tripped = true;
          const def = this.net.lines.find((x) => x.id === a.line)!;
          for (const id of [def.from, def.to]) if (s.subs[id]) s.subs[id].temp += FAULT_CLOSE_HEAT;
          this.alert('critical', `Line ${a.line} closed onto a permanent fault and tripped again. Fault current stressed ${[def.from, def.to].filter((x) => s.subs[x]).join(' and ') || 'the plant'}.`, a.line, `closefault-${s.tick}`);
          this.note(a, true, `Closed line ${a.line} onto a fault`);
        } else {
          l.closed = true;
          l.tripped = false;
          this.note(a, true, `Closed line ${a.line}`);
        }
        break;
      }
      case 'isolateSub': {
        s.subs[a.sub].closed = false;
        for (const z of this.net.zones) if (this.feedingSub(z.id) === a.sub && s.zones[z.id].breaker) s.zones[z.id].shedBy = 'isolation';
        this.note(a, true, `Isolated transformer ${a.sub}`);
        break;
      }
      case 'energiseSub': {
        s.subs[a.sub].closed = true;
        this.note(a, true, `Energised transformer ${a.sub}`);
        break;
      }
      case 'startBackup': {
        const z = s.zones[a.zone];
        const d = this.zoneDef(a.zone);
        z.backup = 'starting';
        z.backupTimer = d.critical!.backup!.startDelay;
        this.note(a, true, `Started backup generation at ${d.name}`);
        this.alert('info', `${d.critical!.name}: backup generators starting (${d.critical!.backup!.startDelay} s).`, a.zone, `bk-start-${a.zone}-${s.tick}`);
        break;
      }
      case 'dispatchCrew': {
        const crew = s.crews.find((x) => x.status === 'idle')!;
        crew.status = 'travelling';
        crew.target = a.target;
        crew.dest = this.targetPos(a.target);
        const eta = dist(crew.pos, crew.dest) / CREW_SPEED;
        crew.timer = eta;
        this.note(a, true, `${crew.id} sent to ${this.label(a.target)}`);
        this.alert('info', `${crew.id} en route to ${this.label(a.target)}, ETA ${Math.ceil(eta)} s.`, a.target, `crew-${s.tick}-${crew.id}`);
        break;
      }
      case 'investigate': {
        s.investigation = { target: a.target, timer: INVESTIGATE_SECONDS };
        this.note(a, true, `Investigating ${a.target}`);
        break;
      }
      case 'mobileGen': {
        const eta = dist(this.net.depot, this.zoneDef(a.zone).pos) / MOBILE_GEN_SPEED;
        s.mobile = { status: 'travelling', zone: a.zone, timer: eta };
        this.note(a, true, `Mobile generator sent to ${this.zoneDef(a.zone).name}`);
        this.alert('info', `Mobile 8 MW generator en route to ${this.zoneDef(a.zone).name}, ETA ${Math.ceil(eta)} s.`, a.zone, 'mobile-send');
        break;
      }
    }
  }

  // ---------------------------------------------------------------- tick phases

  private alert(level: AlertLevel, text: string, subject: string | undefined, key: string) {
    const s = this.state;
    if (s.alertKeys[key] !== undefined) return;
    s.alertKeys[key] = s.tick;
    const a: Alert = { tick: s.tick, level, text, subject, key };
    s.alerts.push(a);
  }

  private rearm(key: string) {
    delete this.state.alertKeys[key];
  }

  private runEvents() {
    const s = this.state;
    const evs = this.scenario.events;
    while (s.internal.eventsDone < evs.length && evs[s.internal.eventsDone].t <= s.time + 1e-9) {
      this.fire(evs[s.internal.eventsDone]);
      s.internal.eventsDone++;
    }
  }

  private fire(e: ScenarioEvent) {
    const s = this.state;
    switch (e.type) {
      case 'notice':
        this.alert(e.level, e.text, e.subject, `notice-${e.t}`);
        break;
      case 'lineFault': {
        const l = s.lines[e.line];
        delete s.known[e.line]; // any earlier investigation of this line is now out of date
        if (!l.closed || l.tripped) {
          l.faulted = e.permanent;
          l.faultCause = e.cause;
          break;
        }
        l.tripped = true;
        l.faulted = e.permanent;
        l.faultCause = e.cause;
        const def = this.net.lines.find((x) => x.id === e.line)!;
        this.alert('critical', `Line ${e.line} ${def.name} tripped: ${e.cause}. Power is rerouting through the remaining network.`, e.line, `trip-${e.line}-${s.tick}`);
        break;
      }
      case 'demandStep': {
        s.internal.extraDemand[e.zone] = (s.internal.extraDemand[e.zone] ?? 0) + e.mw;
        this.alert('info', `${e.reason} (+${e.mw} MW).`, e.zone, `demand-${e.zone}-${e.t}`);
        break;
      }
    }
  }


  private updateTimers() {
    const s = this.state;
    for (const z of this.net.zones) {
      const zs = s.zones[z.id];
      if (zs.transferTimer > 0) {
        zs.transferTimer -= DT;
        if (zs.transferTimer <= 1e-9) {
          zs.transferTimer = 0;
          zs.feed = zs.feed === 'primary' ? 'alternate' : 'primary';
          const sub = this.feedingSub(z.id);
          if (!zs.breaker && zs.shedBy !== 'player') {
            zs.breaker = true;
            zs.shedBy = null;
          }
          if (zs.shedBy === 'isolation') zs.shedBy = null;
          this.alert('info', `${z.name} now fed from substation ${sub} ${this.label(sub)}.`, z.id, `xfer-${z.id}-${s.tick}`);
        }
      }
      // curtailment ramps
      if (z.kind === 'industrial') {
        const minFrac = (z.processMinimum ?? 0) / z.load;
        const rate = (1 - minFrac) / CURTAIL_SECONDS;
        zs.curtail = zs.curtailing ? Math.max(minFrac, zs.curtail - rate * DT) : Math.min(1, zs.curtail + rate * DT);
      }
      if (zs.backup === 'starting') {
        zs.backupTimer -= DT;
        if (zs.backupTimer <= 1e-9) {
          zs.backup = 'running';
          this.alert('success', `${z.critical!.name}: backup generators running (${z.critical!.backup!.capacity} MW).`, z.id, `bk-run-${z.id}`);
        }
      }
    }
    // crews
    for (const c of s.crews) {
      if (c.status === 'idle') continue;
      c.timer -= DT;
      if (c.timer > 1e-9) continue;
      if (c.status === 'travelling') {
        c.status = 'working';
        c.pos = c.dest!;
        const job = this.crewJob(c.target!);
        c.timer = job ? CREW_WORK[job] : 0.1;
        this.alert('info', `${c.id} on site at ${this.label(c.target!)}${job ? `, work takes ${CREW_WORK[job]} s` : ': nothing to repair'}.`, c.target, `crew-site-${s.tick}-${c.id}`);
      } else {
        this.finishCrewJob(c.target!);
        c.status = 'idle';
        c.target = undefined;
      }
    }
    // investigation
    if (s.investigation) {
      s.investigation.timer -= DT;
      if (s.investigation.timer <= 1e-9) {
        const t = s.investigation.target;
        s.known[t] = this.findings(t);
        this.alert('info', `Investigation ${t}: ${s.known[t]}`, t, `inv-${t}`);
        s.investigation = null;
      }
    }
    // mobile generator
    if (s.mobile.status === 'travelling') {
      s.mobile.timer -= DT;
      if (s.mobile.timer <= 1e-9) {
        s.mobile.status = 'connected';
        s.zones[s.mobile.zone!].mobileGen = true;
        this.alert('success', `Mobile generator connected at ${this.zoneDef(s.mobile.zone!).name} (${MOBILE_GEN_MW} MW).`, s.mobile.zone, 'mobile-on');
      }
    }
  }

  private finishCrewJob(target: string) {
    const s = this.state;
    if (s.lines[target]) {
      const l = s.lines[target];
      l.faulted = false;
      l.heat = 0;
      this.alert('success', `Line ${target} repaired and tested. Ready to close.`, target, `fix-${target}-${s.tick}`);
      s.known[target] = 'Repaired, no fault present.';
    } else if (s.subs[target]) {
      const t = s.subs[target];
      if (t.temp > XFMR_RESET_TEMP) {
        this.alert('warning', `${target} transformer still too hot to reset (${Math.round(t.temp)} °C, must be below ${XFMR_RESET_TEMP}). Crew standing down.`, target, `reset-hot-${target}-${s.tick}`);
        return;
      }
      t.tripped = false;
      t.closed = true;
      this.alert('success', `${target} ${this.label(target)} transformer inspected, reset and back in service.`, target, `reset-${target}-${s.tick}`);
    } else if (s.zones[target]) {
      const z = s.zones[target];
      z.atsFailed = false;
      this.alert('success', `${this.zoneDef(target).critical!.name}: transfer switch repaired. Backup will start automatically.`, target, `ats-${target}`);
    }
  }

  private findings(target: string): string {
    const s = this.state;
    const h = this.scenario.hidden;
    if (s.lines[target]) {
      const l = s.lines[target];
      if (l.faulted) return `Permanent fault (${l.faultCause}). Do not reclose: send a crew.`;
      if (l.tripped) return 'No fault found. Safe to reclose.';
      return 'No fault found on this line.';
    }
    const parts: string[] = [];
    if (target === h.incipientFault && !s.subs[target].damaged)
      parts.push(`Dissolved-gas test shows an incipient internal fault. Above ${Math.round(INCIPIENT_THRESHOLD * 100)}% loading it will fail.`);
    if (target === h.sensorDrift.sub)
      parts.push(`Loading sensor is drifting: it over-reads by about ${Math.round(h.sensorDrift.bias * 100)} points. The panel now shows the true loading.`);
    return parts.length ? parts.join(' ') : 'Transformer and sensors healthy.';
  }

  private updateDemand() {
    const s = this.state;
    const growth = 1 + (this.scenario.demandGrowth * s.time) / this.scenario.duration;
    s.wind = windAt(this.scenario.windCurve, s.time);
    for (const z of this.net.zones) {
      const zs = s.zones[z.id];
      const base = (z.load + (s.internal.extraDemand[z.id] ?? 0)) * growth * zs.curtail;
      zs.demand = base * (1 + zs.coldLoad);
      if (zs.coldLoad > 0) zs.coldLoad = Math.max(0, zs.coldLoad - (COLD_LOAD_MAX / COLD_LOAD_DECAY) * DT);
    }
  }

  /** Topology, served zones, frequency and DC power flow for every island. */
  private solveNetwork() {
    const s = this.state;
    const n = this.net;
    const B = n.buses.length;
    const edges: [number, number][] = [];
    for (const l of n.lines) {
      const ls = s.lines[l.id];
      if (ls.closed && !ls.tripped) edges.push([this.busIndex.get(l.from)!, this.busIndex.get(l.to)!]);
    }
    const comp = components(B, edges);
    const genBus = (id: string) => this.busIndex.get(n.generators.find((g) => g.id === id)!.bus)!;
    const islands = new Map<number, string[]>();
    for (const g of n.generators) {
      if (!s.gens[g.id].online) continue;
      const root = comp[genBus(g.id)];
      if (!islands.has(root)) islands.set(root, []);
      islands.get(root)!.push(g.id);
    }
    // Grid-following wind inverters need a synchronous machine to follow: an island that holds
    // only wind cannot keep a voltage or frequency, so its inverters disconnect at once.
    for (const [root, ids] of [...islands]) {
      if (ids.some((id) => n.generators.find((g) => g.id === id)!.kind !== 'wind')) continue;
      for (const id of ids) {
        const gs = s.gens[id];
        gs.online = false;
        gs.trip = 'islanded without a synchronous machine to follow';
        gs.pm = 0;
        gs.pe = 0;
        this.alert('critical', `${n.generators.find((g) => g.id === id)!.name} disconnected: cut off from the rest of the grid, its inverters have nothing to follow.`, id, `gtrip-${id}`);
      }
      islands.delete(root);
    }

    // energised buses
    const energisedRoot = (busId: string) => islands.has(comp[this.busIndex.get(busId)!]);
    for (const sub of n.substations) s.subs[sub.id].energised = energisedRoot(sub.id);
    for (const l of n.lines) {
      const ls = s.lines[l.id];
      ls.energised = ls.closed && !ls.tripped && energisedRoot(l.from);
    }

    // zones served and drawn power
    const busLoad = new Array<number>(B).fill(0);
    let totalDemand = 0;
    for (const z of n.zones) {
      const zs = s.zones[z.id];
      totalDemand += zs.demand;
      const sub = this.feedingSub(z.id);
      const t = s.subs[sub];
      const wasServed = zs.served;
      zs.served = zs.breaker && zs.transferTimer <= 0 && t.closed && !t.tripped && !t.damaged && t.energised;
      if (zs.served && !wasServed && zs.offTime > 3) zs.coldLoad = COLD_LOAD_MAX * Math.min(1, zs.offTime / 15);
      if (zs.served) zs.offTime = 0;
      else zs.offTime += DT;
      let drawn = zs.served ? zs.demand : 0;
      if (zs.served && z.critical?.backup && zs.backup === 'running') {
        drawn -= Math.min(z.critical.load, z.critical.backup.capacity) * (zs.demand / Math.max(1e-6, z.load));
      }
      if (zs.served && zs.mobileGen) drawn -= MOBILE_GEN_MW;
      zs.drawn = Math.max(0, drawn);
      if (zs.served) busLoad[this.busIndex.get(sub)!] += zs.drawn;
    }

    // per-island frequency and flows
    const flowsOut = new Map<string, number>();
    let totalGen = 0;
    let totalServed = 0;
    for (const [root, genIds] of islands) {
      const buses: number[] = [];
      for (let i = 0; i < B; i++) if (comp[i] === root) buses.push(i);
      const local = new Map<number, number>();
      buses.forEach((b, i) => local.set(b, i));
      // island frequency: inertia-weighted average of its rotors
      let hs = 0;
      let fsum = 0;
      let pm = 0;
      for (const id of genIds) {
        const g = n.generators.find((x) => x.id === id)!;
        const w = g.inertiaH * g.capacity;
        hs += w;
        fsum += w * s.gens[id].freq;
        pm += s.gens[id].pm;
      }
      const f = fsum / hs;
      const damp = 1 + (LOAD_DAMPING * (f - F0)) / F0;
      let pl = 0;
      for (const b of buses) pl += busLoad[b] * damp;
      const dP = pm - pl;
      const fNext = f + ((F0 * dP) / (2 * hs)) * DT;
      const inj = new Array<number>(buses.length).fill(0);
      for (const id of genIds) {
        const g = n.generators.find((x) => x.id === id)!;
        const gs = s.gens[id];
        gs.pe = gs.pm - (dP * g.inertiaH * g.capacity) / hs;
        gs.freq = fNext;
        inj[local.get(genBus(id))!] += gs.pe;
        totalGen += gs.pe;
      }
      for (const b of buses) inj[local.get(b)!] -= busLoad[b] * damp;
      totalServed += pl;
      const fl: FlowLine[] = [];
      const ids: string[] = [];
      for (const l of n.lines) {
        const ls = s.lines[l.id];
        if (!ls.closed || ls.tripped) continue;
        const a = this.busIndex.get(l.from)!;
        if (comp[a] !== root) continue;
        fl.push({ index: fl.length, from: local.get(a)!, to: local.get(this.busIndex.get(l.to)!)!, x: l.x });
        ids.push(l.id);
      }
      // the reference bus is local index 0; move it to a generator bus for stability
      const flows = dcFlow(buses.length, fl, inj);
      ids.forEach((id, i) => flowsOut.set(id, flows[i]));
      for (const b of buses) {
        const sub = n.buses[b].id;
        if (s.subs[sub]) s.subs[sub].freq = fNext;
      }
    }
    for (const l of n.lines) {
      const ls = s.lines[l.id];
      ls.flow = flowsOut.get(l.id) ?? 0;
      ls.loading = Math.abs(ls.flow) / l.limit;
    }
    for (const sub of n.substations) {
      const t = s.subs[sub.id];
      t.load = busLoad[this.busIndex.get(sub.id)!];
      t.loading = t.load / sub.rating;
      const drift = this.scenario.hidden.sensorDrift;
      t.measured = t.loading + (drift.sub === sub.id && t.load > 0 ? drift.bias : 0);
      t.voltage = t.energised && t.closed && !t.tripped && !t.damaged ? 1 - 0.07 * t.loading * t.loading : 0;
      if (!t.energised) t.freq = 0;
    }
    // system frequency = frequency of the largest island
    let best = 0;
    let bestF = 0;
    for (const genIds of islands.values()) {
      const size = genIds.reduce((a, id) => a + s.gens[id].pe, 0);
      if (size >= best) {
        best = size;
        bestF = s.gens[genIds[0]].freq;
      }
    }
    s.freq = islands.size ? bestF : 0;
    s.totalDemand = totalDemand;
    s.totalServed = totalServed;
    s.totalGen = totalGen;
  }

  private protections() {
    const s = this.state;
    const n = this.net;
    // lines: thermal accumulator
    for (const l of n.lines) {
      const ls = s.lines[l.id];
      if (!ls.closed || ls.tripped) {
        ls.heat = Math.max(0, ls.heat - 0.05 * DT);
        continue;
      }
      const L = ls.loading;
      if (L > 1) ls.heat += ((L * L - 1) / LINE_HEAT_K) * DT;
      else ls.heat = Math.max(0, ls.heat - (1 - L * L) * 0.05 * DT);
      if (L > 1.0) this.alert('warning', `Line ${l.id} ${l.name} overloaded at ${Math.round(L * 100)}%. Overcurrent protection will trip it.`, l.id, `ol-${l.id}`);
      else if (L < 0.95) this.rearm(`ol-${l.id}`);
      if (ls.heat >= 1 || L > LINE_INSTANT_TRIP) {
        ls.tripped = true;
        ls.heat = 0.5;
        delete s.known[l.id];
        this.alert('critical', `Line ${l.id} ${l.name} tripped on overload. Its ${Math.round(Math.abs(ls.flow))} MW is shifting onto neighbouring lines.`, l.id, `trip-${l.id}-${s.tick}`);
      }
    }
    // transformers
    for (const sub of n.substations) {
      const t = s.subs[sub.id];
      const inService = t.closed && !t.tripped && !t.damaged && t.energised;
      const L = inService ? t.loading : 0;
      const tss = XFMR_AMBIENT + XFMR_RISE * L * L;
      t.temp += ((tss - t.temp) / XFMR_TAU) * DT;
      if (t.damaged) continue;
      if (t.measured > 1 && inService) this.alert('critical', `Substation ${sub.id} ${sub.name} is experiencing abnormal loading (${Math.round(t.measured * 100)}%).`, sub.id, `load-${sub.id}`);
      else if (t.measured < 0.92) this.rearm(`load-${sub.id}`);
      if (t.temp > XFMR_ALARM) this.alert('warning', `Transformer ${sub.id} ${sub.name} over temperature: ${Math.round(t.temp)} °C. Protection trips at ${XFMR_TRIP} °C.`, sub.id, `hot-${sub.id}`);
      else if (t.temp < XFMR_ALARM - 8) this.rearm(`hot-${sub.id}`);
      if (t.temp > XFMR_DAMAGE_START) t.health -= ((t.temp - XFMR_DAMAGE_START) / 150) * DT;
      if (sub.id === this.scenario.hidden.incipientFault && inService) {
        t.faultProgress += Math.max(0, L - INCIPIENT_THRESHOLD) * INCIPIENT_RATE * DT;
        if (t.faultProgress > 0.35) this.alert('warning', `Transformer ${sub.id} ${sub.name}: gas-in-oil (Buchholz) alarm. Cause unknown.`, sub.id, `gas-${sub.id}`);
      }
      if (t.health <= 0 || t.faultProgress >= 1) {
        t.damaged = true;
        const why = t.faultProgress >= 1 ? 'internal arc fault' : 'insulation burnt out by overheating';
        this.alert('critical', `Transformer ${sub.id} ${sub.name} destroyed: ${why}. Out of service for weeks.`, sub.id, `dmg-${sub.id}`);
        continue;
      }
      if (inService && t.temp >= XFMR_TRIP) {
        t.tripped = true;
        this.alert('critical', `Transformer ${sub.id} ${sub.name} tripped on over-temperature. Downstream zones have lost supply.`, sub.id, `xtrip-${sub.id}-${s.tick}`);
      }
    }
    // under-frequency load shedding (per island frequency at the zone's substation)
    // Stages are time-graded: after one stage operates, the next may only operate UFLS_GRADE
    // seconds later, and only if the frequency is still below its own threshold.
    const graded = (s.tick - s.internal.uflsLastTick) * DT >= UFLS_GRADE - 1e-9;
    let operated = false;
    for (let stage = 1; stage <= UFLS_STAGES.length; stage++) {
      const thr = UFLS_STAGES[stage - 1];
      const shed: string[] = [];
      const allowed = graded && !operated;
      for (const z of n.zones) {
        if (z.uflsStage !== stage) continue;
        const zs = s.zones[z.id];
        if (!zs.served || zs.protected) continue;
        const t = s.subs[this.feedingSub(z.id)];
        const key = `ufls-${z.id}`;
        const timerKey = `uflsT-${z.id}`;
        if (t.freq > 0 && t.freq < thr) {
          s.internal.uflsTimers[timerKey] = (s.internal.uflsTimers[timerKey] ?? 0) + DT;
          if (allowed && s.internal.uflsTimers[timerKey] >= UFLS_DELAY - 1e-9) {
            zs.breaker = false;
            zs.shedBy = 'ufls';
            s.metrics.uflsShed += zs.demand;
            shed.push(z.name);
            s.internal.uflsTimers[timerKey] = 0;
            this.rearm(key);
          }
        } else s.internal.uflsTimers[timerKey] = 0;
      }
      if (shed.length) {
        operated = true;
        s.internal.uflsLastTick = s.tick;
        s.uflsStage = Math.max(s.uflsStage, stage);
        this.alert('critical', `Automatic under-frequency load shedding, stage ${stage} (${thr.toFixed(1)} Hz): ${shed.join(', ')} disconnected.`, undefined, `ufls-stage-${stage}-${s.tick}`);
      }
    }
    // generators
    for (const g of n.generators) {
      const gs = s.gens[g.id];
      if (!gs.online) continue;
      if (gs.freq < GEN_UF_TRIP || gs.freq > GEN_OF_TRIP) gs.freqTripTimer += DT;
      else gs.freqTripTimer = 0;
      if (gs.pm > g.capacity + 1e-6) gs.overload += DT;
      else gs.overload = Math.max(0, gs.overload - 0.5 * DT);
      if (g.overloadSeconds > 0 && gs.overload > g.overloadSeconds * 0.6) this.alert('warning', `${g.short} running above rating for ${Math.round(gs.overload)} s. It trips at ${g.overloadSeconds} s.`, g.id, `gen-ol-${g.id}`);
      else if (gs.overload < 1) this.rearm(`gen-ol-${g.id}`);
      let trip: string | undefined;
      if (gs.freqTripTimer >= GEN_FREQ_DELAY - 1e-9) trip = gs.freq < F0 ? `under-frequency (${gs.freq.toFixed(1)} Hz)` : `over-frequency (${gs.freq.toFixed(1)} Hz)`;
      if (g.overloadSeconds > 0 && gs.overload >= g.overloadSeconds) trip = 'exhaust over-temperature after sustained emergency output';
      if (trip) {
        gs.online = false;
        gs.trip = trip;
        gs.pm = 0;
        gs.pe = 0;
        this.alert('critical', `${g.name} TRIPPED: ${trip}.`, g.id, `gtrip-${g.id}`);
      }
    }
    if (!s.collapsed && n.generators.every((g) => !s.gens[g.id].online)) {
      s.collapsed = true;
      s.collapseTick = s.tick;
      this.alert('critical', 'TOTAL BLACKOUT. All generation lost. Nova City is dark.', undefined, 'collapse');
    }
    // frequency warnings
    const f = s.freq;
    if (f > 0 && f < 49.5) this.alert('warning', `Grid frequency ${f.toFixed(2)} Hz: generation is not keeping up with demand.`, undefined, 'f-low');
    else if (f > 49.7) this.rearm('f-low');
    if (f > 0 && f < 49.2) this.alert('critical', f < 49.0 ? `Grid frequency ${f.toFixed(2)} Hz: automatic load shedding is operating.` : `Grid frequency ${f.toFixed(2)} Hz: automatic load shedding starts at 49.0 Hz.`, undefined, 'f-crit');
    else if (f > 49.5) this.rearm('f-crit');
    if (f > 50.6) this.alert('warning', `Grid frequency ${f.toFixed(2)} Hz: too much generation. Generators trip at ${GEN_OF_TRIP} Hz.`, undefined, 'f-high');
    else if (f < 50.3) this.rearm('f-high');
  }

  private governors() {
    const s = this.state;
    for (const g of this.net.generators) {
      const gs = s.gens[g.id];
      if (!gs.online) continue;
      let target: number;
      let up = g.ramp * DT;
      let down = g.ramp * DT;
      if (g.kind === 'wind') {
        // inverter-based: follows the wind, can only curtail (on over-frequency)
        target = Math.min(gs.setpoint, s.wind);
        if (gs.freq > F0 + 0.2) target -= g.capacity * (gs.freq - F0 - 0.2) * 0.5;
        target = Math.max(0, target);
        down = 1e9;
      } else {
        // droop: limited headroom upwards, generous load-rejection response downwards
        // Downwards the full droop range applies (down to the unit's minimum), and over-speed
        // control closes valves or guide vanes at up to half the rating per second.
        const droop = clamp((-(gs.freq - F0) / (DROOP * F0)) * g.capacity, -g.capacity, g.droopLimit * g.capacity);
        // Above 51 Hz the unit may drop below its minimum stable output to no-load (load
        // rejection), so a lightly loaded island settles instead of over-speeding.
        const floor = gs.freq > F0 + 1 ? 0 : g.min;
        target = clamp(gs.setpoint + droop, floor, g.capacity * g.emergencyRating);
        down = Math.max(g.ramp * 6, OVERSPEED_RATE * g.capacity) * DT;
      }
      gs.pm += clamp(target - gs.pm, -down, up);
    }
  }

  private criticalServices() {
    const s = this.state;
    for (const z of this.net.zones) {
      const c = z.critical;
      if (!c) continue;
      const zs = s.zones[z.id];
      const wasUp = zs.criticalUp;
      zs.criticalDegraded = false;
      if (zs.served) {
        if (zs.backup !== 'running') zs.ups = Math.min(zs.ups + DT * 0.2, this.upsCapacity(z));
        zs.criticalUp = true;
        if (c.minVoltage) {
          const v = s.subs[this.feedingSub(z.id)].voltage;
          if (v < c.minVoltage + 0.007) this.alert('critical', `${c.name} is approaching its minimum supply threshold (${(v * 100).toFixed(1)}% voltage).`, z.id, `minv-${z.id}`);
          else this.rearm(`minv-${z.id}`);
          if (v < c.minVoltage) {
            zs.criticalDegraded = true;
            this.alert('warning', `${c.name}: supply below minimum. Trains running at reduced speed.`, z.id, `degr-${z.id}`);
          } else if (v > c.minVoltage + 0.01) this.rearm(`degr-${z.id}`);
        }
      } else {
        // grid lost: backup and UPS
        if (c.backup && zs.backup === 'off' && c.backup.autoStart && !zs.atsFailed) {
          zs.backup = 'starting';
          zs.backupTimer = c.backup.startDelay;
          this.alert('info', `${c.name}: grid lost, backup generators starting automatically.`, z.id, `bk-auto-${z.id}-${s.tick}`);
        }
        if (zs.backup === 'running') zs.criticalUp = true;
        else if (zs.ups > 0) {
          zs.ups = Math.max(0, zs.ups - DT);
          zs.criticalUp = true;
          if (c.backup) this.alert('critical', `${c.name} running on battery: ${Math.ceil(zs.ups)} s of autonomy left.`, z.id, `ups-${z.id}`);
        } else zs.criticalUp = false;
      }
      if (zs.served || zs.backup === 'running') this.rearm(`ups-${z.id}`);
      if (wasUp && !zs.criticalUp) {
        this.alert('critical', `${c.name} has lost power.`, z.id, `down-${z.id}-${s.tick}`);
        if (s.metrics.criticalLost[c.id] < 0) s.metrics.criticalLost[c.id] = s.tick;
      }
      if (!wasUp && zs.criticalUp) this.alert('success', `${c.name} power restored.`, z.id, `up-${z.id}-${s.tick}`);
      if (!zs.criticalUp) zs.criticalDown += DT;
    }
  }

  upsCapacity(z: ZoneDef) {
    return z.id === 'Z06' ? this.scenario.dcUps : (z.critical?.backup?.ups ?? 0);
  }

  private accumulate() {
    const s = this.state;
    const m = s.metrics;
    let dark = 0;
    let resident = 0;
    let demand = 0;
    let served = 0;
    for (const z of this.net.zones) {
      const zs = s.zones[z.id];
      let powered = zs.served ? 1 : 0;
      if (!zs.served && zs.mobileGen) {
        const residentLoad = Math.max(1e-6, zs.demand - (z.critical?.load ?? 0));
        powered = Math.min(1, MOBILE_GEN_MW / residentLoad);
      }
      zs.powered = powered;
      resident += z.population * powered;
      dark += z.population * (1 - powered);
      demand += zs.demand / (1 + zs.coldLoad);
      served += zs.served ? zs.demand / (1 + zs.coldLoad) : 0;
      if (z.critical) {
        const down = !zs.criticalUp ? 1 : zs.criticalDegraded ? 0.5 : 0;
        m.criticalDown[z.critical.id] += down * DT;
      }
    }
    m.servedEnergy += served * DT;
    m.demandEnergy += demand * DT;
    m.residentSeconds += resident * DT;
    m.peakDark = Math.max(m.peakDark, dark);
    if (s.freq > 0) {
      m.minFreq = Math.min(m.minFreq, s.freq);
      m.maxFreq = Math.max(m.maxFreq, s.freq);
    }
    if (s.freq < 49.8 || s.freq > 50.2) m.freqOutside += DT;
    if (s.tick % TICKS_PER_SECOND === 0) m.timeline.push({ t: s.time, freq: s.freq, served: demand ? served / demand : 0, dark });
  }
}
