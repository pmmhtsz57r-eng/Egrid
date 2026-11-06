/**
 * Gray-box stand-ins for the eight realms (Module 1).
 *
 * Every object is a placeholder shape, sized to frame the camera keys in
 * shots.json. Built-in three.js materials only: no custom shaders, no
 * textures. Nothing here is a measurement. Counts, sizes, bar heights and
 * wedge sizes are arbitrary, and the debug overlay says so. Real geometry,
 * real traces and real scales arrive in later modules, each with its own
 * ledger entry.
 *
 * Each realm sits in its own local coordinates around the origin. Only one
 * realm is visible at a time; main.ts switches them as the path changes realm.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  QuadraticBezierCurve3,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RealmId, Shot, Vec3 } from '../core/shots';

export interface RealmInfo {
  readonly id: RealmId;
  readonly name: string;
  /** What one unit means here. Orders of magnitude, not specs. */
  readonly unit: string;
  readonly near: number;
  readonly far: number;
  readonly fogNear: number;
  readonly fogFar: number;
}

export const REALM_INFO: Readonly<Record<RealmId, RealmInfo>> = {
  R0: { id: 'R0', name: 'Storm and grid', unit: '1 unit = 10 m', near: 0.5, far: 1500, fogNear: 80, fogFar: 520 },
  R1: { id: 'R1', name: 'Campus and hall', unit: '1 unit = 1 m', near: 0.05, far: 200, fogNear: 10, fogFar: 46 },
  R2: { id: 'R2', name: 'Rack and server', unit: '1 unit = 1 cm', near: 0.1, far: 600, fogNear: 40, fogFar: 220 },
  R3: { id: 'R3', name: 'Package', unit: '1 unit = 1 mm', near: 0.1, far: 600, fogNear: 40, fogFar: 200 },
  R4: { id: 'R4', name: 'Die', unit: 'about 10 µm per unit, schematic', near: 0.2, far: 800, fogNear: 90, fogFar: 330 },
  R5: { id: 'R5', name: 'Matrix tile', unit: 'abstract', near: 0.05, far: 200, fogNear: 14, fogFar: 44 },
  R6: { id: 'R6', name: 'Math space', unit: 'abstract', near: 0.05, far: 400, fogNear: 30, fogFar: 110 },
  R7: { id: 'R7', name: 'Reply', unit: '1 unit = 1 cm (backdrop not to scale)', near: 0.1, far: 30000, fogNear: 900, fogFar: 16000 },
};

export interface BeatContext {
  /** Timeline time in seconds. */
  readonly t: number;
  /** The shot playing now. */
  readonly shot: Shot;
  /** How far through that shot, 0 to 1. */
  readonly progress: number;
  readonly reducedMotion: boolean;
}

export interface Realm {
  readonly info: RealmInfo;
  readonly group: Group;
  /** Set this realm's placeholder animation for the current moment. Pure function of the context, so scrubbing works both ways. */
  update(ctx: BeatContext): void;
}

// ---------------------------------------------------------------------------
// Palette, materials and small builders
// ---------------------------------------------------------------------------

const INK = {
  ground: 0x1a1f26,
  dark: 0x343c46,
  mid: 0x6b7480,
  light: 0x98a2ad,
  cyan: 0x3fd8ff,
  amber: 0xffb347,
  screen: 0x0a0e13,
  text: 0xe6edf3,
} as const;

interface MaterialOptions {
  readonly emissive?: number;
  readonly glow?: number;
  readonly opacity?: number;
  readonly rough?: number;
}

function standard(color: number, options: MaterialOptions = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color, roughness: options.rough ?? 0.85, metalness: 0 });
  if (options.emissive !== undefined) {
    material.emissive.setHex(options.emissive);
    material.emissiveIntensity = options.glow ?? 0.6;
  }
  if (options.opacity !== undefined) {
    material.transparent = true;
    material.opacity = options.opacity;
    material.depthWrite = false;
  }
  return material;
}

const UNIT_BOX = new BoxGeometry(1, 1, 1);
const UNIT_ROD = new CylinderGeometry(1, 1, 1, 8);
const Y_AXIS = new Vector3(0, 1, 0);
const scratch = new Object3D();
const va = new Vector3();
const vb = new Vector3();

/** Centre x, y, z, then width, height, depth. */
type BoxSpec = readonly [number, number, number, number, number, number];
type Segment = readonly [Vec3, Vec3];

function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

function ease(x: number): number {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}

/** Deterministic noise in [0, 1): the gray-box never changes between reloads. */
function hash01(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * 0 before shot `shotId`, 1 after it, and a 0-to-1 ramp between `from` and
 * `to` (fractions of that shot) while it plays.
 */
/**
 * Brightness of a lightning strike, 0 to 1, at `s` seconds into a shot: a short
 * decaying spike at each stroke time. Callers space strokes at least 0.5 s
 * apart, so no one-second window holds more than two flashes (WCAG 2.3.1
 * allows three).
 */
function strike(s: number, strokes: readonly number[]): number {
  let level = 0;
  for (const at of strokes) {
    const since = s - at;
    if (since >= 0) level = Math.max(level, Math.exp(-since / 0.07));
  }
  return level;
}

/** Stroke times in seconds into shot 1 (the opening storm) and shot 18 (the storm on the horizon). */
const OPENING_STROKES = [0.35, 0.95, 2.3, 2.9] as const;
const CLOSING_STROKES = [5.4, 6.1] as const;

export function beat(ctx: BeatContext, shotId: number, from = 0, to = 1): number {
  if (ctx.shot.id !== shotId) return ctx.shot.id > shotId ? 1 : 0;
  if (to <= from) return ctx.progress >= from ? 1 : 0;
  return clamp01((ctx.progress - from) / (to - from));
}

function box(material: Material, [x, y, z, w, h, d]: BoxSpec): Mesh {
  const mesh = new Mesh(UNIT_BOX, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  return mesh;
}

function setBox(mesh: InstancedMesh, i: number, [x, y, z, w, h, d]: BoxSpec): void {
  scratch.position.set(x, y, z);
  scratch.quaternion.identity();
  scratch.scale.set(w, h, d);
  scratch.updateMatrix();
  mesh.setMatrixAt(i, scratch.matrix);
}

/** Many boxes, one draw call. */
function boxes(material: Material, specs: readonly BoxSpec[]): InstancedMesh {
  const mesh = new InstancedMesh(UNIT_BOX, material, specs.length);
  specs.forEach((spec, i) => setBox(mesh, i, spec));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Thin cylinders between point pairs, one draw call. */
function rods(material: Material, segments: readonly Segment[], radius: number): InstancedMesh {
  const mesh = new InstancedMesh(UNIT_ROD, material, segments.length);
  segments.forEach(([a, b], i) => {
    va.set(a[0], a[1], a[2]);
    vb.set(b[0], b[1], b[2]);
    const length = va.distanceTo(vb);
    scratch.position.copy(va).add(vb).multiplyScalar(0.5);
    scratch.quaternion.setFromUnitVectors(Y_AXIS, vb.sub(va).normalize());
    scratch.scale.set(radius, length, radius);
    scratch.updateMatrix();
    mesh.setMatrixAt(i, scratch.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Consecutive pairs of a polyline. */
function chain(points: readonly Vec3[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) segments.push([a, b]);
  }
  return segments;
}

function realm(id: RealmId, group: Group, update: (ctx: BeatContext) => void = () => {}): Realm {
  group.name = `${id} ${REALM_INFO[id].name}`;
  return { info: REALM_INFO[id], group, update };
}

// ---------------------------------------------------------------------------
// R0 Storm and grid (1 unit = 10 m)
// ---------------------------------------------------------------------------

function buildStormAndGrid(): Realm {
  const g = new Group();
  const ground = new Mesh(new PlaneGeometry(900, 900), standard(INK.ground, { rough: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -200);
  g.add(ground);

  // Cloud deck overhead.
  g.add(
    boxes(standard(INK.dark), [
      [-20, 84, -10, 80, 6, 46],
      [28, 88, 6, 64, 5, 52],
      [0, 92, -46, 96, 6, 40],
      [-46, 86, -70, 56, 5, 44],
      [40, 90, -90, 70, 6, 50],
    ]),
  );

  // The bolt: a fixed zigzag for now.
  const boltMat = standard(INK.amber, { emissive: INK.amber, glow: 1, opacity: 1 });
  const boltPoints: Vec3[] = [
    [0, 80, 0],
    [3, 68, 1],
    [-2.5, 57, -1],
    [4, 45, 0.5],
    [-1.5, 33, 1],
    [2.5, 20, -1],
    [-0.5, 9, 0.5],
    [0, 0, 0],
  ];
  const bolt = new Group();
  bolt.add(rods(boltMat, chain(boltPoints), 0.5));
  bolt.add(box(boltMat, [0, 0.1, 0, 4, 0.2, 4]));
  g.add(bolt);

  // Transmission line on a gentle S-curve toward the campus.
  const lineX = (z: number): number => 10 * Math.sin(-z / 70);
  const towerZ: number[] = [];
  for (let z = -15; z >= -235; z -= 22) towerZ.push(z);
  const towerMat = standard(INK.mid);
  g.add(boxes(towerMat, towerZ.map((z): BoxSpec => [lineX(z), 7, z, 1.2, 14, 1.2])));
  g.add(boxes(towerMat, towerZ.map((z): BoxSpec => [lineX(z), 13.5, z, 8, 0.6, 0.6])));
  const wireMat = standard(INK.light, { emissive: INK.amber, glow: 0 });
  const wires: Segment[] = [];
  for (const side of [-3.5, 3.5]) {
    for (let i = 1; i < towerZ.length; i++) {
      const z0 = towerZ[i - 1];
      const z1 = towerZ[i];
      if (z0 === undefined || z1 === undefined) continue;
      wires.push([
        [lineX(z0) + side, 13.2, z0],
        [lineX(z1) + side, 13.2, z1],
      ]);
    }
  }
  // A power station feeds the head of the line, well clear of the strike, so
  // the grid's power reads as generated, not caught from the sky (claim C02).
  const headZ = towerZ[0] ?? -15;
  const feedFrom: Vec3 = [lineX(headZ) - 17, 7, headZ + 2];
  g.add(
    boxes(towerMat, [
      [lineX(headZ) - 24, 4, headZ + 2, 14, 8, 10],
      [lineX(headZ) - 28, 10, headZ - 1, 2, 20, 2],
      [lineX(headZ) - 22, 10, headZ - 1, 2, 20, 2],
    ]),
  );
  const feedTo = (side: number): Vec3 => [lineX(headZ) + side, 13.2, headZ];
  wires.push([feedFrom, feedTo(-3.5)], [feedFrom, feedTo(3.5)]);
  g.add(rods(wireMat, wires, 0.14));

  // The amber pulse shot 3 follows from the station along the right-hand wire.
  const pulse = box(standard(INK.amber, { emissive: INK.amber, glow: 1.2 }), [0, 0, 0, 2.2, 2.2, 2.2]);
  pulse.visible = false;
  g.add(pulse);

  // Substation, campus building and neighbours.
  g.add(
    boxes(towerMat, [
      [-14, 2, -244, 6, 4, 6],
      [-6, 1.5, -246, 4, 3, 4],
      [-20, 1.2, -238, 3, 2.4, 3],
    ]),
  );
  g.add(box(standard(INK.mid), [0, 7, -275, 70, 14, 40]));
  g.add(
    boxes(standard(INK.dark), [
      [-62, 5, -286, 30, 10, 30],
      [60, 6, -290, 28, 12, 34],
      [-28, 4, -322, 40, 8, 20],
      [30, 5, -330, 36, 10, 24],
    ]),
  );
  const doorMat = standard(INK.cyan, { emissive: INK.cyan, glow: 0.3 });
  g.add(box(doorMat, [0, 2.2, -254.8, 7, 4.4, 0.6]));

  return realm('R0', g, (ctx) => {
    const flicker = ctx.shot.id === 1 && !ctx.reducedMotion;
    boltMat.emissiveIntensity = flicker ? 0.7 + 1.1 * strike(ctx.t - ctx.shot.start, OPENING_STROKES) : 1;
    // Shot 2: the bolt fades out first, then the line lights. The gap keeps it
    // a rhyme of shapes rather than lightning flowing into the wires.
    const fadeOut = ease(beat(ctx, 2, 0.05, 0.45));
    boltMat.opacity = 1 - fadeOut;
    bolt.visible = fadeOut < 1;
    wireMat.emissiveIntensity = 0.8 * ease(beat(ctx, 2, 0.55, 0.95));
    pulse.visible = ctx.shot.id === 3;
    if (pulse.visible) {
      const feed = clamp01(ctx.progress / 0.15);
      const u = clamp01((ctx.progress - 0.15) / 0.85);
      if (feed < 1) {
        const to = feedTo(3.5);
        pulse.position.set(
          feedFrom[0] + (to[0] - feedFrom[0]) * feed,
          feedFrom[1] + (to[1] - feedFrom[1]) * feed,
          feedFrom[2] + (to[2] - feedFrom[2]) * feed,
        );
      } else {
        const z = headZ - 220 * u;
        pulse.position.set(lineX(z) + 3.5, 13.2, z);
      }
    }
    doorMat.emissiveIntensity = 0.3 + 1.1 * beat(ctx, 4, 0, 0.6);
  });
}

// ---------------------------------------------------------------------------
// R1 Campus and hall (1 unit = 1 m)
// ---------------------------------------------------------------------------

function buildHall(): Realm {
  const g = new Group();
  const floor = new Mesh(new PlaneGeometry(24, 46), standard(INK.ground, { rough: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 11);
  g.add(floor);
  g.add(box(standard(INK.cyan, { emissive: INK.cyan, glow: 0.5 }), [0, 0.005, 11, 0.06, 0.01, 22]));

  // Two rows of racks facing a shared aisle, with a status strip on each front.
  const rackZ = (i: number): number => 0.3 + 0.62 * i;
  const hero = { side: 1, index: 2 };
  const racks: BoxSpec[] = [];
  const strips: BoxSpec[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 36; i++) {
      const z = rackZ(i);
      strips.push([side * 1.19, 1.2, z, 0.02, 1.5, 0.05]);
      if (side === hero.side && i === hero.index) continue;
      racks.push([side * 1.8, 1.05, z, 1.2, 2.1, 0.56]);
    }
  }
  g.add(boxes(standard(INK.mid), racks));
  g.add(boxes(standard(INK.cyan, { emissive: INK.cyan, glow: 0.7 }), strips));
  const heroMat = standard(INK.mid, { emissive: INK.amber, glow: 0.12 });
  g.add(box(heroMat, [hero.side * 1.8, 1.05, rackZ(hero.index), 1.2, 2.1, 0.56]));
  g.add(
    boxes(standard(INK.dark), [
      [-1.8, 2.6, 11, 0.6, 0.08, 22.5],
      [1.8, 2.6, 11, 0.6, 0.08, 22.5],
    ]),
  );

  return realm('R1', g, (ctx) => {
    heroMat.emissiveIntensity = 0.12 + 0.55 * beat(ctx, 5, 0.5, 1);
  });
}

// ---------------------------------------------------------------------------
// R2 Rack and server (1 unit = 1 cm)
// ---------------------------------------------------------------------------

function buildServer(): Realm {
  const g = new Group();
  const dark = standard(INK.dark);
  const mid = standard(INK.mid);
  g.add(box(dark, [0, -0.5, 0, 46, 1, 72]));
  g.add(
    boxes(mid, [
      [-23, 1.5, 0, 1, 4, 72],
      [23, 1.5, 0, 1, 4, 72],
    ]),
  );
  g.add(box(standard(0x23302f), [0, 0.15, 2, 38, 0.3, 44]));
  g.add(box(mid, [0, 0.7, 0, 9, 0.8, 9]));
  g.add(box(standard(INK.cyan, { emissive: INK.cyan, glow: 0.45 }), [0, 1.18, 0, 5, 0.16, 6]));
  g.add(
    boxes(standard(INK.light), [
      [-12, 0.9, -12, 6, 1.2, 3],
      [12, 0.9, -12, 6, 1.2, 3],
      [-12, 1, 12, 3, 1.4, 6],
      [12, 1, 12, 3, 1.4, 6],
      [0, 1.1, -17, 14, 1.6, 2],
      [0, 0.7, 19, 18, 0.8, 2],
    ]),
  );
  g.add(
    boxes(dark, [
      [-15, 3, -30, 8, 6, 2],
      [-5, 3, -30, 8, 6, 2],
      [5, 3, -30, 8, 6, 2],
      [15, 3, -30, 8, 6, 2],
    ]),
  );
  return realm('R2', g);
}

// ---------------------------------------------------------------------------
// R3 Package (1 unit = 1 mm)
// ---------------------------------------------------------------------------

function buildPackage(): Realm {
  const g = new Group();
  g.add(box(standard(INK.dark), [0, -0.8, 0, 64, 1.6, 52]));
  g.add(box(standard(INK.mid), [0, 0.3, 0, 46, 0.6, 32]));
  g.add(box(standard(0x5d8794, { emissive: INK.cyan, glow: 0.15 }), [0, 1, 0, 20, 0.8, 26]));

  // Stacked memory beside the die. Four stacks of eight layers: placeholders, not a spec.
  const slabMat = standard(INK.light);
  const stacks: Group[] = [];
  for (const x of [-16, 16]) {
    for (const z of [-7.5, 7.5]) {
      const stack = new Group();
      stack.position.set(x, 0.6, z);
      const layers: BoxSpec[] = [];
      for (let k = 0; k < 8; k++) layers.push([0, 0.3 + k * 0.65, 0, 9, 0.55, 11]);
      stack.add(boxes(slabMat, layers));
      stacks.push(stack);
      g.add(stack);
    }
  }

  return realm('R3', g, (ctx) => {
    const rise = 0.12 + 0.88 * ease(beat(ctx, 7, 0.45, 0.9));
    for (const stack of stacks) stack.scale.y = rise;
  });
}

// ---------------------------------------------------------------------------
// R4 Die (schematic)
// ---------------------------------------------------------------------------

function buildDie(): Realm {
  const g = new Group();
  g.add(box(standard(INK.dark), [0, -0.5, 0, 106, 1, 76]));
  const units: BoxSpec[] = [];
  for (let c = 0; c < 13; c++) {
    for (let r = 0; r < 9; r++) {
      if (c === 6 && r === 4) continue;
      units.push([(c - 6) * 7.5, 0.4, (r - 4) * 7.5, 6, 0.8, 6]);
    }
  }
  g.add(boxes(standard(INK.mid), units));
  const heroMat = standard(INK.cyan, { emissive: INK.cyan, glow: 0.4 });
  g.add(box(heroMat, [0, 0.4, 0, 6, 0.8, 6]));
  g.add(
    boxes(standard(INK.light), [
      [0, 0.25, 35, 98, 0.5, 3],
      [0, 0.25, -35, 98, 0.5, 3],
    ]),
  );
  return realm('R4', g, (ctx) => {
    heroMat.emissiveIntensity = 0.4 + 0.9 * beat(ctx, 9, 0, 0.5);
  });
}

// ---------------------------------------------------------------------------
// R5 Matrix tile (abstract)
// ---------------------------------------------------------------------------

function buildTile(): Realm {
  const g = new Group();
  g.add(box(standard(INK.dark), [0, 0, -0.15, 4.4, 4.4, 0.06]));
  const cells = new InstancedMesh(UNIT_BOX, standard(0xffffff, { rough: 0.6 }), 64);
  const off = new Color(INK.dark).lerp(new Color(INK.mid), 0.5);
  const on = new Color(INK.cyan);
  for (let i = 0; i < 64; i++) {
    const col = i % 8;
    const row = Math.floor(i / 8);
    setBox(cells, i, [(col - 3.5) * 0.5, (3.5 - row) * 0.5, 0, 0.42, 0.42, 0.12]);
    cells.setColorAt(i, off);
  }
  cells.instanceMatrix.needsUpdate = true;
  cells.computeBoundingSphere();
  g.add(cells);
  const edge = 2.1;
  g.add(
    rods(
      standard(INK.light),
      chain([
        [-edge, -edge, 0],
        [edge, -edge, 0],
        [edge, edge, 0],
        [-edge, edge, 0],
        [-edge, -edge, 0],
      ]),
      0.03,
    ),
  );

  let lit = 0;
  return realm('R5', g, (ctx) => {
    const n = Math.round(64 * beat(ctx, 9, 0.55, 0.95));
    if (n === lit) return;
    lit = n;
    for (let i = 0; i < 64; i++) cells.setColorAt(i, i < n ? on : off);
    if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
  });
}

// ---------------------------------------------------------------------------
// R6 Math space (abstract)
// ---------------------------------------------------------------------------

function buildMathSpace(): Realm {
  const g = new Group();
  const N = 8;
  const tokenX = (i: number): number => -7 + 2 * i;

  // The message, then the same message cut into token chips.
  const message = box(standard(INK.light), [0, 0.4, 0, 15.4, 0.8, 0.5]);
  g.add(message);
  const chips = new InstancedMesh(UNIT_BOX, standard(0xffffff, { rough: 0.7 }), N);
  chips.frustumCulled = false;
  const chipColor = new Color(INK.light);
  const queryColor = new Color(INK.amber);
  for (let i = 0; i < N; i++) chips.setColorAt(i, chipColor);
  g.add(chips);

  // One column per token: its embedding.
  const columns = new InstancedMesh(UNIT_BOX, standard(INK.cyan, { emissive: INK.cyan, glow: 0.35 }), N);
  columns.frustumCulled = false;
  g.add(columns);

  // Attention arcs from every token back to each earlier one, merged into one
  // mesh and revealed by draw range. All the same weight: no values implied.
  const arcParts: BufferGeometry[] = [];
  for (let i = 1; i < N; i++) {
    for (let j = 0; j < i; j++) {
      const from = new Vector3(tokenX(i), 0.85, 0.3);
      const to = new Vector3(tokenX(j), 0.85, 0.3);
      const peak = new Vector3((from.x + to.x) / 2, 0.85 + 0.55 * (from.x - to.x), 0.3);
      arcParts.push(new TubeGeometry(new QuadraticBezierCurve3(from, peak, to), 20, 0.035, 5, false));
    }
  }
  const indicesPerArc = arcParts[0]?.index?.count ?? 0;
  const arcCount = arcParts.length;
  const arcGeometry = mergeGeometries(arcParts);
  for (const part of arcParts) part.dispose();
  if (!arcGeometry) throw new Error('could not merge the attention arcs');
  const arcs = new Mesh(arcGeometry, standard(INK.cyan, { emissive: INK.cyan, glow: 0.6, opacity: 0.8 }));
  arcs.visible = false;
  g.add(arcs);

  // Stacked layers, and one stream per token rising through them.
  const layers = new InstancedMesh(UNIT_BOX, standard(INK.cyan, { emissive: INK.cyan, glow: 0.2, opacity: 0.18 }), 6);
  for (let k = 0; k < 6; k++) setBox(layers, k, [0, 6 + 4 * k, -0.4, 17, 0.3, 4.6]);
  layers.instanceMatrix.needsUpdate = true;
  layers.computeBoundingSphere();
  layers.count = 0;
  g.add(layers);
  const streams = new Group();
  streams.position.y = 0.8;
  streams.add(
    rods(
      standard(INK.cyan, { emissive: INK.cyan, glow: 0.4, opacity: 0.35 }),
      Array.from({ length: N }, (_, i): Segment => [
        [tokenX(i), 0, -0.4],
        [tokenX(i), 27.7, -0.4],
      ]),
      0.05,
    ),
  );
  streams.visible = false;
  g.add(streams);

  // Score bars: placeholder heights, then the same bars squashed the way softmax would.
  const cols = 24;
  const rows = 8;
  const barCount = cols * rows;
  const logit = new Float32Array(barCount);
  for (let i = 0; i < barCount; i++) logit[i] = 0.25 + 2.3 * Math.pow(hash01(i), 2.2);
  const ranked = Array.from({ length: barCount }, (_, i) => i).sort((a, b) => (logit[b] ?? 0) - (logit[a] ?? 0));
  const winner = ranked[0] ?? 0;
  logit[winner] = (logit[winner] ?? 0) + 0.6;
  const top = new Set(ranked.slice(0, 3));
  const maxLogit = logit[winner] ?? 0;
  const prob = new Float32Array(barCount);
  for (let i = 0; i < barCount; i++) prob[i] = Math.max(0.03, 3 * Math.exp(2.4 * ((logit[i] ?? 0) - maxLogit)));
  const bars = new InstancedMesh(UNIT_BOX, standard(0xffffff, { rough: 0.7 }), barCount);
  bars.frustumCulled = false;
  bars.visible = false;
  const barGray = new Color(INK.mid);
  const barTop = new Color(INK.cyan);
  const barWin = new Color(INK.amber);
  for (let i = 0; i < barCount; i++) bars.setColorAt(i, top.has(i) ? barTop : barGray);
  g.add(bars);
  const barX = (i: number): number => ((i % cols) - (cols - 1) / 2) * 0.62;
  const barZ = (i: number): number => -1 + (Math.floor(i / cols) - (rows - 1) / 2) * 0.62;

  // The sampler: a weighted wheel (placeholder wedge sizes) and the token it picks.
  const wheel = new Group();
  wheel.position.set(0, 34, 2);
  wheel.visible = false;
  g.add(wheel);
  const spinner = new Group();
  wheel.add(spinner);
  const shares = [0.4, 0.24, 0.16, 0.12, 0.08];
  let angle = 0;
  shares.forEach((share, k) => {
    const sweep = share * Math.PI * 2;
    const material =
      k === 0 ? standard(INK.cyan, { emissive: INK.cyan, glow: 0.35 }) : standard(k % 2 === 1 ? INK.mid : INK.light);
    spinner.add(new Mesh(new CircleGeometry(2.2, 48, angle + 0.012, sweep - 0.024), material));
    angle += sweep;
  });
  const backing = new Mesh(new CircleGeometry(2.36, 48), standard(INK.dark));
  backing.position.z = -0.02;
  wheel.add(backing);
  wheel.add(box(standard(INK.amber, { emissive: INK.amber, glow: 0.9 }), [0, 2.5, 0.05, 0.3, 0.5, 0.1]));
  const firstWedgeMiddle = (shares[0] ?? 0) * Math.PI;
  const chosen = box(standard(INK.amber, { emissive: INK.amber, glow: 0.9 }), [0, 34, 3.1, 1.4, 0.8, 0.5]);
  chosen.visible = false;
  g.add(chosen);

  let shownSplit = -1;
  let shownQuery: boolean | null = null;
  let shownColumns = -1;
  let shownBars = '';
  let shownWinner: boolean | null = null;

  return realm('R6', g, (ctx) => {
    // Shot 10: the message splits into tokens.
    const chipsOut = ctx.shot.id > 10 || (ctx.shot.id === 10 && ctx.progress >= 0.65);
    message.visible = !chipsOut;
    chips.visible = chipsOut;
    const split = ease(beat(ctx, 10, 0.65, 0.85));
    if (chipsOut && split !== shownSplit) {
      shownSplit = split;
      for (let i = 0; i < N; i++) setBox(chips, i, [tokenX(i) * (0.8 + 0.2 * split), 0.4, 0, 1.4, 0.8, 0.5]);
      chips.instanceMatrix.needsUpdate = true;
    }
    const query = ctx.shot.id >= 12;
    if (query !== shownQuery) {
      shownQuery = query;
      chips.setColorAt(N - 1, query ? queryColor : chipColor);
      if (chips.instanceColor) chips.instanceColor.needsUpdate = true;
    }

    // Shot 11: embedding columns rise.
    const height = 3.2 * ease(beat(ctx, 11, 0.1, 0.8));
    columns.visible = height > 0.001;
    if (columns.visible && height !== shownColumns) {
      shownColumns = height;
      for (let i = 0; i < N; i++) setBox(columns, i, [tokenX(i), 0.8 + height / 2, -0.9, 0.45, height, 0.45]);
      columns.instanceMatrix.needsUpdate = true;
    }

    // Shot 12: attention arcs draw in.
    const shownArcs = Math.floor(arcCount * beat(ctx, 12, 0.08, 0.85) + 1e-6);
    arcs.visible = shownArcs > 0;
    arcGeometry.setDrawRange(0, shownArcs * indicesPerArc);

    // Shot 13: layers stack up, streams rise through them.
    const stack = beat(ctx, 13, 0.02, 0.9);
    layers.count = Math.min(6, Math.floor(7 * stack));
    layers.visible = layers.count > 0;
    const rise = ease(stack);
    streams.visible = rise > 0.001;
    streams.scale.y = Math.max(0.001, rise);

    // Shots 14 and 15: score bars erupt, then melt into probabilities.
    const grow = ease(beat(ctx, 14, 0.05, 0.6));
    const melt = ease(beat(ctx, 15, 0.15, 0.85));
    bars.visible = grow > 0.001;
    const barKey = `${grow.toFixed(4)}|${melt.toFixed(4)}`;
    if (bars.visible && barKey !== shownBars) {
      shownBars = barKey;
      for (let i = 0; i < barCount; i++) {
        const h = Math.max(0.02, (1 - melt) * (logit[i] ?? 0) * grow + melt * (prob[i] ?? 0));
        setBox(bars, i, [barX(i), 29 + h / 2, barZ(i), 0.5, h, 0.5]);
      }
      bars.instanceMatrix.needsUpdate = true;
    }

    // Shot 16: the wheel spins, stops on the first wedge, and a token pops out.
    wheel.visible = ctx.shot.id >= 16;
    if (wheel.visible) {
      const turns = ctx.reducedMotion ? 0 : 4;
      const finalAngle = Math.PI / 2 - firstWedgeMiddle + turns * Math.PI * 2;
      const spin = beat(ctx, 16, 0.05, 0.8);
      spinner.rotation.z = finalAngle * (1 - Math.pow(1 - spin, 3));
      wheel.scale.setScalar(Math.max(0.001, ease(beat(ctx, 16, 0, 0.12))));
    }
    const pop = ease(beat(ctx, 16, 0.82, 0.95));
    chosen.visible = pop > 0.001;
    chosen.scale.set(1.4 * pop, 0.8 * pop, 0.5 * pop);
    const winnerLit = pop > 0.001;
    if (winnerLit !== shownWinner) {
      shownWinner = winnerLit;
      bars.setColorAt(winner, winnerLit ? barWin : barTop);
      if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    }
  });
}

// ---------------------------------------------------------------------------
// R7 Reply (1 unit = 1 cm; the city backdrop is not to scale)
// ---------------------------------------------------------------------------

function buildReply(): Realm {
  const g = new Group();
  g.add(box(standard(INK.dark), [0, 0, 0, 7.2, 14.6, 0.8]));
  g.add(box(standard(INK.screen, { emissive: 0x0d141b, glow: 1 }), [0, 0, 0.42, 6.6, 13.4, 0.04]));
  g.add(box(standard(0x3a2a14, { emissive: INK.amber, glow: 0.25 }), [1, 4.6, 0.46, 4.2, 1.3, 0.04]));
  g.add(box(standard(0x123039, { emissive: INK.cyan, glow: 0.18 }), [-0.4, 2, 0.46, 5.4, 2.4, 0.04]));

  // The reply's words, typed in one by one (placeholder blocks, not text).
  const words: BoxSpec[] = [
    [-2.4, 2.8, 0.5, 0.9, 0.32, 0.03],
    [-1.2, 2.8, 0.5, 1.2, 0.32, 0.03],
    [-0.05, 2.8, 0.5, 0.8, 0.32, 0.03],
    [1.05, 2.8, 0.5, 1.1, 0.32, 0.03],
    [-2.3, 2.2, 0.5, 1.1, 0.32, 0.03],
    [-1.25, 2.2, 0.5, 0.7, 0.32, 0.03],
    [-0.1, 2.2, 0.5, 1.3, 0.32, 0.03],
    [1.15, 2.2, 0.5, 0.9, 0.32, 0.03],
    [-2.25, 1.6, 0.5, 1.2, 0.32, 0.03],
    [-1.05, 1.6, 0.5, 0.9, 0.32, 0.03],
  ];
  const typed = boxes(standard(INK.text, { emissive: INK.text, glow: 0.35 }), words);
  typed.count = 0;
  g.add(typed);

  // City backdrop, with the grid glowing under it.
  const city: BoxSpec[] = [];
  for (let i = 0; i < 70; i++) {
    const x = (hash01(i * 3 + 1) - 0.5) * 12000;
    const z = -2600 - hash01(i * 3 + 2) * 4200;
    const h = 300 + Math.pow(hash01(i * 3 + 3), 1.6) * 1700;
    const w = 160 + hash01(i * 7) * 320;
    city.push([x, -500 + h / 2, z, w, h, w * (0.8 + hash01(i * 11) * 0.6)]);
  }
  g.add(boxes(standard(INK.dark), city));
  const grid: Segment[] = [];
  for (let k = -6; k <= 6; k++) grid.push([[k * 900, -499, -1800], [k * 900, -499, -8000]]);
  for (let k = 0; k <= 7; k++) {
    const z = -1800 - k * 880;
    grid.push([[-6000, -499, z], [6000, -499, z]]);
  }
  g.add(rods(standard(INK.amber, { emissive: INK.amber, glow: 0.5 }), grid, 7));

  // The storm on the horizon: the opening shot, seen from the end.
  const stormMat = standard(INK.amber, { emissive: INK.amber, glow: 1, opacity: 0.6 });
  g.add(
    rods(
      stormMat,
      chain([
        [3200, 3600, -9500],
        [3350, 2800, -9500],
        [3050, 2000, -9500],
        [3300, 1100, -9500],
        [3150, -500, -9500],
      ]),
      22,
    ),
  );
  g.add(
    boxes(standard(INK.dark), [
      [2600, 3900, -9800, 5200, 400, 1600],
      [-1200, 4200, -10400, 6400, 380, 1800],
    ]),
  );

  return realm('R7', g, (ctx) => {
    typed.count = Math.round(words.length * beat(ctx, 18, 0.05, 0.6));
    const flash = ctx.shot.id === 18 && !ctx.reducedMotion ? strike(ctx.t - ctx.shot.start, CLOSING_STROKES) : 0;
    stormMat.opacity = 0.6 + 0.4 * flash;
    stormMat.emissiveIntensity = 1 + 1.2 * flash;
  });
}

/** Build all eight realms. Each group starts hidden. */
export function buildRealms(): Record<RealmId, Realm> {
  const realms: Record<RealmId, Realm> = {
    R0: buildStormAndGrid(),
    R1: buildHall(),
    R2: buildServer(),
    R3: buildPackage(),
    R4: buildDie(),
    R5: buildTile(),
    R6: buildMathSpace(),
    R7: buildReply(),
  };
  for (const r of Object.values(realms)) r.group.visible = false;
  return realms;
}
