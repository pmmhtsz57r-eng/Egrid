import type { Alert, SimState } from '../sim/types';

/**
 * Procedural sound. Everything is synthesised with the Web Audio API: no samples, no
 * licensed music. The grid hum is pitched from the simulated frequency, so a sagging grid
 * is something you hear before you read it.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfx!: GainNode;
  private hum: OscillatorNode[] = [];
  private humGain!: GainNode;
  private buzz!: OscillatorNode;
  private buzzGain!: GainNode;
  private rainGain!: GainNode;
  private noise!: AudioBuffer;
  private nextNote = 0;
  private step = 0;
  private intensity = 0;
  private sirenUntil = 0;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  volume = 0.8;
  muted = false;
  private musicOn = false;

  get ready() {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.0;
    this.musicBus.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);

    // noise buffer
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // mains hum: 50 Hz fundamental plus harmonics, low-passed
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.humGain.connect(lp).connect(this.master);
    [1, 2, 3, 6].forEach((h, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.frequency.value = 50 * h;
      const g = ctx.createGain();
      g.gain.value = [0.5, 0.35, 0.12, 0.05][i];
      o.connect(g).connect(this.humGain);
      o.start();
      this.hum.push(o);
    });

    // transformer stress buzz (100 Hz magnetostriction, distorted)
    this.buzz = ctx.createOscillator();
    this.buzz.type = 'sawtooth';
    this.buzz.frequency.value = 100;
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortion(30);
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 1.2;
    this.buzz.connect(shaper).connect(bp).connect(this.buzzGain).connect(this.master);
    this.buzz.start();

    // rain bed
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 1400;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.05;
    rain.connect(rf).connect(this.rainGain).connect(this.master);
    rain.start();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.setVolume(this.volume);
  }

  /** Called every frame with the sim state (or null on menus). */
  update(s: SimState | null, playing: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const f = s && s.freq > 0 ? s.freq : 0;
    const dark = !s || s.freq <= 0 ? 1 : 0;
    for (const [i, o] of this.hum.entries()) o.frequency.setTargetAtTime((f || 50) * [1, 2, 3, 6][i], now, 0.08);
    this.humGain.gain.setTargetAtTime(playing && !dark ? 0.22 : s?.collapsed ? 0 : 0.06, now, 0.3);
    let stress = 0;
    if (s) {
      for (const t of Object.values(s.subs)) if (!t.tripped && !t.damaged) stress = Math.max(stress, (t.temp - 100) / 40, t.measured - 1);
      for (const l of Object.values(s.lines)) if (!l.tripped) stress = Math.max(stress, (l.loading - 1) * 2);
    }
    stress = Math.max(0, Math.min(1, stress));
    this.buzzGain.gain.setTargetAtTime(playing ? stress * 0.12 : 0, now, 0.15);
    this.buzz.frequency.setTargetAtTime(100 + stress * 6, now, 0.2);
    // music intensity from danger and time pressure
    let danger = 0;
    if (s) {
      danger = Math.max(danger, Math.min(1, Math.abs(50 - (f || 48)) / 1.0));
      danger = Math.max(danger, stress);
      danger = Math.max(danger, Math.min(1, s.time / 90) * 0.6);
    }
    this.intensity += (danger - this.intensity) * 0.02;
    if (this.musicOn) this.schedule();
    if (this.sirenOsc && now > this.sirenUntil) this.stopSiren();
  }

  // ---------------------------------------------------------------- music

  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.nextNote = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.musicBus.gain.setTargetAtTime(0.55, this.ctx.currentTime, 1.5);
  }

  stopMusic(fade = 1.5) {
    if (!this.ctx) return;
    this.musicOn = false;
    this.musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
  }

  /** A minor-key pulse whose tempo and density rise with danger. Original, generated live. */
  private schedule() {
    const ctx = this.ctx!;
    const bpm = 96 + this.intensity * 44;
    const sixteenth = 60 / bpm / 4;
    const root = [41.2, 41.2, 36.71, 38.89]; // E1 E1 D1 Eb1, bar by bar
    while (this.nextNote < ctx.currentTime + 0.15) {
      const t = this.nextNote;
      const bar = Math.floor(this.step / 16) % 4;
      const s = this.step % 16;
      const r = root[bar];
      if (s % 4 === 0) this.kick(t, 0.5 + this.intensity * 0.3);
      if (s % 2 === 0 || this.intensity > 0.5) this.bass(t, r * 2, sixteenth * 0.9, s % 4 === 0 ? 0.22 : 0.12);
      if (this.intensity > 0.35 && (s === 4 || s === 12)) this.hat(t, 0.08 + this.intensity * 0.06, true);
      if (s % 2 === 1) this.hat(t, 0.03 + this.intensity * 0.04, false);
      if (s === 0 && bar % 2 === 0) this.pad(t, [r * 8, r * 8 * 1.189, r * 8 * 1.498], sixteenth * 30);
      if (this.intensity > 0.6 && s % 4 === 2) this.blip(t, r * 16 * (s === 6 ? 1.5 : 1.335), 0.05, this.musicBus);
      this.nextNote += sixteenth;
      this.step++;
    }
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private kick(t: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    this.env(g, t, v, 0.005, 0.25);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.3);
  }

  private bass(t: number, f: number, len: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(200 + this.intensity * 900, t);
    filt.frequency.exponentialRampToValueAtTime(90, t + len);
    const g = ctx.createGain();
    this.env(g, t, v, 0.01, len);
    o.connect(filt).connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private hat(t: number, v: number, open: boolean) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = open ? 5000 : 8000;
    const g = ctx.createGain();
    this.env(g, t, v, 0.002, open ? 0.18 : 0.04);
    src.connect(hp).connect(g).connect(this.musicBus);
    src.start(t, Math.random());
    src.stop(t + 0.25);
  }

  private pad(t: number, freqs: number[], len: number) {
    const ctx = this.ctx!;
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 12;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.035, t + len * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(this.musicBus);
      o.start(t);
      o.stop(t + len + 0.1);
    }
  }

  private blip(t: number, f: number, v: number, bus: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = ctx.createGain();
    this.env(g, t, v, 0.003, 0.09);
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 2400;
    o.connect(lp).connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.12);
  }

  // ---------------------------------------------------------------- effects

  ui(kind: 'tap' | 'confirm' | 'deny' | 'select') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'tap') this.blip(t, 1320, 0.05, this.sfx);
    if (kind === 'select') {
      this.blip(t, 880, 0.04, this.sfx);
      this.blip(t + 0.04, 1320, 0.035, this.sfx);
    }
    if (kind === 'confirm') {
      this.blip(t, 660, 0.06, this.sfx);
      this.blip(t + 0.06, 990, 0.06, this.sfx);
    }
    if (kind === 'deny') {
      this.blip(t, 220, 0.08, this.sfx);
      this.blip(t + 0.08, 180, 0.08, this.sfx);
    }
  }

  /** Breaker / relay: a mechanical clack and a thump. */
  relay() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 3;
    const g = ctx.createGain();
    this.env(g, t, 0.5, 0.001, 0.05);
    src.connect(bp).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.08);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g2 = ctx.createGain();
    this.env(g2, t, 0.35, 0.002, 0.14);
    o.connect(g2).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.2);
  }

  thunder(distance = 0.3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + distance;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(80, t + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    src.connect(lp).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + 3.1);
  }

  /** Transformer / overload warning: two-tone electronic alarm. */
  warning() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      this.tone(t + i * 0.22, 1046, 0.09, 0.1, 'square');
      this.tone(t + i * 0.22 + 0.1, 784, 0.09, 0.1, 'square');
    }
  }

  critical() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) this.tone(t + i * 0.32, 523, 0.26, 0.16, 'sawtooth', 380);
  }

  /** European two-tone siren, a few seconds. */
  siren(seconds = 3.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.sirenUntil = ctx.currentTime + seconds;
    if (this.sirenOsc) return;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.07, ctx.currentTime, 0.2);
    const t0 = ctx.currentTime;
    for (let i = 0; i < 40; i++) o.frequency.setValueAtTime(i % 2 ? 440 : 587, t0 + i * 0.55);
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.4;
    o.connect(g).connect(pan).connect(this.sfx);
    o.start();
    this.sirenOsc = o;
    this.sirenGain = g;
  }

  private stopSiren() {
    if (!this.ctx || !this.sirenOsc || !this.sirenGain) return;
    const o = this.sirenOsc;
    this.sirenGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    o.stop(this.ctx.currentTime + 1.5);
    this.sirenOsc = null;
    this.sirenGain = null;
  }

  /** Power restored: rising major arpeggio with shimmer. */
  restore() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.07, f, 0.35, 0.07, 'sine'));
  }

  /** Lights going out: falling sweep and sub drop. */
  powerDown() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(400, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 1.1);
    const lp = ctx.createBiquadFilter();
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(100, t + 1.1);
    const g = ctx.createGain();
    this.env(g, t, 0.25, 0.01, 1.2);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 1.3);
  }

  /** Final result: a big chord, bright for a good result, dark for a bad one. */
  finale(good: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.05;
    this.kick(t, 0.9);
    const chord = good ? [130.81, 196, 261.63, 329.63, 392] : [110, 130.81, 164.81, 207.65];
    for (const f of chord) this.tone(t, f, 3.5, 0.08, 'sawtooth', 1400);
    this.thunder(0);
  }

  private tone(t: number, f: number, len: number, v: number, type: OscillatorType, lowpass = 6000) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = lowpass;
    const g = ctx.createGain();
    this.env(g, t, v, 0.01, len);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  /** Map a simulation alert to sound. */
  onAlert(a: Alert) {
    if (!this.ctx) return;
    const k = a.key;
    if (k.startsWith('trip-') && a.text.includes('lightning')) this.thunder(0.15);
    if (k.startsWith('trip-') || k.startsWith('xtrip') || k.startsWith('ufls-stage') || k.startsWith('gtrip')) {
      this.relay();
      this.powerDown();
    }
    if (k === 'collapse') {
      this.stopMusic(0.4);
      this.powerDown();
      this.siren(8);
    }
    if (a.level === 'critical' && (k.startsWith('ups-') || k.startsWith('down-') || k.startsWith('minv-') || k.startsWith('dmg-'))) this.siren();
    if (a.level === 'critical' && !k.startsWith('trip-')) this.critical();
    else if (a.level === 'warning') this.warning();
    if (a.level === 'success') this.restore();
  }

  suspend() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }
}

function distortion(k: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
