/**
 * The one clock. Everything that moves reads `timeline.t`; only this module
 * writes it. The play button, the scrubber, the keyboard and the mouse wheel
 * all go through the same play / pause / seek calls.
 */

export type SeekSource = 'scrubber' | 'keyboard' | 'wheel' | 'url' | 'code';

export type TimelineEvent =
  | { readonly type: 'play' | 'pause' | 'end'; readonly t: number }
  | { readonly type: 'seek'; readonly t: number; readonly source: SeekSource };

/** Longest step a single frame may advance. Longer gaps (a background tab) don't skip ahead. */
export const MAX_STEP = 0.25;
/** Wheel travel, in pixels, that scrubs one second. */
export const WHEEL_PX_PER_SECOND = 120;

export class Timeline {
  readonly duration: number;
  private time = 0;
  private running = false;
  private readonly listeners = new Set<(event: TimelineEvent) => void>();

  constructor(duration: number) {
    if (!(duration > 0) || !Number.isFinite(duration)) throw new RangeError('Timeline duration must be a positive number of seconds');
    this.duration = duration;
  }

  get t(): number {
    return this.time;
  }

  get playing(): boolean {
    return this.running;
  }

  get atEnd(): boolean {
    return this.time >= this.duration;
  }

  /** Start playing. At the very end, playing starts over from 0. */
  play(): void {
    if (this.running) return;
    if (this.atEnd) this.seek(0, 'code');
    this.running = true;
    this.emit({ type: 'play', t: this.time });
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.emit({ type: 'pause', t: this.time });
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  /** Jump to time t, clamped to the timeline. Playback state is unchanged. */
  seek(t: number, source: SeekSource = 'code'): void {
    const next = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), this.duration);
    this.time = next;
    this.emit({ type: 'seek', t: next, source });
  }

  /** Advance by real elapsed seconds. Call once per frame. */
  advance(dt: number): void {
    if (!this.running) return;
    const step = Math.min(Math.max(Number.isFinite(dt) ? dt : 0, 0), MAX_STEP);
    this.time = Math.min(this.time + step, this.duration);
    if (this.time >= this.duration) {
      this.running = false;
      this.emit({ type: 'end', t: this.time });
    }
  }

  on(listener: (event: TimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TimelineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** "1:05.3" style time; `decimals` 0 gives "1:05". */
export function formatTime(seconds: number, decimals: 0 | 1 = 1): string {
  const scale = decimals === 1 ? 10 : 1;
  const ticks = Math.round(Math.max(0, seconds) * scale);
  const minutes = Math.floor(ticks / (60 * scale));
  const rest = (ticks - minutes * 60 * scale) / scale;
  const secs = decimals === 1 ? rest.toFixed(1).padStart(4, '0') : String(rest).padStart(2, '0');
  return `${minutes}:${secs}`;
}

export interface ControlElements {
  readonly scrubber: HTMLInputElement;
  readonly playPause: HTMLButtonElement;
  readonly clock: HTMLElement;
  /** The element whose wheel events scrub time (the canvas). */
  readonly surface: HTMLElement;
}

export interface ControlOptions {
  /** Shot start times in ascending order, for the [ and ] jumps. */
  readonly shotStarts: readonly number[];
  /** Keys the caller handles itself; return true when handled. */
  readonly onKey?: (event: KeyboardEvent) => boolean;
}

export interface Controls {
  /** Bring the scrubber, clock and button in line with the timeline. Call once per frame. */
  sync(): void;
  /** Switch every control off (true), for example while the graphics are lost, or back on (false). */
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

const PLAY_GLYPH = '▶︎';
const PAUSE_GLYPH = '❚❚';

/** Wire the HUD controls, keyboard and wheel to a timeline. */
export function bindControls(timeline: Timeline, el: ControlElements, options: ControlOptions): Controls {
  const { scrubber, playPause, clock, surface } = el;
  scrubber.min = '0';
  scrubber.max = String(timeline.duration);
  scrubber.step = '0.1';
  const total = formatTime(timeline.duration, 0);

  let disabled = false;
  let dragging = false;
  let resumeAfterDrag = false;
  let shownValue = Number.NaN;
  let shownClock = '';
  let shownValueText = '';
  let shownPlaying: boolean | null = null;

  const startDrag = (event: PointerEvent): void => {
    // Only a primary press scrubs. A right-click opens a menu that can swallow
    // the release, which would leave the drag stuck (Ctrl+click on a Mac is
    // caught by the contextmenu listener below).
    if (disabled || dragging || event.button !== 0) return;
    dragging = true;
    resumeAfterDrag = timeline.playing;
    timeline.pause();
  };
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    if (resumeAfterDrag && !timeline.atEnd && !disabled) timeline.play();
    resumeAfterDrag = false;
  };
  const onScrubInput = (): void => {
    const value = Number(scrubber.value);
    const t = timeline.t;
    // Outside a drag, a one-step change comes from assistive technology nudging
    // the bar (VoiceOver swipes up or down). A tenth of a second is too little
    // to hear, so each nudge moves a whole second instead.
    if (!dragging && value !== t && Math.abs(value - t) < 0.16) {
      timeline.seek(t + Math.sign(value - t), 'scrubber');
      return;
    }
    timeline.seek(value, 'scrubber');
  };

  const jump = (direction: 1 | -1): void => {
    const t = timeline.t;
    const starts = options.shotStarts;
    if (direction > 0) {
      const next = starts.find((s) => s > t + 1e-3);
      timeline.seek(next ?? timeline.duration, 'keyboard');
      return;
    }
    let index = 0;
    for (let i = starts.length - 1; i >= 0; i--) {
      if ((starts[i] ?? 0) <= t + 1e-3) {
        index = i;
        break;
      }
    }
    const currentStart = starts[index] ?? 0;
    // Half a second into a shot, [ restarts it; any earlier, it goes to the previous shot.
    const destination = t - currentStart > 0.5 ? currentStart : (starts[Math.max(0, index - 1)] ?? 0);
    timeline.seek(destination, 'keyboard');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (disabled || event.defaultPrevented) return;
    // Leave browser and system shortcuts alone. Many layouts type [ and ] with
    // AltGr (which reports Ctrl+Alt on Windows) or Option, so those still count.
    if (event.metaKey || (event.ctrlKey && !event.getModifierState('AltGraph'))) return;
    const key = event.key;
    if (event.altKey && key !== '[' && key !== ']') return;
    const onButton = event.target instanceof HTMLButtonElement;
    const onScrubber = event.target === scrubber;
    const stride = event.shiftKey ? 5 : 1;
    switch (key) {
      case ' ':
      case 'k':
      case 'K':
        // A focused button already toggles on Space through its own click.
        if (onButton && key === ' ') return;
        event.preventDefault();
        // Holding the key down must not flip between play and pause at the key-repeat rate.
        if (!event.repeat) timeline.toggle();
        return;
      case 'Enter':
        // The same for Enter held on the play button, which would click it again on every repeat.
        if (onButton && event.repeat) event.preventDefault();
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        // On the focused scrubber these would move a tenth of a second; make them match ← and →.
        if (!onScrubber) return;
        event.preventDefault();
        timeline.seek(timeline.t + (key === 'ArrowUp' ? stride : -stride), 'keyboard');
        return;
      case 'PageUp':
      case 'PageDown':
        if (!onScrubber) return;
        event.preventDefault();
        jump(key === 'PageUp' ? 1 : -1);
        return;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault();
        timeline.seek(timeline.t - stride, 'keyboard');
        return;
      case 'ArrowRight':
      case 'l':
      case 'L':
        event.preventDefault();
        timeline.seek(timeline.t + stride, 'keyboard');
        return;
      case '[':
        event.preventDefault();
        jump(-1);
        return;
      case ']':
        event.preventDefault();
        jump(1);
        return;
      case 'Home':
        event.preventDefault();
        timeline.seek(0, 'keyboard');
        return;
      case 'End':
        event.preventDefault();
        timeline.seek(timeline.duration, 'keyboard');
        return;
      default:
        if (options.onKey?.(event)) event.preventDefault();
    }
  };

  const onWheel = (event: WheelEvent): void => {
    // Ctrl+wheel and a trackpad pinch zoom the page, and a sideways swipe is
    // the browser's back gesture; let all of those through.
    if (disabled || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    // While the page is pinch-zoomed, scrolling pans the enlarged view.
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    event.preventDefault();
    const px = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
    if (px === 0) return;
    timeline.pause();
    timeline.seek(timeline.t + px / WHEEL_PX_PER_SECOND, 'wheel');
  };

  const onToggle = (): void => {
    if (!disabled) timeline.toggle();
  };

  scrubber.addEventListener('pointerdown', startDrag);
  scrubber.addEventListener('input', onScrubInput);
  scrubber.addEventListener('change', endDrag);
  // A release the page never sees (a menu, or switching away) must not leave the drag stuck.
  scrubber.addEventListener('contextmenu', endDrag);
  window.addEventListener('blur', endDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  playPause.addEventListener('click', onToggle);
  window.addEventListener('keydown', onKeyDown);
  surface.addEventListener('wheel', onWheel, { passive: false });

  const sync = (): void => {
    const t = timeline.t;
    if (!dragging && t !== shownValue) {
      scrubber.value = String(t);
      shownValue = t;
    }
    const now = formatTime(t);
    if (now !== shownClock) {
      clock.textContent = `${now} / ${total}`;
      shownClock = now;
    }
    // Whole seconds for screen readers, so a focused scrubber isn't re-read ten times a second.
    const valueText = `${formatTime(t, 0)} of ${total}`;
    if (valueText !== shownValueText) {
      scrubber.setAttribute('aria-valuetext', valueText);
      shownValueText = valueText;
    }
    const playing = timeline.playing;
    if (playing !== shownPlaying) {
      playPause.textContent = playing ? PAUSE_GLYPH : PLAY_GLYPH;
      playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      shownPlaying = playing;
    }
  };

  const setDisabled = (value: boolean): void => {
    disabled = value;
    if (value) {
      // Forget a drag in progress first: disabling the bar mid-drag fires its
      // 'change' event, which must not resume playback.
      dragging = false;
      resumeAfterDrag = false;
    }
    scrubber.disabled = value;
    playPause.disabled = value;
  };

  const dispose = (): void => {
    scrubber.removeEventListener('pointerdown', startDrag);
    scrubber.removeEventListener('input', onScrubInput);
    scrubber.removeEventListener('change', endDrag);
    scrubber.removeEventListener('contextmenu', endDrag);
    window.removeEventListener('blur', endDrag);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    playPause.removeEventListener('click', onToggle);
    window.removeEventListener('keydown', onKeyDown);
    surface.removeEventListener('wheel', onWheel);
  };

  sync();
  return { sync, setDisabled, dispose };
}
