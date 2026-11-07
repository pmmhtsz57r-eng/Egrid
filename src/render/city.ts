import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Simulation } from '../sim/engine';
import type { NetworkDef, SimState, Vec2 } from '../sim/types';
import { buildCity, railPoint, RAIL_PATH, riverX } from './layout';
import { NOVA_CITY } from '../scenario/novaCity';

/**
 * The 3D city. Reads simulation state every frame; never writes it.
 * Visual-only randomness (rain, distant lightning) uses its own generator and has no effect
 * on the game.
 */

export type Quality = 'high' | 'low';
export type ViewMode = 'landing' | 'play' | 'results';

const C = {
  ok: new THREE.Color('#38e8ff'),
  warn: new THREE.Color('#ffb020'),
  crit: new THREE.Color('#ff3045'),
  dead: new THREE.Color('#1b2230'),
  good: new THREE.Color('#3dffa0'),
  warm: new THREE.Color('#ffc477'),
  cool: new THREE.Color('#bfe3ff'),
};

const lerpColor = (out: THREE.Color, loading: number) => {
  if (loading < 0.8) return out.copy(C.ok);
  if (loading < 1) return out.copy(C.ok).lerp(C.warn, (loading - 0.8) / 0.2);
  return out.copy(C.warn).lerp(C.crit, Math.min(1, (loading - 1) / 0.3));
};

const BUILDING_VERT = /* glsl */ `
  attribute float aSeed;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSeed;
  varying float vHeight;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
    vSeed = aSeed;
    vHeight = instanceMatrix[1][1];
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const BUILDING_FRAG = /* glsl */ `
  uniform float uPower;
  uniform float uEmergency;
  uniform float uLit;
  uniform float uTime;
  uniform float uFlash;
  uniform vec3 uTint;
  uniform vec3 uBase;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSeed;
  varying float vHeight;
  #include <fog_pars_fragment>
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vNormal);
    float side = 1.0 - step(0.6, abs(n.y));
    vec2 uv = abs(n.x) > 0.5 ? vec2(vWorld.z, vWorld.y) : vec2(vWorld.x, vWorld.y);
    vec2 g = uv / vec2(0.9, 1.15);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float win = step(0.18, f.x) * step(f.x, 0.78) * step(0.22, f.y) * step(f.y, 0.72) * side * step(0.9, vWorld.y);
    float h = hash(cell + vSeed * 13.1);
    float flick = step(0.5, fract(uTime * 3.0 + h * 7.0));
    float lit = step(1.0 - uLit, h) * uPower * (uPower < 0.99 ? mix(1.0, flick, 0.6) : 1.0);
    float em = step(0.93, h) * uEmergency;
    vec3 moon = vec3(0.10, 0.14, 0.22) * (0.35 + 0.65 * max(0.0, dot(n, normalize(vec3(-0.4, 0.8, 0.3)))));
    vec3 col = uBase * (0.6 + 0.4 * side) + moon * 0.6;
    col += uFlash * vec3(0.55, 0.6, 0.8) * (0.4 + 0.6 * max(0.0, n.y + side * 0.4));
    vec3 w = uTint * (0.7 + 0.6 * h);
    col = mix(col, w * 2.2, win * lit);
    col = mix(col, vec3(1.0, 0.18, 0.15) * 1.6, win * em * (0.6 + 0.4 * sin(uTime * 4.0 + h * 10.0)));
    // roof edge light on tall buildings
    float roof = step(0.6, n.y) * step(10.0, vHeight) * uPower * step(0.92, hash(cell * 0.1 + vSeed));
    col += roof * vec3(1.0, 0.15, 0.1);
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

interface ZoneVisual {
  material: THREE.ShaderMaterial;
  lights: THREE.PointsMaterial;
  power: number;
  emergency: number;
}

interface LineVisual {
  id: string;
  curve: THREE.CatmullRomCurve3;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  offset: number;
  particles: number;
  start: number;
  length: number;
}

export interface EntityAnchor {
  id: string;
  kind: 'sub' | 'gen' | 'zone' | 'line';
  pos: THREE.Vector3;
}

export class CityRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private clock = new THREE.Clock();
  private zones = new Map<string, ZoneVisual>();
  private lines: LineVisual[] = [];
  private feeders: { zone: string; curve: THREE.CatmullRomCurve3; material: THREE.MeshBasicMaterial; start: number; particles: number; offset: number }[] = [];
  private particleGeo!: THREE.BufferGeometry;
  private particleColors!: Float32Array;
  private particlePositions!: Float32Array;
  private subs = new Map<string, { ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; beam: THREE.Mesh; beamMat: THREE.MeshBasicMaterial; group: THREE.Group }>();
  private turbines: THREE.Object3D[] = [];
  private gasGlow!: THREE.MeshBasicMaterial;
  private hydroGlow!: THREE.MeshBasicMaterial;
  private train!: THREE.Group;
  private trainT = 0.1;
  private trainMat!: THREE.MeshBasicMaterial;
  private beacons: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; zone: string }[] = [];
  private rain!: THREE.LineSegments;
  private rainPos!: Float32Array;
  private hemi!: THREE.HemisphereLight;
  private flash = 0;
  private bolt: THREE.Line | null = null;
  private boltLife = 0;
  private vrng = 1;
  private selection: THREE.Mesh;
  private selectionTarget: THREE.Vector3 | null = null;
  private pickables: THREE.Object3D[] = [];
  private focusFrom: { target: THREE.Vector3; pos: THREE.Vector3 } | null = null;
  private focusTo: { target: THREE.Vector3; pos: THREE.Vector3 } | null = null;
  private focusT = 1;
  private lastInteraction = -1e9;
  private mode: ViewMode = 'landing';
  private width = 1;
  private height = 1;
  readonly anchors: EntityAnchor[] = [];
  quality: Quality;
  private disposed = false;
  private sim: Simulation | null = null;
  private seenLineTrips = new Set<string>();

  constructor(private container: HTMLElement, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'city-canvas';

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 2000);
    this.camera.position.set(-150, 150, 210);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 5);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 45;
    this.controls.maxDistance = 360;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.25;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => {
      this.lastInteraction = this.clock.elapsedTime;
      this.focusTo = null;
    });

    this.scene.background = new THREE.Color('#05080f');
    this.scene.fog = new THREE.FogExp2('#070b16', 0.0034);

    this.hemi = new THREE.HemisphereLight('#3a4a78', '#05060a', 0.9);
    this.scene.add(this.hemi);
    const moon = new THREE.DirectionalLight('#8aa4ff', 0.6);
    moon.position.set(-100, 200, 80);
    this.scene.add(moon);

    this.buildGround();
    this.buildBuildings(NOVA_CITY);
    this.buildRail();
    this.buildGrid(NOVA_CITY);
    this.buildGenerators(NOVA_CITY);
    this.buildRain();

    const selGeo = new THREE.RingGeometry(7, 8.2, 48);
    selGeo.rotateX(-Math.PI / 2);
    this.selection = new THREE.Mesh(selGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }));
    this.selection.visible = false;
    this.scene.add(this.selection);

    if (quality === 'high') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.32);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  // ------------------------------------------------------------------ construction

  private rand() {
    this.vrng = (this.vrng * 16807) % 2147483647;
    return this.vrng / 2147483647;
  }

  private buildGround() {
    const size = 700;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: { ...THREE.UniformsLib.fog, uFlash: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uFlash;
        varying vec3 vWorld;
        #include <fog_pars_fragment>
        float line(float v, float w) { float f = abs(fract(v) - 0.5); return smoothstep(w, 0.0, f); }
        void main() {
          vec3 col = vec3(0.018, 0.024, 0.036);
          float d = length(vWorld.xz);
          float city = smoothstep(170.0, 90.0, d);
          float roads = max(line(vWorld.x / 6.5 + 0.5, 0.04), line(vWorld.z / 6.5 + 0.5, 0.04)) * 0.35;
          float avenues = max(line(vWorld.x / 39.0 + 0.5, 0.05), line(vWorld.z / 33.0 + 0.5, 0.05));
          col += vec3(0.05, 0.07, 0.1) * roads * city + vec3(0.32, 0.22, 0.12) * avenues * city * 0.55;
          col += uFlash * vec3(0.12, 0.14, 0.2);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.userData.flash = mat;
    this.scene.add(ground);
    this.groundMat = mat;

    // river
    const pts: THREE.Vector3[] = [];
    for (let z = -160; z <= 160; z += 8) pts.push(new THREE.Vector3(riverX(z), 0.05, z));
    const shape: number[] = [];
    const idx: number[] = [];
    pts.forEach((p, i) => {
      shape.push(p.x - 6, 0.06, p.z, p.x + 6, 0.06, p.z);
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(shape, 3));
    rg.setIndex(idx);
    rg.computeVertexNormals();
    this.scene.add(new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: '#0a1a2e', roughness: 0.15, metalness: 0.6, emissive: '#04101c', side: THREE.DoubleSide })));
  }

  private groundMat!: THREE.ShaderMaterial;

  private buildBuildings(net: NetworkDef) {
    const all = buildCity(net);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    for (const z of net.zones) {
      const list = all.filter((b) => b.zone === z.id);
      const tint = z.kind === 'hospital' || z.kind === 'emergency' ? C.cool : z.kind === 'datacentre' ? new THREE.Color('#7fe9ff') : z.kind === 'industrial' ? new THREE.Color('#ffa860') : C.warm;
      const material = new THREE.ShaderMaterial({
        fog: true,
        uniforms: {
          ...THREE.UniformsLib.fog,
          uPower: { value: 1 }, uEmergency: { value: 0 }, uLit: { value: z.kind === 'residential' ? 0.42 : 0.55 },
          uTime: { value: 0 }, uFlash: { value: 0 }, uTint: { value: tint }, uBase: { value: new THREE.Color('#0b0f18') },
        },
        vertexShader: BUILDING_VERT,
        fragmentShader: BUILDING_FRAG,
      });
      const mesh = new THREE.InstancedMesh(box, material, list.length);
      const seeds = new Float32Array(list.length);
      const m = new THREE.Matrix4();
      list.forEach((b, i) => {
        m.makeScale(b.w, b.h, b.d);
        m.setPosition(b.x, 0, b.z);
        mesh.setMatrixAt(i, m);
        seeds[i] = b.seed;
      });
      box.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.geometry = box.clone();
      mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.userData.pick = { id: z.id, kind: 'zone' };
      this.scene.add(mesh);
      this.pickables.push(mesh);

      // street lights
      const lp: number[] = [];
      const r = createLocalRng(z.id.charCodeAt(2) * 97 + 3);
      for (let i = 0; i < Math.round((z.size[0] * z.size[1]) / 18); i++) {
        const x = z.pos[0] + (r() - 0.5) * z.size[0] * 1.5;
        const zz = z.pos[1] + (r() - 0.5) * z.size[1] * 1.5;
        const sx = Math.round(x / 6.5) * 6.5 + 3.25;
        lp.push(r() > 0.5 ? sx : x, 0.6, r() > 0.5 ? Math.round(zz / 6.5) * 6.5 + 3.25 : zz);
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      const lights = new THREE.PointsMaterial({ color: '#ffb86b', size: 1.3, sizeAttenuation: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.scene.add(new THREE.Points(lg, lights));
      this.zones.set(z.id, { material, lights, power: 1, emergency: 0 });

      // landmark buildings
      if (z.kind === 'hospital') this.addHospital(z.id, z.pos);
      if (z.kind === 'datacentre') this.addDataCentre(z.pos);
      if (z.kind === 'emergency') this.addBeacon(z.id, [z.pos[0], z.pos[1]], 26, '#3b7bff');
      this.anchors.push({ id: z.id, kind: 'zone', pos: new THREE.Vector3(z.pos[0], z.kind === 'hospital' ? 22 : 12, z.pos[1]) });
    }
  }

  private addHospital(zone: string, pos: Vec2) {
    const g = new THREE.Group();
    const tower = new THREE.Mesh(new THREE.BoxGeometry(9, 18, 7), new THREE.MeshStandardMaterial({ color: '#cfd8e6', roughness: 0.7, emissive: '#1a2230' }));
    tower.position.y = 9;
    g.add(tower);
    const crossMat = new THREE.MeshBasicMaterial({ color: '#ff2a3a', toneMapped: false });
    const a = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 1.4), crossMat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 5), crossMat);
    a.position.y = b.position.y = 18.3;
    g.add(a, b);
    g.position.set(pos[0], 0, pos[1]);
    g.userData.pick = { id: zone, kind: 'zone' };
    tower.userData.pick = g.userData.pick;
    this.scene.add(g);
    this.pickables.push(tower);
    this.addBeacon(zone, pos, 20.5, '#ff2a3a', crossMat);
  }

  private addDataCentre(pos: Vec2) {
    const mat = new THREE.MeshBasicMaterial({ color: '#38e8ff', toneMapped: false });
    for (let i = 0; i < 3; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(14, 0.25, 0.25), mat);
      strip.position.set(pos[0], 1.2 + i * 1.6, pos[1] + 6.2);
      this.scene.add(strip);
    }
    this.beacons.push({ mesh: new THREE.Mesh(), mat, zone: 'Z06' });
  }

  private addBeacon(zone: string, pos: Vec2, y: number, color: string, extra?: THREE.MeshBasicMaterial) {
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true });
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), mat);
    m.position.set(pos[0], y, pos[1]);
    this.scene.add(m);
    this.beacons.push({ mesh: m, mat, zone });
    if (extra) this.beacons.push({ mesh: new THREE.Mesh(), mat: extra, zone });
  }

  private buildRail() {
    const pts = RAIL_PATH.map(([x, z]) => new THREE.Vector3(x, 0.3, z));
    const mat = new THREE.LineBasicMaterial({ color: '#2a3550' });
    for (const off of [-0.7, 0.7]) {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().add(new THREE.Vector3(0, 0, off))));
      this.scene.add(new THREE.Line(g, mat));
    }
    this.train = new THREE.Group();
    this.trainMat = new THREE.MeshBasicMaterial({ color: '#ffe3b0', toneMapped: false });
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.4, 1.6), new THREE.MeshStandardMaterial({ color: '#2b3448', emissive: '#0a0f1a' }));
      car.position.x = -i * 4.6;
      const windows = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 1.62), this.trainMat);
      windows.position.set(-i * 4.6, 0.2, 0);
      this.train.add(car, windows);
    }
    this.train.position.y = 1;
    this.scene.add(this.train);
    // station
    const st = new THREE.Mesh(new THREE.BoxGeometry(26, 4, 8), new THREE.MeshStandardMaterial({ color: '#1a2233', emissive: '#0b1220' }));
    st.position.set(40, 2, -82);
    this.scene.add(st);
  }

  private busPos(net: NetworkDef, id: string): Vec2 {
    return net.buses.find((b) => b.id === id)!.pos;
  }

  private buildGrid(net: NetworkDef) {
    // pylons
    const pylonGeo = new THREE.CylinderGeometry(0.25, 0.7, 11, 4);
    pylonGeo.translate(0, 5.5, 0);
    const pylons: THREE.Vector3[] = [];
    let start = 0;
    for (const l of net.lines) {
      const a = this.busPos(net, l.from);
      const b = this.busPos(net, l.to);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(2, Math.round(len / 18));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const sag = Math.sin(t * Math.PI * n) * 0; // straight between pylons
        pts.push(new THREE.Vector3(x, 11 + sag, z));
        if (i > 0 && i < n) pylons.push(new THREE.Vector3(x, 0, z));
      }
      // add sag between pylons
      const sagged: THREE.Vector3[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        sagged.push(pts[i]);
        const mid = pts[i].clone().lerp(pts[i + 1], 0.5);
        mid.y -= 1.6;
        sagged.push(mid);
      }
      sagged.push(pts[pts.length - 1]);
      const curve = new THREE.CatmullRomCurve3(sagged);
      const material = new THREE.MeshBasicMaterial({ color: C.ok.clone(), toneMapped: false, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, n * 10), 0.28, 5), material);
      mesh.userData.pick = { id: l.id, kind: 'line' };
      this.scene.add(mesh);
      // fat invisible pick tube
      const pick = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 3.2, 4), new THREE.MeshBasicMaterial({ visible: false }));
      pick.userData.pick = { id: l.id, kind: 'line' };
      this.scene.add(pick);
      this.pickables.push(pick);
      const particles = Math.round(l.limit / 4) + 8;
      this.lines.push({ id: l.id, curve, mesh, material, offset: this.rand(), particles, start, length: len });
      start += particles;
      this.anchors.push({ id: l.id, kind: 'line', pos: curve.getPoint(0.5).add(new THREE.Vector3(0, 3, 0)) });
    }
    const pylonMesh = new THREE.InstancedMesh(pylonGeo, new THREE.MeshStandardMaterial({ color: '#3a465e', emissive: '#0b1018' }), pylons.length);
    const m = new THREE.Matrix4();
    pylons.forEach((p, i) => {
      m.makeTranslation(p.x, 0, p.z);
      pylonMesh.setMatrixAt(i, m);
    });
    this.scene.add(pylonMesh);

    // feeders: substation -> zone (primary)
    for (const z of net.zones) {
      const s = this.busPos(net, z.primary);
      const a = new THREE.Vector3(s[0], 2.5, s[1]);
      const b = new THREE.Vector3(z.pos[0], 2.5, z.pos[1]);
      const mid = a.clone().lerp(b, 0.5);
      mid.y = 4;
      const curve = new THREE.CatmullRomCurve3([a, mid, b]);
      const material = new THREE.MeshBasicMaterial({ color: C.ok.clone(), toneMapped: false, transparent: true, opacity: 0.55 });
      this.scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.14, 4), material));
      const particles = 10;
      this.feeders.push({ zone: z.id, curve, material, start, particles, offset: this.rand() });
      start += particles;
    }
    this.particlePositions = new Float32Array(start * 3);
    this.particleColors = new Float32Array(start * 3);
    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.particleGeo.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    const pm = new THREE.PointsMaterial({ size: 2.2, vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, map: glowTexture() });
    const points = new THREE.Points(this.particleGeo, pm);
    points.frustumCulled = false;
    this.scene.add(points);

    // substations
    for (const s of net.substations) {
      const g = new THREE.Group();
      g.position.set(s.pos[0], 0, s.pos[1]);
      const base = new THREE.Mesh(new THREE.BoxGeometry(11, 0.6, 11), new THREE.MeshStandardMaterial({ color: '#141b28', emissive: '#060a12' }));
      base.position.y = 0.3;
      g.add(base);
      for (let i = 0; i < 3; i++) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.6, 2.2), new THREE.MeshStandardMaterial({ color: '#4a5670', emissive: '#0d1420', metalness: 0.5, roughness: 0.4 }));
        t.position.set(-3 + i * 3, 1.9, -1.5);
        g.add(t);
      }
      const ringMat = new THREE.MeshBasicMaterial({ color: C.ok.clone(), toneMapped: false, transparent: true, opacity: 0.95 });
      const ringGeo = new THREE.RingGeometry(7.2, 8, 40);
      ringGeo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.4;
      g.add(ring);
      const beamMat = new THREE.MeshBasicMaterial({ color: C.crit.clone(), toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.5, 70, 12, 1, true), beamMat);
      beam.position.y = 35;
      g.add(beam);
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 8, 8), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.y = 4;
      pick.userData.pick = { id: s.id, kind: 'sub' };
      g.add(pick);
      this.pickables.push(pick);
      this.scene.add(g);
      this.subs.set(s.id, { ring, ringMat, beam, beamMat, group: g });
      this.anchors.push({ id: s.id, kind: 'sub', pos: new THREE.Vector3(s.pos[0], 9, s.pos[1]) });
    }
  }

  private buildGenerators(net: NetworkDef) {
    for (const g of net.generators) {
      const group = new THREE.Group();
      group.position.set(g.pos[0], 0, g.pos[1]);
      if (g.kind === 'gas') {
        const hall = new THREE.Mesh(new THREE.BoxGeometry(22, 8, 12), new THREE.MeshStandardMaterial({ color: '#2a3244', emissive: '#0a0e16' }));
        hall.position.y = 4;
        group.add(hall);
        this.gasGlow = new THREE.MeshBasicMaterial({ color: '#ff8a3a', toneMapped: false });
        for (let i = 0; i < 2; i++) {
          const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.8, 26, 12), new THREE.MeshStandardMaterial({ color: '#3a4256' }));
          stack.position.set(-6 + i * 12, 13, 8);
          group.add(stack);
          const light = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff2a2a', toneMapped: false }));
          light.position.set(-6 + i * 12, 26.5, 8);
          group.add(light);
        }
        const glow = new THREE.Mesh(new THREE.BoxGeometry(18, 1.2, 0.3), this.gasGlow);
        glow.position.set(0, 5, 6.2);
        group.add(glow);
      } else if (g.kind === 'wind') {
        const r = createLocalRng(7);
        for (let i = 0; i < 9; i++) {
          const t = new THREE.Group();
          t.position.set((i % 3) * 16 - 16 + (r() - 0.5) * 4, 0, Math.floor(i / 3) * 14 - 14);
          const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.7, 18, 8), new THREE.MeshStandardMaterial({ color: '#c8d0dc', emissive: '#1a1f28' }));
          tower.position.y = 9;
          t.add(tower);
          const hub = new THREE.Group();
          hub.position.set(0, 18, 0.8);
          for (let k = 0; k < 3; k++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8.5, 0.15), new THREE.MeshStandardMaterial({ color: '#e6ebf2', emissive: '#20262f' }));
            blade.position.y = 4.2;
            const arm = new THREE.Group();
            arm.rotation.z = (k * Math.PI * 2) / 3;
            arm.add(blade);
            hub.add(arm);
          }
          const tip = new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 4), new THREE.MeshBasicMaterial({ color: '#ff2020', toneMapped: false }));
          tip.position.y = 18.6;
          t.add(hub, tip);
          group.add(t);
          this.turbines.push(hub);
        }
      } else {
        const dam = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 12, 24, 1, true, -0.6, 1.2), new THREE.MeshStandardMaterial({ color: '#3a4458', emissive: '#0b1018', side: THREE.DoubleSide }));
        dam.position.set(-24, 6, 0);
        group.add(dam);
        const lake = new THREE.Mesh(new THREE.CircleGeometry(28, 32), new THREE.MeshStandardMaterial({ color: '#0b1d33', metalness: 0.7, roughness: 0.2 }));
        lake.rotation.x = -Math.PI / 2;
        lake.position.set(10, 5, 0);
        group.add(lake);
        this.hydroGlow = new THREE.MeshBasicMaterial({ color: '#5fd0ff', toneMapped: false, transparent: true, opacity: 0.8 });
        const spill = new THREE.Mesh(new THREE.BoxGeometry(1.5, 10, 14), this.hydroGlow);
        spill.position.set(4.5, 5, 0);
        group.add(spill);
      }
      const pick = new THREE.Mesh(new THREE.SphereGeometry(24, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.y = 8;
      pick.userData.pick = { id: g.id, kind: 'gen' };
      group.add(pick);
      this.pickables.push(pick);
      this.scene.add(group);
      this.anchors.push({ id: g.id, kind: 'gen', pos: new THREE.Vector3(g.pos[0], g.kind === 'wind' ? 26 : 30, g.pos[1]) });
    }
  }

  private buildRain() {
    const count = this.quality === 'high' ? 5000 : 1600;
    this.rainPos = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const x = (this.rand() - 0.5) * 360;
      const y = this.rand() * 140;
      const z = (this.rand() - 0.5) * 360;
      this.rainPos.set([x, y, z, x + 0.6, y + 2.4, z + 0.3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#7f9cc8', transparent: true, opacity: 0.32, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  // ------------------------------------------------------------------ public

  setSim(sim: Simulation | null) {
    this.sim = sim;
    this.seenLineTrips.clear();
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.controls.autoRotate = mode !== 'play';
    this.controls.autoRotateSpeed = mode === 'landing' ? 0.35 : 0.2;
    if (mode === 'play') this.focus(new THREE.Vector3(0, 0, 5), 275, 0.92);
    if (mode === 'landing') this.focus(new THREE.Vector3(0, 0, 0), 290, 0.95);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole city visible in portrait
    this.camera.fov = w / h < 0.8 ? 58 : 42;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.bloom?.setSize(w / 2, h / 2);
  }

  /** Lightning bolt and flash at a map position. */
  strike(pos: Vec2) {
    this.flash = 1;
    if (this.bolt) this.scene.remove(this.bolt);
    const pts: THREE.Vector3[] = [];
    let x = pos[0] + (this.rand() - 0.5) * 30;
    let z = pos[1] + (this.rand() - 0.5) * 30;
    for (let y = 150; y > 11; y -= 9) {
      pts.push(new THREE.Vector3(x, y, z));
      const k = (y - 11) / 140;
      x += (pos[0] - x) * (1 - k) * 0.5 + (this.rand() - 0.5) * 7;
      z += (pos[1] - z) * (1 - k) * 0.5 + (this.rand() - 0.5) * 7;
    }
    pts.push(new THREE.Vector3(pos[0], 11, pos[1]));
    this.bolt = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#e8f0ff', transparent: true, opacity: 1, toneMapped: false }));
    this.scene.add(this.bolt);
    this.boltLife = 0.45;
  }

  /** Smoothly move the camera to look at a point. */
  focus(target: THREE.Vector3, distance = 120, polar = 0.9) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const az = Math.atan2(dir.x, dir.z);
    const pos = new THREE.Vector3(
      target.x + Math.sin(az) * Math.sin(polar) * distance,
      target.y + Math.cos(polar) * distance,
      target.z + Math.cos(az) * Math.sin(polar) * distance,
    );
    this.focusFrom = { target: this.controls.target.clone(), pos: this.camera.position.clone() };
    this.focusTo = { target, pos };
    this.focusT = 0;
  }

  focusEntity(id: string, distance = 110) {
    const a = this.anchors.find((x) => x.id === id);
    if (!a) return;
    this.focus(new THREE.Vector3(a.pos.x, 0, a.pos.z), distance, 0.85);
  }

  /** Called for a new incident: moves the camera only if the player is not steering. */
  attention(id: string) {
    if (this.mode !== 'play') return;
    if (this.clock.elapsedTime - this.lastInteraction < 6) return;
    const a = this.anchors.find((x) => x.id === id);
    if (!a) return;
    const d = this.camera.position.distanceTo(this.controls.target);
    this.focus(new THREE.Vector3(a.pos.x * 0.7, 0, a.pos.z * 0.7), Math.max(170, Math.min(240, d)), 0.95);
  }

  select(id: string | null) {
    if (!id) {
      this.selection.visible = false;
      this.selectionTarget = null;
      return;
    }
    const a = this.anchors.find((x) => x.id === id);
    if (!a) return;
    this.selectionTarget = new THREE.Vector3(a.pos.x, 0.5, a.pos.z);
    this.selection.visible = true;
    const s = a.kind === 'gen' ? 3.2 : a.kind === 'zone' ? 2.2 : a.kind === 'line' ? 0.8 : 1.2;
    this.selection.scale.setScalar(s);
    this.selection.position.copy(this.selectionTarget);
  }

  pick(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.pickables, false);
    const priority = { sub: 0, gen: 1, line: 2, zone: 3 } as const;
    let best: { id: string; kind: keyof typeof priority; d: number } | null = null;
    for (const h of hits) {
      const p = h.object.userData.pick as { id: string; kind: keyof typeof priority } | undefined;
      if (!p) continue;
      const score = h.distance + priority[p.kind] * 25;
      if (!best || score < best.d) best = { ...p, d: score };
    }
    return best?.id ?? null;
  }

  /** Screen position of an anchor (for HTML labels). */
  project(pos: THREE.Vector3, out: { x: number; y: number; visible: boolean }) {
    const v = pos.clone().project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (-v.y * 0.5 + 0.5) * this.height;
    out.visible = v.z < 1 && v.z > -1 && out.x > -40 && out.x < this.width + 40 && out.y > -40 && out.y < this.height + 40;
    return out;
  }

  // ------------------------------------------------------------------ per frame

  render() {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const s = this.sim?.state ?? null;

    // camera
    if (this.focusTo && this.focusFrom) {
      this.focusT = Math.min(1, this.focusT + dt / 1.4);
      const k = 1 - Math.pow(1 - this.focusT, 3);
      this.controls.target.lerpVectors(this.focusFrom.target, this.focusTo.target, k);
      this.camera.position.lerpVectors(this.focusFrom.pos, this.focusTo.pos, k);
      if (this.focusT >= 1) this.focusTo = null;
    }
    this.controls.update();

    // weather
    for (let i = 0; i < this.rainPos.length; i += 6) {
      this.rainPos[i + 1] -= 90 * dt;
      this.rainPos[i + 4] -= 90 * dt;
      this.rainPos[i] -= 12 * dt;
      this.rainPos[i + 3] -= 12 * dt;
      if (this.rainPos[i + 1] < 0) {
        const y = 140;
        const cx = this.controls.target.x;
        const cz = this.controls.target.z;
        const x = cx + (this.rand() - 0.5) * 360;
        const z = cz + (this.rand() - 0.5) * 360;
        this.rainPos.set([x, y, z, x + 0.6, y + 2.4, z + 0.3], i);
      }
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    if (this.rand() < dt * 0.08) this.flash = Math.max(this.flash, 0.35); // distant sheet lightning
    if (s) this.detectStrikes(s);
    this.flash = Math.max(0, this.flash - dt * 3.2);
    const flashV = this.flash * (0.6 + 0.4 * Math.sin(t * 60));
    this.hemi.intensity = 0.9 + flashV * 4;
    this.groundMat.uniforms.uFlash.value = flashV;
    if (this.bolt) {
      this.boltLife -= dt;
      (this.bolt.material as THREE.LineBasicMaterial).opacity = Math.max(0, this.boltLife / 0.45) * (0.5 + 0.5 * Math.sin(t * 80));
      if (this.boltLife <= 0) {
        this.scene.remove(this.bolt);
        this.bolt = null;
      }
    }

    this.updateCity(s, dt, t, flashV);

    if (this.selectionTarget) {
      this.selection.rotation.y += dt;
      (this.selection.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * Math.sin(t * 4);
    }

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  private detectStrikes(s: SimState) {
    const net = this.sim!.net;
    for (const l of net.lines) {
      const ls = s.lines[l.id];
      if (ls.tripped && !this.seenLineTrips.has(l.id)) {
        this.seenLineTrips.add(l.id);
        const a = this.busPos(net, l.from);
        const b = this.busPos(net, l.to);
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (ls.faultCause) this.strike(mid);
        else this.flash = Math.max(this.flash, 0.5);
      }
      if (!ls.tripped) this.seenLineTrips.delete(l.id);
    }
  }

  private updateCity(s: SimState | null, dt: number, t: number, flash: number) {
    const net = NOVA_CITY;
    const freq = s ? s.freq : 50;
    const brown = s ? Math.max(0.55, Math.min(1, 1 - (50 - freq) * 0.35)) : 1;
    const tmp = new THREE.Color();

    // zones
    for (const z of net.zones) {
      const v = this.zones.get(z.id)!;
      const zs = s?.zones[z.id];
      const target = zs ? zs.powered : 1;
      const emTarget = zs && z.critical ? (!zs.served && zs.criticalUp ? 1 : 0) : zs && !zs.served ? 0.25 : 0;
      const speed = target < v.power ? 2.2 : 0.9;
      v.power += Math.sign(target - v.power) * Math.min(Math.abs(target - v.power), dt * speed);
      v.emergency += (emTarget - v.emergency) * Math.min(1, dt * 3);
      const u = v.material.uniforms;
      u.uPower.value = v.power * brown;
      u.uEmergency.value = v.emergency;
      u.uTime.value = t;
      u.uFlash.value = flash;
      v.lights.opacity = 0.9 * v.power * brown;
    }
    for (const b of this.beacons) {
      const zs = s?.zones[b.zone];
      const up = zs ? zs.criticalUp || zs.served : true;
      const onBackup = zs ? !zs.served && zs.criticalUp : false;
      b.mat.opacity = up ? (onBackup ? 0.5 + 0.5 * Math.sin(t * 6) : 1) : 0.08;
      b.mat.transparent = true;
    }

    // lines + particles
    const pos = this.particlePositions;
    const col = this.particleColors;
    const p = new THREE.Vector3();
    for (const lv of this.lines) {
      const ls = s?.lines[lv.id];
      const def = net.lines.find((l) => l.id === lv.id)!;
      const loading = ls ? ls.loading : 0.4;
      const alive = ls ? ls.energised && ls.closed && !ls.tripped : true;
      const flow = ls ? ls.flow : def.limit * 0.35;
      if (!alive) lv.material.color.copy(C.dead);
      else lerpColor(lv.material.color, loading);
      lv.material.opacity = alive ? (loading > 1 ? 0.7 + 0.3 * Math.sin(t * 12) : 0.9) : 0.6;
      lv.offset += (dt * (alive ? flow : 0) * 0.9) / lv.length / 3;
      tmp.copy(lv.material.color);
      const active = alive ? Math.min(lv.particles, Math.ceil((Math.abs(flow) / def.limit) * lv.particles) + 2) : 0;
      for (let i = 0; i < lv.particles; i++) {
        const k = lv.start + i;
        if (i >= active) {
          pos[k * 3 + 1] = -100;
          continue;
        }
        const u = (((i / active + lv.offset) % 1) + 1) % 1;
        lv.curve.getPointAt(u, p);
        pos.set([p.x, p.y, p.z], k * 3);
        col.set([tmp.r * 1.4, tmp.g * 1.4, tmp.b * 1.4], k * 3);
      }
    }
    for (const f of this.feeders) {
      const zs = s?.zones[f.zone];
      const served = zs ? zs.served : true;
      const drawn = zs ? zs.drawn : 20;
      f.material.color.copy(served ? C.ok : C.dead);
      f.material.opacity = served ? 0.45 : 0.25;
      f.offset += dt * (served ? 0.15 + drawn / 120 : 0);
      for (let i = 0; i < f.particles; i++) {
        const k = f.start + i;
        if (!served) {
          pos[k * 3 + 1] = -100;
          continue;
        }
        f.curve.getPointAt((((i / f.particles + f.offset) % 1) + 1) % 1, p);
        pos.set([p.x, p.y, p.z], k * 3);
        col.set([0.35, 0.85, 1.0], k * 3);
      }
    }
    (this.particleGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.particleGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // substations
    for (const sub of net.substations) {
      const v = this.subs.get(sub.id)!;
      const ss = s?.subs[sub.id];
      let c = C.ok;
      let alarm = 0;
      if (ss) {
        const out = ss.damaged || ss.tripped || !ss.closed || !ss.energised;
        if (out) c = C.dead;
        else if (ss.temp > 120 || ss.measured > 1.0) c = C.crit;
        else if (ss.temp > 105 || ss.measured > 0.9) c = C.warn;
        if (ss.damaged || ss.tripped) alarm = 1;
        else if (ss.temp > 115 || ss.measured > 1) alarm = 0.6;
        if (ss.damaged && Math.sin(t * 20) > 0.6) c = C.crit;
      }
      v.ringMat.color.copy(c);
      v.ringMat.opacity = c === C.dead ? 0.4 : 0.85 + 0.15 * Math.sin(t * 5);
      v.beamMat.opacity = alarm * (0.18 + 0.12 * Math.sin(t * 7));
      v.beamMat.color.copy(ss?.damaged ? C.crit : ss?.tripped ? C.crit : C.warn);
      v.beam.visible = alarm > 0;
    }

    // generators
    if (s) {
      const g2 = s.gens.G2;
      const spin = g2.online ? Math.max(0.05, g2.pm / 90) : 0;
      for (const h of this.turbines) h.rotation.z -= dt * spin * 4;
      this.gasGlow.color.setRGB(1, 0.54, 0.23).multiplyScalar(s.gens.G1.online ? 0.4 + s.gens.G1.pm / 200 : 0.05);
      this.hydroGlow.opacity = s.gens.G3.online ? 0.2 + s.gens.G3.pm / 90 : 0;
    } else {
      for (const h of this.turbines) h.rotation.z -= dt * 3.6;
    }

    // train
    const rail = s?.zones.Z05;
    const railSpeed = rail ? (rail.served ? (rail.criticalDegraded ? 0.35 : 1) : 0) : 1;
    this.trainT += dt * 0.025 * railSpeed;
    const a = railPoint(this.trainT % 1);
    const b = railPoint((this.trainT + 0.002) % 1);
    this.train.position.set(a[0], 1, a[1]);
    this.train.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    this.trainMat.color.set(railSpeed > 0 ? '#ffe3b0' : '#202530');
  }

  dispose() {
    this.disposed = true;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function createLocalRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
