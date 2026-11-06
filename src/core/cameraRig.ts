/**
 * Puts the camera on the path for the current time.
 *
 * While paused, the viewer can drag to orbit around whatever the camera was
 * looking at. When playback resumes, the camera glides back onto the path in
 * RETURN_SECONDS instead of cutting. A seek always snaps straight back to the
 * path. Zoom and pan stay off, because the wheel scrubs time.
 */
import { MathUtils, Spherical, TOUCH, Vector3, type PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { evaluate, type CameraPath, type Pose, type RealmId, type Vec3 } from './shots';

export type RigMode = 'path' | 'orbit' | 'return';

/** Seconds the camera takes to glide from an orbit back onto the path. */
export const RETURN_SECONDS = 0.6;

/** The same angle brought into -π..π. */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

export class CameraRig {
  readonly controls: OrbitControls;
  private readonly camera: PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly path: CameraPath;
  private current: RigMode = 'path';
  /** True between OrbitControls' 'start' and 'end': a drag is in progress. */
  private gesture = false;
  /** Pointers that went down on the scene while orbiting was allowed; only these may steer. */
  private readonly steering = new Set<number>();
  /** The realm of the last paused frame, which is the realm an orbit happens in. */
  private shownRealm: RealmId = 'R0';
  private readonly fromTarget = new Vector3();
  private readonly fromOffset = new Spherical();
  private fromRealm: RealmId = 'R0';
  private returnElapsed = 0;
  /** How far round the glide turns the camera, and the path's azimuth when last measured. */
  private glideTurn = Number.NaN;
  private lastPathTheta = 0;
  private readonly toTarget = new Vector3();
  private readonly toOffset = new Spherical();
  private readonly blend = new Vector3();
  private readonly offset = new Vector3();
  private readonly listeners: Array<() => void> = [];

  constructor(camera: PerspectiveCamera, dom: HTMLElement, path: CameraPath) {
    this.camera = camera;
    this.dom = dom;
    this.path = path;
    const controls = new OrbitControls(camera, dom);
    controls.enabled = false;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    // Two fingers orbit around their midpoint. The default (pinch and pan) is
    // switched off here, and would leave the second finger making the view jump.
    controls.touches.TWO = TOUCH.DOLLY_ROTATE;
    controls.addEventListener('start', () => {
      this.gesture = true;
      if (controls.enabled) this.current = 'orbit';
    });
    controls.addEventListener('end', () => {
      this.gesture = false;
    });
    this.controls = controls;

    // OrbitControls steers by any pointer that moves, even one it never saw go
    // down: a finger put down during playback, or one held through a seek.
    // Keep such pointers' moves away from it while an orbit is in progress.
    const listen = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, handler: (event: WindowEventMap[K]) => void): void => {
      const options = { capture: true };
      target.addEventListener(type, handler as EventListener, options);
      this.listeners.push(() => target.removeEventListener(type, handler as EventListener, options));
    };
    listen(dom, 'pointerdown', (event) => {
      if (controls.enabled) this.steering.add(event.pointerId);
    });
    const forget = (event: PointerEvent): void => {
      this.steering.delete(event.pointerId);
    };
    listen(window, 'pointerup', forget);
    listen(window, 'pointercancel', forget);
    listen(window, 'pointermove', (event) => {
      if (this.gesture && !this.steering.has(event.pointerId)) event.stopPropagation();
    });
  }

  get mode(): RigMode {
    return this.current;
  }

  /** Drop any orbit and follow the path again. Call on every seek. */
  snapToPath(): void {
    if (this.current === 'orbit' || this.gesture) this.releaseOrbit();
    this.current = 'path';
  }

  /** Place the camera for time t. Returns the path pose (its realm is the one to show). */
  update(t: number, playing: boolean, dt: number): Pose {
    const pose = evaluate(this.path, t);
    const controls = this.controls;

    if (!playing) {
      this.shownRealm = pose.realm;
      if (this.current === 'return') {
        // Paused mid-glide: stay where the camera is, as if the viewer had
        // orbited there, rather than cutting to the path.
        controls.target.copy(this.blend);
        controls.enabled = true;
        this.current = 'orbit';
      }
      if (this.current === 'orbit') {
        controls.update();
        return pose;
      }
      this.place(pose.pos, pose.target);
      controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
      controls.enabled = true;
      return pose;
    }

    if (controls.enabled) {
      controls.enabled = false;
      if (this.current === 'orbit') {
        // Start the glide from what is on screen now, then stop the orbit for good.
        this.current = 'return';
        this.returnElapsed = 0;
        this.glideTurn = Number.NaN;
        this.fromTarget.copy(controls.target);
        this.fromOffset.setFromVector3(this.offset.subVectors(this.camera.position, controls.target));
        this.fromRealm = this.shownRealm;
        this.releaseOrbit();
      }
    }

    if (this.current === 'return') {
      if (pose.realm !== this.fromRealm) {
        // The path is in another realm now; the orbit's pose means nothing here.
        this.current = 'path';
      } else {
        this.returnElapsed += dt;
        const u = MathUtils.smootherstep(this.returnElapsed / RETURN_SECONDS, 0, 1);
        // Glide around the target, not along a straight line: after a large
        // orbit the straight line runs through the very thing being filmed.
        this.toTarget.set(pose.target[0], pose.target[1], pose.target[2]);
        this.toOffset.setFromVector3(this.offset.set(pose.pos[0] - pose.target[0], pose.pos[1] - pose.target[1], pose.pos[2] - pose.target[2]));
        const from = this.fromOffset;
        const to = this.toOffset;
        // Pick the way round once, the shorter one, then follow the path's own
        // turning. Re-picking every frame would flip to the other side of the
        // subject whenever the path carried the difference past half a turn.
        if (Number.isNaN(this.glideTurn)) this.glideTurn = wrapAngle(to.theta - from.theta);
        else this.glideTurn += wrapAngle(to.theta - this.lastPathTheta);
        this.lastPathTheta = to.theta;
        this.offset.setFromSphericalCoords(
          MathUtils.lerp(from.radius, to.radius, u),
          MathUtils.lerp(from.phi, to.phi, u),
          from.theta + this.glideTurn * u,
        );
        this.blend.lerpVectors(this.fromTarget, this.toTarget, u);
        this.camera.position.copy(this.blend).add(this.offset);
        this.camera.lookAt(this.blend);
        if (u >= 1) this.current = 'path';
        return pose;
      }
    }

    this.place(pose.pos, pose.target);
    return pose;
  }

  dispose(): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.controls.dispose();
  }

  /**
   * End any drag in progress and throw away the orbit OrbitControls still has
   * queued. Damping keeps a flick turning for a second after release; left
   * alone, that rotation would replay the moment the viewer next grabs the
   * scene. The caller puts the camera where it belongs afterwards.
   */
  private releaseOrbit(): void {
    const controls = this.controls;
    if (this.gesture) {
      // Reconnecting drops the pointers, so moves made after this one don't pile up unseen.
      controls.connect(this.dom);
      this.gesture = false;
    }
    this.steering.clear();
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
  }

  private place(pos: Vec3, target: Vec3): void {
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.camera.lookAt(target[0], target[1], target[2]);
  }
}
