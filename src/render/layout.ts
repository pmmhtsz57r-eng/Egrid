import { createRng } from '../sim/rng';
import type { NetworkDef, Vec2, ZoneDef } from '../sim/types';

/** Procedural layout of Nova City for rendering only (the simulation never sees it). */

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  zone: string;
  seed: number;
}

export const riverX = (z: number) => 50 + 9 * Math.sin(z / 28) + z * 0.06;

export const RAIL_PATH: Vec2[] = [
  [-140, -64], [-80, -70], [-20, -74], [20, -76], [60, -76], [100, -72], [150, -60],
];

const LOT = 6.5;

function zoneHeight(z: ZoneDef, distCentre: number, r: () => number) {
  const centre = Math.max(0, 1 - distCentre / 120);
  switch (z.kind) {
    case 'industrial': return 3 + r() * 5;
    case 'datacentre': return 3.5 + r() * 2.5;
    case 'hospital': return 4 + r() * 8 + centre * 6;
    case 'rail': return 3 + r() * 6;
    case 'emergency': return 5 + r() * 10 + centre * 10;
    default: return 2.5 + r() * r() * 16 * (0.45 + centre) + centre * 6;
  }
}

export function buildCity(net: NetworkDef): Building[] {
  const rng = createRng(20261106);
  const out: Building[] = [];
  const exclusions: { p: Vec2; r: number }[] = [
    ...net.substations.map((s) => ({ p: s.pos, r: 8 })),
    ...net.generators.map((g) => ({ p: g.pos, r: 26 })),
  ];
  for (let gx = -112; gx <= 124; gx += LOT) {
    for (let gz = -104; gz <= 104; gz += LOT) {
      // skip major avenues
      if (Math.abs(gx % 39) < 3 || Math.abs(gz % 33) < 3) continue;
      const jx = gx + (rng.next() - 0.5) * 1.2;
      const jz = gz + (rng.next() - 0.5) * 1.2;
      if (Math.abs(jx - riverX(jz)) < 8) continue;
      if (exclusions.some((e) => Math.hypot(jx - e.p[0], jz - e.p[1]) < e.r)) continue;
      if (nearRail(jx, jz) < 4) continue;
      // nearest zone, weighted by its footprint
      let best: ZoneDef | null = null;
      let bestD = Infinity;
      for (const z of net.zones) {
        const scale = (z.size[0] + z.size[1]) / 2;
        const d = Math.hypot(jx - z.pos[0], jz - z.pos[1]) / scale;
        if (d < bestD) {
          bestD = d;
          best = z;
        }
      }
      if (!best) continue;
      const edge = Math.hypot(jx, jz);
      if (edge > 150) continue;
      // density falls off towards the outskirts
      const keep = bestD < 1.2 ? 0.95 : bestD < 2.2 ? 0.75 : 0.35;
      if (rng.next() > keep) continue;
      const r = rng.next;
      const big = best.kind === 'industrial' || best.kind === 'datacentre';
      const w = big ? 4 + r() * 2 : 2.4 + r() * 2.6;
      const d = big ? 4 + r() * 2 : 2.4 + r() * 2.6;
      out.push({ x: jx, z: jz, w, d, h: zoneHeight(best, edge, r), zone: best.id, seed: r() * 100 });
    }
  }
  return out;
}

function nearRail(x: number, z: number) {
  let best = Infinity;
  for (let i = 1; i < RAIL_PATH.length; i++) {
    const [ax, az] = RAIL_PATH[i - 1];
    const [bx, bz] = RAIL_PATH[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

export function railPoint(t: number): Vec2 {
  // t in [0,1] along the path by length
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < RAIL_PATH.length; i++) {
    const l = Math.hypot(RAIL_PATH[i][0] - RAIL_PATH[i - 1][0], RAIL_PATH[i][1] - RAIL_PATH[i - 1][1]);
    segs.push(l);
    total += l;
  }
  let d = ((t % 1) + 1) % 1 * total;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i]) {
      const k = d / segs[i];
      const a = RAIL_PATH[i];
      const b = RAIL_PATH[i + 1];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    d -= segs[i];
  }
  return RAIL_PATH[RAIL_PATH.length - 1];
}
