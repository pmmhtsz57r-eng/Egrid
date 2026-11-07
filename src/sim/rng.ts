/** Deterministic 32-bit PRNG (mulberry32). Integer maths only, identical in every JS engine. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

/** Rounds to a fixed number of decimals so seeded values print and compare cleanly. */
export const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Seed for the daily challenge: the same for everyone on a given UTC date. */
export function dailySeed(date: Date): number {
  const key = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  let h = 2166136261 >>> 0;
  for (const ch of String(key)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 900000 + 100000;
}
