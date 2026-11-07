import { Simulation, DT } from '../sim/engine';
import type { Action, Alert, ScenarioDef, TimedAction } from '../sim/types';
import type { Check } from '../sim/engine';

export type GameMode = 'crisis' | 'daily';

export interface GameSnapshot {
  sim: Simulation;
  /** 0..1 progress through the current tick, for smooth rendering. */
  alpha: number;
  paused: boolean;
}

/**
 * Drives the simulation in real time: one 0.1 s tick per 100 ms of wall-clock time.
 * The sim itself never sees the clock; this class only decides *when* to call step().
 */
export class GameController {
  readonly sim: Simulation;
  readonly scenario: ScenarioDef;
  readonly mode: GameMode;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  paused = false;
  private alertCursor = 0;
  private listeners = new Set<() => void>();
  onAlert?: (a: Alert) => void;
  onEnd?: (recording: TimedAction[]) => void;
  onTick?: () => void;
  /** Speed multiplier (1 in Crisis; reserved for Engineer mode). */
  speed = 1;

  constructor(scenario: ScenarioDef, mode: GameMode) {
    this.scenario = scenario;
    this.mode = mode;
    this.sim = new Simulation(scenario);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        this.acc += dt * this.speed;
        let steps = 0;
        while (this.acc >= DT && steps < 5 * this.speed && !this.sim.done) {
          this.sim.step();
          this.acc -= DT;
          steps++;
          this.flushAlerts();
          this.onTick?.();
        }
        if (this.sim.done) {
          this.running = false;
          this.emit();
          this.onEnd?.(this.sim.recording);
          return;
        }
        if (steps) this.emit();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get alpha() {
    return Math.min(1, this.acc / DT);
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.last = performance.now();
    this.emit();
  }

  act(a: Action): Check {
    const c = this.sim.queue(a);
    this.emit();
    return c;
  }

  private flushAlerts() {
    const alerts = this.sim.state.alerts;
    while (this.alertCursor < alerts.length) this.onAlert?.(alerts[this.alertCursor++]);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}
