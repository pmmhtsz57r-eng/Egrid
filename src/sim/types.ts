/**
 * Data model for the BLACKOUT simulation.
 *
 * Definitions (…Def) are static and describe the city. State (…State) changes every tick.
 * Nothing in this folder touches the DOM, the clock or unseeded randomness: the simulation is a pure
 * function of (scenario, seed, recorded actions).
 */

export type Vec2 = readonly [number, number];

export type GeneratorKind = 'gas' | 'wind' | 'hydro';

export interface GeneratorDef {
  id: string;
  name: string;
  short: string;
  kind: GeneratorKind;
  /** Transmission bus the generator feeds. */
  bus: string;
  /** Rated output, MW. */
  capacity: number;
  /** Minimum stable output, MW. */
  min: number;
  /** Short-term emergency rating as a fraction of capacity (1 = none). */
  emergencyRating: number;
  /** Seconds the unit tolerates running above capacity before it trips. */
  overloadSeconds: number;
  /** Ramp limit, MW per second. */
  ramp: number;
  /** Inertia constant H, seconds (stored kinetic energy per MW of rating). */
  inertiaH: number;
  /** Primary (droop) response limit as a fraction of capacity. */
  droopLimit: number;
  initial: number;
  pos: Vec2;
}

export interface BusDef {
  id: string;
  pos: Vec2;
}

export interface LineDef {
  id: string;
  name: string;
  from: string;
  to: string;
  /** Series reactance, per unit on a 100 MVA base. */
  x: number;
  /** Thermal limit, MW. */
  limit: number;
}

export interface SubstationDef {
  id: string;
  name: string;
  /** Transformer rating, MW. */
  rating: number;
  pos: Vec2;
}

export type ZoneKind = 'residential' | 'industrial' | 'hospital' | 'rail' | 'datacentre' | 'emergency';

export interface BackupDef {
  /** MW of critical load the on-site generators can carry. */
  capacity: number;
  /** Seconds from start command to carrying load. */
  startDelay: number;
  /** Starts by itself when the grid is lost. */
  autoStart: boolean;
  /** Seconds the UPS bridges the critical load with no grid and no generator. */
  ups: number;
}

export interface CriticalDef {
  id: string;
  name: string;
  /** MW of the zone's load that is the critical facility. */
  load: number;
  /** People who depend directly on the facility (patients, passengers). Fictional. */
  dependants: number;
  backup?: BackupDef;
  /** Rail: minimum supply voltage (per unit) below which service is degraded. */
  minVoltage?: number;
}

export interface ZoneDef {
  id: string;
  name: string;
  kind: ZoneKind;
  primary: string;
  /** Substation reachable through a normally-open tie switch. */
  alternate?: string;
  /** Base demand at t = 0, MW. */
  load: number;
  /** Fictional residents. */
  population: number;
  critical?: CriticalDef;
  /** Under-frequency load-shedding stage (1..3) or 0 for exempt. */
  uflsStage: 0 | 1 | 2 | 3;
  /** Industrial only: load that cannot be curtailed without an unsafe trip, MW. */
  processMinimum?: number;
  pos: Vec2;
  /** Footprint for rendering. */
  size: Vec2;
}

export interface NetworkDef {
  name: string;
  population: number;
  buses: BusDef[];
  generators: GeneratorDef[];
  lines: LineDef[];
  substations: SubstationDef[];
  zones: ZoneDef[];
  depot: Vec2;
}

// ---------------------------------------------------------------- scenario

export type ScenarioEvent =
  | { t: number; type: 'lineFault'; line: string; permanent: boolean; cause: string }
  | { t: number; type: 'demandStep'; zone: string; mw: number; reason: string }
  | { t: number; type: 'notice'; level: AlertLevel; text: string; subject?: string };

export interface ScenarioDef {
  id: string;
  title: string;
  seed: number;
  duration: number;
  network: NetworkDef;
  /** Available wind output as piecewise-linear [t, MW] points. */
  windCurve: [number, number][];
  /** Demand growth over the scenario as a fraction (0.04 = +4% by the end). */
  demandGrowth: number;
  events: ScenarioEvent[];
  /** Hidden truths revealed only by investigation. */
  hidden: {
    /** Substation whose transformer has an incipient internal fault. */
    incipientFault: string;
    /** Substation whose loading sensor over-reads, and by how much (fraction). */
    sensorDrift: { sub: string; bias: number };
  };
  /** Hospital whose automatic transfer switch failed its test. */
  atsFailed: string;
  /** Data-centre UPS autonomy, seconds (degraded). */
  dcUps: number;
  /** Seconds the data centre's on-site generators can run on the fuel in their day tank. */
  dcFuel: number;
}

// ---------------------------------------------------------------- actions

export type Action =
  | { type: 'setpoint'; gen: string; delta: number }
  | { type: 'shed'; zone: string }
  | { type: 'restore'; zone: string }
  | { type: 'transfer'; zone: string }
  | { type: 'curtail'; zone: string }
  | { type: 'protect'; zone: string }
  | { type: 'isolateLine'; line: string }
  | { type: 'closeLine'; line: string }
  | { type: 'isolateSub'; sub: string }
  | { type: 'energiseSub'; sub: string }
  | { type: 'startBackup'; zone: string }
  | { type: 'dispatchCrew'; target: string }
  | { type: 'investigate'; target: string }
  | { type: 'mobileGen'; zone: string };

export interface TimedAction {
  tick: number;
  action: Action;
}

// ---------------------------------------------------------------- state

export type AlertLevel = 'info' | 'warning' | 'critical' | 'success';

export interface Alert {
  tick: number;
  level: AlertLevel;
  text: string;
  subject?: string;
  key: string;
}

export interface GenState {
  online: boolean;
  /** Mechanical power, MW. */
  pm: number;
  /** Electrical output this tick, MW. */
  pe: number;
  setpoint: number;
  /** Rotor frequency, Hz. */
  freq: number;
  overload: number;
  freqTripTimer: number;
  trip?: string;
}

export interface LineState {
  closed: boolean;
  tripped: boolean;
  /** Hidden: a permanent fault is on the line. */
  faulted: boolean;
  faultCause?: string;
  /** Thermal accumulator; trips at 1. */
  heat: number;
  flow: number;
  loading: number;
  energised: boolean;
}

export interface SubState {
  /** Transformer breaker closed (operator). */
  closed: boolean;
  /** Transformer protection operated. */
  tripped: boolean;
  damaged: boolean;
  temp: number;
  /** Insulation health 1..0. */
  health: number;
  /** Incipient-fault progress (hidden), 0..1. */
  faultProgress: number;
  load: number;
  loading: number;
  /** Loading the operator sees (may be wrong if the sensor drifts). */
  measured: number;
  voltage: number;
  energised: boolean;
  freq: number;
}

export type BackupStatus = 'off' | 'starting' | 'running' | 'failed' | 'none';

export interface ZoneState {
  breaker: boolean;
  feed: 'primary' | 'alternate';
  transferTimer: number;
  served: boolean;
  shedBy: 'player' | 'ufls' | 'isolation' | null;
  /** Actual demand this tick, MW. */
  demand: number;
  /** MW actually drawn from the grid this tick. */
  drawn: number;
  /** Fraction of residents with power (0..1). */
  powered: number;
  offTime: number;
  coldLoad: number;
  curtail: number;
  curtailing: boolean;
  protected: boolean;
  backup: BackupStatus;
  backupTimer: number;
  /** Seconds of on-site fuel left at full load (only the data centre's tank is limited). */
  fuel: number;
  ups: number;
  atsFailed: boolean;
  criticalUp: boolean;
  criticalDegraded: boolean;
  criticalDown: number;
  mobileGen: boolean;
}

export interface Crew {
  id: string;
  pos: Vec2;
  status: 'idle' | 'travelling' | 'working';
  target?: string;
  timer: number;
  dest?: Vec2;
}

export interface Investigation {
  target: string;
  timer: number;
}

export interface Metrics {
  servedEnergy: number;
  demandEnergy: number;
  residentSeconds: number;
  criticalDown: Record<string, number>;
  criticalLost: Record<string, number>;
  freqOutside: number;
  /** MW·s of industrial demand curtailed (paid for under the curtailment contract). */
  curtailedMWs: number;
  minFreq: number;
  maxFreq: number;
  peakDark: number;
  uflsShed: number;
  unsafeTrip: boolean;
  timeline: { t: number; freq: number; served: number; dark: number }[];
}

export interface SimState {
  tick: number;
  time: number;
  gens: Record<string, GenState>;
  lines: Record<string, LineState>;
  subs: Record<string, SubState>;
  zones: Record<string, ZoneState>;
  crews: Crew[];
  investigation: Investigation | null;
  known: Record<string, string>;
  mobile: { status: 'ready' | 'travelling' | 'connected'; zone?: string; timer: number };
  /** Engine bookkeeping. Kept in state so a snapshot or clone resumes exactly. */
  internal: { eventsDone: number; extraDemand: Record<string, number>; uflsTimers: Record<string, number>; uflsLastTick: number };
  uflsStage: number;
  wind: number;
  totalDemand: number;
  totalServed: number;
  totalGen: number;
  freq: number;
  alerts: Alert[];
  alertKeys: Record<string, number>;
  collapsed: boolean;
  collapseTick: number;
  ended: boolean;
  metrics: Metrics;
  /** Decisions as applied, for the report. */
  log: { tick: number; action: Action; ok: boolean; note: string }[];
}
