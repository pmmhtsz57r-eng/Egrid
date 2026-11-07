/** Small wrapper around localStorage. Everything here is a per-browser convenience. */
const KEY = 'blackout:v1';

interface Stored {
  name?: string;
  volume?: number;
  muted?: boolean;
  best?: Record<string, number>;
  played?: number;
}

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

function save(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: ignore */
  }
}

export const store = {
  get: load,
  set(patch: Partial<Stored>) {
    save({ ...load(), ...patch });
  },
  recordBest(key: string, score: number): { best: number; isNew: boolean } {
    const s = load();
    const best = s.best ?? {};
    const prev = best[key] ?? -1;
    const isNew = score > prev;
    if (isNew) best[key] = score;
    save({ ...s, best, played: (s.played ?? 0) + 1 });
    return { best: Math.max(prev, score), isNew: isNew && prev >= 0 };
  },
};
