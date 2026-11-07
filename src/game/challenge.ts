import type { Action, TimedAction } from '../sim/types';
import { MAX_ACTIONS } from '../sim/engine';

/**
 * Challenge links carry the seed and the full decision recording, not a score. The receiver's
 * browser replays the recording to recompute the result, so a link cannot claim a score its
 * decisions did not earn.
 */

export interface Challenge {
  seed: number;
  name: string;
  mode: 'crisis' | 'daily';
  actions: TimedAction[];
}

const CODES: Record<Action['type'], string> = {
  setpoint: 'g', shed: 's', restore: 'r', transfer: 't', curtail: 'c', protect: 'p', isolateLine: 'o',
  closeLine: 'k', isolateSub: 'i', energiseSub: 'e', startBackup: 'b', dispatchCrew: 'd', investigate: 'v', mobileGen: 'm',
};
const TYPES = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k])) as Record<string, Action['type']>;

function encodeAction(a: Action): string {
  switch (a.type) {
    case 'setpoint': return `g${a.gen}${a.delta > 0 ? '+' : '-'}${Math.abs(a.delta)}`;
    case 'isolateLine': case 'closeLine': return CODES[a.type] + a.line;
    case 'isolateSub': case 'energiseSub': return CODES[a.type] + a.sub;
    case 'dispatchCrew': case 'investigate': return CODES[a.type] + a.target;
    default: return CODES[a.type] + a.zone;
  }
}

function decodeAction(s: string): Action | null {
  const type = TYPES[s[0]];
  const arg = s.slice(1);
  if (!type || !/^[A-Z0-9+-]+$/.test(arg)) return null;
  switch (type) {
    case 'setpoint': {
      const m = /^(G\d)([+-])(\d+)$/.exec(arg);
      return m ? { type, gen: m[1], delta: (m[2] === '+' ? 1 : -1) * Number(m[3]) } : null;
    }
    case 'isolateLine': case 'closeLine': return { type, line: arg };
    case 'isolateSub': case 'energiseSub': return { type, sub: arg };
    case 'dispatchCrew': case 'investigate': return { type, target: arg };
    default: return { type, zone: arg } as Action;
  }
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

export function encodeChallenge(c: Challenge): string {
  const acts = c.actions.slice(0, MAX_ACTIONS).map((t) => `${t.tick.toString(36)}.${encodeAction(t.action)}`).join('~');
  return b64(JSON.stringify({ v: 1, s: c.seed, n: c.name.slice(0, 24), m: c.mode === 'daily' ? 'd' : 'c', a: acts }));
}

export function decodeChallenge(code: string): Challenge | null {
  try {
    const o = JSON.parse(unb64(code));
    if (o.v !== 1 || typeof o.s !== 'number' || typeof o.a !== 'string') return null;
    const actions: TimedAction[] = [];
    for (const part of o.a ? String(o.a).split('~') : []) {
      const [t, a] = part.split('.');
      const tick = parseInt(t, 36);
      const action = decodeAction(a ?? '');
      if (!Number.isFinite(tick) || tick < 0 || tick > 900 || !action) return null;
      actions.push({ tick, action });
    }
    if (actions.length > MAX_ACTIONS) return null;
    return { seed: o.s >>> 0, name: String(o.n ?? 'Operator').slice(0, 24), mode: o.m === 'd' ? 'daily' : 'crisis', actions };
  } catch {
    return null;
  }
}
