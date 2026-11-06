/**
 * The shot table (src/content/shots.json) as typed data, and the one
 * continuous camera path built from it.
 *
 * Nothing here touches the DOM or WebGL. The table is validated on load, so a
 * typo in shots.json shows up as a readable list of problems on screen rather
 * than as a camera that silently jumps.
 */
import rawShotTable from '../content/shots.json';

export const REALM_IDS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
export type RealmId = (typeof REALM_IDS)[number];
export type Vec3 = readonly [number, number, number];

export interface CameraKey {
  /** Where the key sits inside its shot: 0 = shot start, 1 = shot end. */
  readonly at: number;
  /** The realm whose local coordinates `pos` and `target` use. */
  readonly realm: RealmId;
  readonly pos: Vec3;
  readonly target: Vec3;
  /** Seconds of placeholder fade when this key enters a new realm. */
  readonly fade?: number;
}

export interface Shot {
  readonly id: number;
  readonly label: string;
  readonly duration: number;
  readonly move: string;
  readonly caption: string;
  readonly claims: readonly string[];
  readonly keys: readonly CameraKey[];
  /** Absolute start and end on the timeline, in seconds (derived from durations). */
  readonly start: number;
  readonly end: number;
}

/** A camera key placed on the timeline. */
export interface PathKey {
  readonly t: number;
  readonly realm: RealmId;
  readonly pos: Vec3;
  readonly target: Vec3;
}

/** A stretch of the path that stays in one realm. */
export interface Run {
  readonly realm: RealmId;
  readonly start: number;
  readonly end: number;
  readonly keys: readonly PathKey[];
  /** Hermite tangents (units per second) for position and target at each key. */
  readonly posTangents: readonly Vec3[];
  readonly targetTangents: readonly Vec3[];
}

/** The instant the camera changes realm, covered by a fade in Module 1. */
export interface Swap {
  readonly t: number;
  readonly from: RealmId;
  readonly to: RealmId;
  /** Total fade length in seconds, centred on `t`. */
  readonly fade: number;
}

export interface CameraPath {
  readonly duration: number;
  readonly runs: readonly Run[];
  readonly swaps: readonly Swap[];
}

export interface Pose {
  readonly realm: RealmId;
  readonly pos: Vec3;
  readonly target: Vec3;
}

/** Seconds a realm-change fade lasts unless a key sets its own `fade`. */
export const DEFAULT_FADE = 0.36;
/** A fade may use at most this share of the shorter run on either side of it. */
const MAX_FADE_SHARE = 0.8;
const SAME_TIME = 1e-6;
const ZERO: Vec3 = [0, 0, 0];

export class ShotTableError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The shot table has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    this.name = 'ShotTableError';
    this.problems = problems;
  }
}

/** Parse, validate and build the bundled shot table. Throws ShotTableError. */
export function loadShotTable(): { shots: Shot[]; path: CameraPath } {
  const shots = parseShots(rawShotTable);
  return { shots, path: buildPath(shots) };
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function isRealmId(value: unknown): value is RealmId {
  return typeof value === 'string' && (REALM_IDS as readonly string[]).includes(value);
}

function parseKeys(raw: unknown, where: string, problems: string[]): CameraKey[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${where}: "keys" must list at least one camera key`);
    return [];
  }
  const keys: CameraKey[] = [];
  raw.forEach((k: unknown, i: number) => {
    const at = `${where}, key ${i + 1}`;
    if (!isRecord(k)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const position = k['at'];
    const pos = vec3(k['pos']);
    const target = vec3(k['target']);
    const realm = k['realm'];
    const fade = k['fade'];
    let ok = true;
    if (typeof position !== 'number' || !(position >= 0 && position <= 1)) {
      problems.push(`${at}: "at" must be a number from 0 to 1`);
      ok = false;
    }
    if (!isRealmId(realm)) {
      problems.push(`${at}: "realm" must be one of ${REALM_IDS.join(', ')}`);
      ok = false;
    }
    if (!pos) {
      problems.push(`${at}: "pos" must be three numbers`);
      ok = false;
    }
    if (!target) {
      problems.push(`${at}: "target" must be three numbers`);
      ok = false;
    }
    if (fade !== undefined && !(typeof fade === 'number' && fade > 0 && Number.isFinite(fade))) {
      problems.push(`${at}: "fade" must be a positive number of seconds`);
      ok = false;
    }
    if (!ok || typeof position !== 'number' || !isRealmId(realm) || !pos || !target) return;

    const dx = target[0] - pos[0];
    const dy = target[1] - pos[1];
    const dz = target[2] - pos[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) {
      problems.push(`${at}: the camera sits on its own target`);
    } else if (Math.hypot(dx, dz) < 1e-3 * length) {
      problems.push(`${at}: the camera looks straight up or down; move pos or target a little in x or z`);
    }

    const previous = keys[keys.length - 1];
    if (previous && position < previous.at) {
      problems.push(`${at}: keys must be in order of "at"`);
    }
    keys.push(typeof fade === 'number' ? { at: position, realm, pos, target, fade } : { at: position, realm, pos, target });
  });
  return keys;
}

/** Validate the raw table and give every shot its absolute start and end. */
export function parseShots(raw: unknown): Shot[] {
  const problems: string[] = [];
  const table = isRecord(raw) ? raw['shots'] : undefined;
  if (!Array.isArray(table) || table.length === 0) {
    throw new ShotTableError(['"shots" must be a non-empty list']);
  }

  const shots: Shot[] = [];
  let start = 0;
  table.forEach((s: unknown, i: number) => {
    const where = `shot ${i + 1}`;
    if (!isRecord(s)) {
      problems.push(`${where}: not an object`);
      return;
    }
    if (s['id'] !== i + 1) problems.push(`${where}: "id" must be ${i + 1} (shots are numbered in order)`);
    const rawDuration = s['duration'];
    const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    if (duration === 0) problems.push(`${where}: "duration" must be a positive number of seconds`);
    const label = text(s['label']);
    const caption = text(s['caption']);
    if (!label) problems.push(`${where}: missing "label"`);
    if (!caption) problems.push(`${where}: missing "caption"`);
    const rawClaims = s['claims'];
    const claims = Array.isArray(rawClaims) ? rawClaims.filter((c): c is string => typeof c === 'string') : [];
    if (claims.length === 0 || !Array.isArray(rawClaims) || claims.length !== rawClaims.length) {
      problems.push(`${where}: "claims" must list the ledger claim ids its caption relies on`);
    }
    const keys = parseKeys(s['keys'], where, problems);
    shots.push({ id: i + 1, label, duration, move: text(s['move']), caption, claims, keys, start, end: start + duration });
    start += duration;
  });

  const first = shots[0];
  const last = shots[shots.length - 1];
  if (first && first.keys[0] && first.keys[0].at !== 0) {
    problems.push('shot 1: the first key must be at 0 so the camera has a starting pose');
  }
  const lastKey = last?.keys[last.keys.length - 1];
  if (last && lastKey && lastKey.at !== 1) {
    problems.push(`shot ${last.id}: the last key must be at 1 so the camera has a final pose`);
  }
  if (problems.length > 0) throw new ShotTableError(problems);
  return shots;
}

// ---------------------------------------------------------------------------
// The camera path
// ---------------------------------------------------------------------------

function fmt(t: number): string {
  return `${Math.round(t * 1000) / 1000}s`;
}

/**
 * Hermite tangent at key i of a run: the slope of the parabola through its
 * neighbours, limited per axis (Steffen 1990) so the camera never overshoots
 * a key. Without the limit, a slow segment next to a fast one makes the camera
 * swing past its key and back, which can carry it through the very thing it is
 * filming.
 */
function tangent(values: readonly Vec3[], times: readonly number[], i: number, ease: { start: boolean; end: boolean }): Vec3 {
  const n = values.length;
  const p = values[i] ?? ZERO;
  const t = times[i] ?? 0;
  const prev = values[i - 1];
  const next = values[i + 1];
  const tPrev = times[i - 1];
  const tNext = times[i + 1];
  if (i === 0) {
    if (ease.start || !next || tNext === undefined) return ZERO;
    const dt = tNext - t;
    return [(next[0] - p[0]) / dt, (next[1] - p[1]) / dt, (next[2] - p[2]) / dt];
  }
  if (i === n - 1) {
    if (ease.end || !prev || tPrev === undefined) return ZERO;
    const dt = t - tPrev;
    return [(p[0] - prev[0]) / dt, (p[1] - prev[1]) / dt, (p[2] - prev[2]) / dt];
  }
  if (!prev || !next || tPrev === undefined || tNext === undefined) return ZERO;
  const h0 = t - tPrev;
  const h1 = tNext - t;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const s0 = ((p[c] ?? 0) - (prev[c] ?? 0)) / h0;
    const s1 = ((next[c] ?? 0) - (p[c] ?? 0)) / h1;
    const parabola = (s0 * h1 + s1 * h0) / (h0 + h1);
    out[c] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(parabola));
  }
  return out;
}

/**
 * Turn the shots into runs (one per stay in a realm) joined by swaps.
 * Throws ShotTableError when the keys don't describe one continuous path.
 */
export function buildPath(shots: readonly Shot[]): CameraPath {
  const problems: string[] = [];
  const duration = shots.reduce((sum, s) => sum + s.duration, 0);

  interface Placed extends PathKey {
    readonly shotId: number;
    /** 1-based position of the key inside its shot, for messages. */
    readonly keyNo: number;
    readonly fade: number | undefined;
  }
  const placed: Placed[] = [];
  for (const shot of shots) {
    shot.keys.forEach((k, i) => {
      placed.push({ t: shot.start + k.at * shot.duration, realm: k.realm, pos: k.pos, target: k.target, shotId: shot.id, keyNo: i + 1, fade: k.fade });
    });
  }

  // Consecutive keys either move forward in time inside one realm, or sit at
  // the same instant and change realm (a swap). Anything else is a jump.
  const runKeys: Placed[][] = [];
  const entryKeys = new Set<Placed>();
  let currentRun: Placed[] = [];
  placed.forEach((key, i) => {
    const prev = placed[i - 1];
    if (!prev) {
      currentRun.push(key);
      return;
    }
    const dt = key.t - prev.t;
    if (dt < SAME_TIME) {
      if (key.realm === prev.realm) {
        problems.push(`shot ${key.shotId}: two keys at ${fmt(key.t)} in the same realm ${key.realm}; keys that share a time must change realm`);
        return;
      }
      const next = placed[i + 1];
      if (next && next.t - key.t < SAME_TIME) {
        problems.push(`shot ${key.shotId}: three keys at ${fmt(key.t)}; a realm change needs exactly two`);
      }
      runKeys.push(currentRun);
      currentRun = [key];
      entryKeys.add(key);
      return;
    }
    if (key.realm !== prev.realm) {
      problems.push(
        `shot ${key.shotId}: the camera goes from ${prev.realm} to ${key.realm} between ${fmt(prev.t)} and ${fmt(key.t)} with no realm change; add an exit key in ${prev.realm} at the same "at" as the ${key.realm} key`,
      );
    }
    currentRun.push(key);
  });
  runKeys.push(currentRun);
  for (const key of placed) {
    if (key.fade !== undefined && !entryKeys.has(key)) {
      problems.push(
        `shot ${key.shotId}, key ${key.keyNo}: "fade" only works on the key that enters a new realm (the second of two keys with the same "at"); here it would be ignored`,
      );
    }
  }

  const runs: Run[] = [];
  const swaps: Swap[] = [];
  runKeys.forEach((keys, r) => {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || !last) return;
    if (keys.length < 2 || last.t - first.t < SAME_TIME) {
      problems.push(`shot ${first.shotId}: the stay in ${first.realm} at ${fmt(first.t)} has a single key; give it a second key later in time`);
      return;
    }
    const times = keys.map((k) => k.t);
    const ease = { start: r === 0, end: r === runKeys.length - 1 };
    const positions = keys.map((k) => k.pos);
    const targets = keys.map((k) => k.target);
    runs.push({
      realm: first.realm,
      start: first.t,
      end: last.t,
      keys: keys.map(({ t, realm, pos, target }) => ({ t, realm, pos, target })),
      posTangents: keys.map((_, i) => tangent(positions, times, i, ease)),
      targetTangents: keys.map((_, i) => tangent(targets, times, i, ease)),
    });
  });

  for (let r = 1; r < runs.length; r++) {
    const before = runs[r - 1];
    const after = runs[r];
    const entry = runKeys[r]?.[0];
    if (!before || !after) continue;
    const limit = MAX_FADE_SHARE * Math.min(before.end - before.start, after.end - after.start);
    const wanted = entry?.fade ?? DEFAULT_FADE;
    swaps.push({ t: after.start, from: before.realm, to: after.realm, fade: Math.min(wanted, limit) });
  }

  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  if (firstRun && firstRun.start > SAME_TIME) problems.push(`the camera has no pose before ${fmt(firstRun.start)}`);
  if (lastRun && Math.abs(lastRun.end - duration) > SAME_TIME) problems.push(`the camera has no pose after ${fmt(lastRun.end)}`);
  if (problems.length > 0) throw new ShotTableError(problems);
  const path: CameraPath = { duration, runs, swaps };
  const motion = checkMotion(path, shots);
  if (motion.length > 0) throw new ShotTableError(motion);
  return path;
}

/** Frames per second at which checkMotion samples the path. */
const CHECK_FPS = 60;
/** The most the view may turn from one frame to the next, in degrees, before it reads as a jump. */
export const MAX_TURN_PER_FRAME = 10;
/** The most the camera may move in one frame, as a share of its distance to what it looks at. */
export const MAX_TRAVEL_PER_FRAME = 0.4;
/** A frame at least this dark under a realm-change fade hides whatever the camera does. */
const HIDDEN_FADE = 0.95;

/**
 * Sample the built path frame by frame and report where the picture would jump
 * even though every key passed its own checks: the camera reaching its target,
 * looking straight up or down, turning more than MAX_TURN_PER_FRAME in one
 * frame, or moving more than MAX_TRAVEL_PER_FRAME of its distance to the
 * target in one frame. A sharp turn happens when the camera passes close to,
 * or right over, what it is looking at, which can also flip the picture upside
 * down; a long move usually means two keys' "at" values ended up too close.
 * Only frames that a realm-change fade has almost blacked out are exempt.
 * One problem per realm stay.
 */
export function checkMotion(path: CameraPath, shots: readonly Shot[]): string[] {
  const problems: string[] = [];
  const minCos = Math.cos((MAX_TURN_PER_FRAME * Math.PI) / 180);
  const lastRun = path.runs[path.runs.length - 1];
  for (const run of path.runs) {
    // Sample from the stay's first instant to its last. A realm change's own
    // instant belongs to the next stay, so earlier stays stop just short of it.
    const end = run === lastRun ? run.end : run.end - SAME_TIME;
    let previous: { t: number; pos: Vec3; length: number; dir: Vec3; right: readonly [number, number] } | null = null;
    for (let frame = 0; ; frame++) {
      const t = Math.min(run.start + frame / CHECK_FPS, end);
      const { pos, target } = evaluate(path, t);
      const dx = target[0] - pos[0];
      const dy = target[1] - pos[1];
      const dz = target[2] - pos[2];
      const length = Math.hypot(dx, dy, dz);
      const flat = Math.hypot(dx, dz);
      const where = `shot ${shotAt(shots, t).id} at ${fmt(t)}`;
      if (length < 1e-6) {
        problems.push(`${where}: the camera reaches its own target; move a key`);
        break;
      }
      if (flat < 1e-3 * length) {
        problems.push(`${where}: the camera looks straight up or down; move a key a little in x or z`);
        break;
      }
      // The view direction, and the camera's right-hand side on the ground plane.
      const dir: Vec3 = [dx / length, dy / length, dz / length];
      const right = [-dz / flat, dx / flat] as const;
      if (previous && Math.max(fadeAt(path, t), fadeAt(path, previous.t)) < HIDDEN_FADE) {
        const turn = dir[0] * previous.dir[0] + dir[1] * previous.dir[1] + dir[2] * previous.dir[2];
        const roll = right[0] * previous.right[0] + right[1] * previous.right[1];
        const cos = Math.min(turn, roll);
        if (cos < minCos) {
          const degrees = Math.round((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
          problems.push(`${where}: the view turns ${degrees} degrees in one frame because the camera passes too close to or over its target; move a key`);
          break;
        }
        const travel = Math.hypot(pos[0] - previous.pos[0], pos[1] - previous.pos[1], pos[2] - previous.pos[2]) / Math.min(length, previous.length);
        if (travel > MAX_TRAVEL_PER_FRAME) {
          problems.push(
            `${where}: the camera jumps ${Math.round(travel * 100)}% of its distance to its target in one frame; two keys here are too close in time (check their "at"), or the shot is too short for this move`,
          );
          break;
        }
      }
      previous = { t, pos, length, dir, right };
      if (t >= end) break;
    }
  }
  return problems;
}

function hermite(p0: number, m0: number, p1: number, m1: number, h: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * m1;
}

/** The run that owns time t. At a swap instant, the later run wins. */
export function runAt(path: CameraPath, t: number): Run {
  const runs = path.runs;
  for (let r = runs.length - 1; r > 0; r--) {
    const run = runs[r];
    if (run && t >= run.start) return run;
  }
  const first = runs[0];
  if (!first) throw new Error('camera path has no runs');
  return first;
}

/** A time on the timeline: clamped to it, and 0 for anything that isn't a number. */
function clampTime(path: CameraPath, t: number): number {
  return Number.isFinite(t) ? Math.min(Math.max(t, 0), path.duration) : t === Infinity ? path.duration : 0;
}

/** Camera pose at time t (clamped to the timeline). */
export function evaluate(path: CameraPath, t: number): Pose {
  const time = clampTime(path, t);
  const run = runAt(path, time);
  const keys = run.keys;
  let i = 0;
  while (i < keys.length - 2 && time > (keys[i + 1]?.t ?? Infinity)) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!a || !b) {
    const only = a ?? keys[0];
    if (!only) throw new Error('camera run has no keys');
    return { realm: run.realm, pos: only.pos, target: only.target };
  }
  const h = b.t - a.t;
  const s = Math.min(Math.max((time - a.t) / h, 0), 1);
  const ma = run.posTangents[i] ?? ZERO;
  const mb = run.posTangents[i + 1] ?? ZERO;
  const na = run.targetTangents[i] ?? ZERO;
  const nb = run.targetTangents[i + 1] ?? ZERO;
  return {
    realm: run.realm,
    pos: [
      hermite(a.pos[0], ma[0], b.pos[0], mb[0], h, s),
      hermite(a.pos[1], ma[1], b.pos[1], mb[1], h, s),
      hermite(a.pos[2], ma[2], b.pos[2], mb[2], h, s),
    ],
    target: [
      hermite(a.target[0], na[0], b.target[0], nb[0], h, s),
      hermite(a.target[1], na[1], b.target[1], nb[1], h, s),
      hermite(a.target[2], na[2], b.target[2], nb[2], h, s),
    ],
  };
}

/** Opacity (0 to 1) of the placeholder fade that hides each realm change. */
export function fadeAt(path: CameraPath, t: number): number {
  if (Number.isNaN(t)) return 0;
  let alpha = 0;
  for (const swap of path.swaps) {
    const half = swap.fade / 2;
    if (half <= 0) continue;
    const d = Math.abs(t - swap.t);
    if (d >= half) continue;
    const x = 1 - d / half;
    alpha = Math.max(alpha, x * x * (3 - 2 * x));
  }
  return alpha;
}

/** The shot playing at time t (the last shot owns the very end). */
export function shotAt(shots: readonly Shot[], t: number): Shot {
  for (let i = shots.length - 1; i > 0; i--) {
    const shot = shots[i];
    if (shot && t >= shot.start) return shot;
  }
  const first = shots[0];
  if (!first) throw new Error('no shots');
  return first;
}

/** How far through its shot time t is, from 0 to 1. */
export function shotProgress(shot: Shot, t: number): number {
  const progress = (t - shot.start) / shot.duration;
  return Number.isNaN(progress) ? 0 : Math.min(Math.max(progress, 0), 1);
}

/**
 * The first moment at or after t that no realm-change fade darkens. A jump to
 * a shot that starts on a realm change lands here, so a paused frame shows the
 * new realm instead of solid black.
 */
export function clearOfFade(path: CameraPath, t: number): number {
  let time = clampTime(path, t);
  for (const swap of path.swaps) {
    const half = swap.fade / 2;
    if (half > 0 && Math.abs(time - swap.t) < half) time = Math.min(swap.t + half, path.duration);
  }
  return time;
}
