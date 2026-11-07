import type { CityRenderer } from '../render/city';
import type { Simulation } from '../sim/engine';

/**
 * HTML labels pinned to 3D anchors. Updated directly every frame (no React) so 25 labels
 * cost nothing. Each label is a real button: tapping it selects the asset.
 */
export class LabelLayer {
  private els = new Map<string, HTMLButtonElement>();
  private tmp = { x: 0, y: 0, visible: false };
  constructor(root: HTMLElement, private city: CityRenderer, onSelect: (id: string) => void) {
    for (const a of city.anchors) {
      if (a.kind === 'line') continue;
      if (a.kind === 'zone' && !['Z03', 'Z05', 'Z06', 'Z08', 'Z09', 'Z02'].includes(a.id)) continue;
      const el = document.createElement('button');
      el.className = `label ${a.kind}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(a.id);
      });
      root.appendChild(el);
      this.els.set(a.id, el);
    }
  }

  update(sim: Simulation | null, selected: string | null, show: boolean) {
    const s = sim?.state;
    for (const a of this.city.anchors) {
      const el = this.els.get(a.id);
      if (!el) continue;
      this.city.project(a.pos, this.tmp);
      if (!show || !this.tmp.visible) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${this.tmp.x}px, ${this.tmp.y}px) translate(-50%, -100%)`;
      let text = a.id;
      let cls = 'ok';
      if (s && sim) {
        if (a.kind === 'sub') {
          const t = s.subs[a.id];
          text = `${a.id} ${t.damaged ? 'DESTROYED' : t.tripped ? 'TRIPPED' : !t.closed ? 'OFF' : `${Math.round(t.measured * 100)}%`}`;
          cls = t.damaged || t.tripped || !t.closed || !t.energised ? 'dead' : t.temp > 120 || t.measured > 1 ? 'crit' : t.temp > 105 || t.measured > 0.9 ? 'warn' : 'ok';
        } else if (a.kind === 'gen') {
          const g = s.gens[a.id];
          text = `${sim.label(a.id)} ${g.online ? `${Math.round(g.pe)} MW` : 'TRIPPED'}`;
          cls = g.online ? 'ok' : 'dead';
        } else {
          const z = s.zones[a.id];
          const d = sim.zoneDef(a.id);
          const name = d.critical?.name.replace(' (112 call routing)', '') ?? d.name;
          text = name;
          cls = d.critical ? (!z.criticalUp ? 'crit' : !z.served || z.criticalDegraded ? 'warn' : 'ok') : z.served ? 'ok' : 'dead';
        }
      } else {
        text = a.kind === 'gen' || a.kind === 'zone' ? (sim?.label(a.id) ?? a.id) : a.id;
      }
      if (el.textContent !== text) el.textContent = text;
      const c = `label ${a.kind} ${cls}${selected === a.id ? ' sel' : ''}`;
      if (el.className !== c) el.className = c;
    }
  }

  dispose() {
    for (const el of this.els.values()) el.remove();
  }
}
