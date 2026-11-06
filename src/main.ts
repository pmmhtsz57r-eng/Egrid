/**
 * Module 1: one clock, one camera path, eight gray-box realms.
 *
 * Open the page and the 90-second spine plays; judge the pacing. Space pauses,
 * drag to look around while paused, D shows the debug overlay. URL options:
 * ?t=34 starts at 34 s, ?autoplay=0 waits for Play, ?debug opens the overlay.
 */
import { Color, DirectionalLight, Fog, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { CameraRig } from './core/cameraRig';
import {
  clearOfFade,
  evaluate,
  fadeAt,
  loadShotTable,
  shotAt,
  shotProgress,
  ShotTableError,
  type CameraPath,
  type RealmId,
  type Shot,
} from './core/shots';
import { bindControls, formatTime, Timeline } from './core/timeline';
import { buildRealms, type Realm } from './realms/graybox';

const BACKGROUND = 0x05070a;
/** The brief's target length. A different total still plays; the overlay just notes it. */
const TARGET_SECONDS = 90;

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`index.html is missing #${id}`);
  return node;
}

interface Hud {
  readonly canvas: HTMLCanvasElement;
  readonly caption: HTMLElement;
  readonly scrubber: HTMLInputElement;
  readonly playPause: HTMLButtonElement;
  readonly clock: HTMLElement;
  readonly debug: HTMLElement;
}

/** Show a problem instead of a broken scene. */
function stop(hud: Hud, lines: readonly string[]): void {
  console.error(lines.join('\n'));
  hud.caption.textContent = lines[0] ?? 'Something went wrong.';
  hud.debug.hidden = false;
  hud.debug.classList.add('problems');
  hud.debug.textContent = lines.join('\n');
  hud.playPause.disabled = true;
  hud.scrubber.disabled = true;
}

function realmsInShot(path: CameraPath, shot: Shot): RealmId[] {
  const seen: RealmId[] = [evaluate(path, shot.start).realm];
  for (const key of shot.keys) if (seen[seen.length - 1] !== key.realm) seen.push(key.realm);
  return seen;
}

function boot(): void {
  const hud: Hud = {
    canvas: byId('stage', HTMLCanvasElement),
    caption: byId('caption', HTMLElement),
    scrubber: byId('scrubber', HTMLInputElement),
    playPause: byId('playpause', HTMLButtonElement),
    clock: byId('clock', HTMLElement),
    debug: byId('debug', HTMLElement),
  };
  const params = new URLSearchParams(window.location.search);
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = motionQuery.matches;
  motionQuery.addEventListener('change', (event) => {
    reducedMotion = event.matches;
  });

  let shots: Shot[];
  let path: CameraPath;
  try {
    ({ shots, path } = loadShotTable());
  } catch (error) {
    if (error instanceof ShotTableError) stop(hud, ['The shot table has errors. Fix shots.json:', ...error.problems]);
    else stop(hud, ['Could not load the shot table.', String(error)]);
    return;
  }

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas: hud.canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (error) {
    stop(hud, ['This experience needs WebGL2, and this browser could not start it.', String(error)]);
    return;
  }

  // Scene, lights and the eight realms (one visible at a time).
  const scene = new Scene();
  scene.background = new Color(BACKGROUND);
  const fog = new Fog(BACKGROUND, 10, 100);
  scene.fog = fog;
  scene.add(new HemisphereLight(0xb8c7d9, 0x0b0e12, 1.1));
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.4, 1, 0.6);
  scene.add(sun);
  const realms = buildRealms();
  for (const r of Object.values(realms)) scene.add(r.group);

  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  const rig = new CameraRig(camera, hud.canvas, path);
  const timeline = new Timeline(path.duration);

  let current: Realm | undefined;
  // Compile every realm's materials up front, so the first visit to a realm doesn't hitch.
  const warmUp = (): void => {
    for (const r of Object.values(realms)) r.group.visible = true;
    renderer.compile(scene, camera);
    for (const r of Object.values(realms)) r.group.visible = r === current;
  };
  warmUp();

  // A plain DOM fade hides each realm change until portals arrive in Module 2.
  const fade = document.createElement('div');
  fade.setAttribute('aria-hidden', 'true');
  Object.assign(fade.style, { position: 'fixed', inset: '0', background: '#05070a', opacity: '0', pointerEvents: 'none' });
  hud.canvas.after(fade);

  /** True while the browser has taken the page's graphics away (see the handlers below). */
  let contextLost = false;
  let debugOn = params.has('debug');
  hud.debug.hidden = !debugOn;
  const controls = bindControls(
    timeline,
    { scrubber: hud.scrubber, playPause: hud.playPause, clock: hud.clock, surface: hud.canvas },
    {
      // A shot that starts on a realm change is entered just after its fade, not on a black frame.
      shotStarts: shots.map((s) => clearOfFade(path, s.start)),
      onKey: (event) => {
        if (event.key !== 'd' && event.key !== 'D') return false;
        if (!event.repeat) {
          debugOn = !debugOn;
          hud.debug.hidden = !debugOn;
        }
        return true;
      },
    },
  );
  timeline.on((event) => {
    if (event.type === 'seek') rig.snapToPath();
    // Nothing may start playback over a dead canvas (a pending autoplay, for one).
    if (event.type === 'play' && contextLost) timeline.pause();
  });

  // Checked at the start of every frame, before anything is drawn, so a resize
  // never shows a cleared canvas and a move to a screen with a different pixel
  // density is picked up too.
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  let shownWidth = 0;
  let shownHeight = 0;
  let shownRatio = 0;
  const fitCanvas = (): void => {
    const width = Math.max(1, hud.canvas.clientWidth);
    const height = Math.max(1, hud.canvas.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, coarsePointer ? 1.5 : 2);
    if (width === shownWidth && height === shownHeight && ratio === shownRatio) return;
    shownWidth = width;
    shownHeight = height;
    shownRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  fitCanvas();

  const enter = (id: RealmId): Realm => {
    const next = realms[id];
    if (current !== next) {
      if (current) current.group.visible = false;
      next.group.visible = true;
      camera.near = next.info.near;
      camera.far = next.info.far;
      camera.updateProjectionMatrix();
      fog.near = next.info.fogNear;
      fog.far = next.info.fogFar;
      current = next;
    }
    return next;
  };

  // If the GPU drops the page's graphics, pause and wait for the browser to
  // hand them back (three.js rebuilds its state), then pick up where we were.
  let refocus: HTMLElement | null = null;
  hud.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    const active = document.activeElement;
    refocus = active === hud.playPause ? hud.playPause : active === hud.scrubber ? hud.scrubber : null;
    controls.setDisabled(true);
    timeline.pause();
    hud.caption.textContent = 'The graphics stopped. Waiting for the browser to restore them; if nothing changes, reload the page.';
  });
  hud.canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    warmUp();
    controls.setDisabled(false);
    // Disabling the controls dropped keyboard focus; put it back where it was.
    if (refocus && (document.activeElement === null || document.activeElement === document.body)) refocus.focus();
    refocus = null;
    shownShot = 0;
  });

  const totalNote =
    Math.abs(path.duration - TARGET_SECONDS) > 1e-6 ? `note: shots add up to ${path.duration} s, not ${TARGET_SECONDS} s` : '';
  const autoplay = params.get('autoplay') !== '0' && !reducedMotion;

  let last = performance.now();
  let fps = 60;
  let lastDebug = 0;
  let shownShot = 0;
  let shownFade = '';

  renderer.setAnimationLoop((now: number) => {
    fitCanvas();
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    timeline.advance(dt);

    const t = timeline.t;
    const shot = shotAt(shots, t);
    const progress = shotProgress(shot, t);
    const pose = rig.update(t, timeline.playing, dt);
    enter(pose.realm).update({ t, shot, progress, reducedMotion });

    const fadeOpacity = fadeAt(path, t).toFixed(3);
    if (fadeOpacity !== shownFade) {
      fade.style.opacity = fadeOpacity;
      shownFade = fadeOpacity;
    }
    if (shot.id !== shownShot && !contextLost) {
      hud.caption.textContent = shot.caption;
      shownShot = shot.id;
    }
    controls.sync();
    if (!contextLost) renderer.render(scene, camera);

    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    if (debugOn && now - lastDebug > 200 && current) {
      lastDebug = now;
      const p = camera.position;
      const info = current.info;
      const lines = [
        `t ${formatTime(t)} (${t.toFixed(2)} s) of ${formatTime(path.duration)}   shot ${shot.id}/${shots.length} ${shot.label}  ${Math.round(progress * 100)}%`,
        `realm ${info.id} ${info.name} (${info.unit})   this shot: ${realmsInShot(path, shot).join(' → ')}`,
        `camera (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) looking at (${pose.target.map((v) => v.toFixed(2)).join(', ')})   rig ${rig.mode}`,
        `fps ${Math.round(fps)}   draw calls ${renderer.info.render.calls}   triangles ${(renderer.info.render.triangles / 1000).toFixed(1)}k   pixel ratio ${renderer.getPixelRatio()}`,
        `autoplay ${autoplay ? 'on' : 'off'}   reduced motion ${reducedMotion ? 'on' : 'off'}   claims ${shot.claims.join(', ')}`,
        'gray-box: every shape, count and height is a placeholder, not data',
        'realm changes fade through black until portals arrive in Module 2',
        'keys: space play/pause   ←/→ 1 s (shift 5 s)   [ ] shot   home/end   d debug',
      ];
      if (totalNote) lines.push(totalNote);
      hud.debug.textContent = lines.join('\n');
    }
  });

  const startAt = Number(params.get('t'));
  if (Number.isFinite(startAt) && startAt > 0) timeline.seek(clearOfFade(path, startAt), 'url');
  if (autoplay) {
    // Let the first frame land before the clock starts, so 0:00 is really seen.
    requestAnimationFrame(() => requestAnimationFrame(() => timeline.play()));
  }

  if (debugOn) {
    // A read-mostly handle for automated checks; only present with ?debug.
    Object.assign(window, {
      __oneMessage: {
        timeline,
        shots,
        path,
        pose: (time: number) => evaluate(path, time),
        fade: (time: number) => fadeAt(path, time),
        realm: () => current?.info.id,
        camera: () => camera.position.toArray(),
        rigMode: () => rig.mode,
      },
    });
  }
}

boot();
