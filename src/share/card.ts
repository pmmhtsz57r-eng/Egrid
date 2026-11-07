import type { Outcome } from '../scoring/score';

export interface CardData {
  name: string;
  outcome: Outcome;
  seed: number;
  mode: 'crisis' | 'daily';
  timeline: { t: number; freq: number; served: number }[];
  url: string;
}

export const CARD_W = 1080;
export const CARD_H = 1350;

const GRADE_COLOR: Record<string, string> = { S: '#3dffa0', A: '#38e8ff', B: '#8fd3ff', C: '#ffb020', D: '#ff7a30', F: '#ff3045' };

/** Draws the shareable incident report card. Pure Canvas 2D: works offline, no server. */
export async function drawCard(canvas: HTMLCanvasElement, d: CardData) {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const g = canvas.getContext('2d')!;
  try {
    await document.fonts?.ready;
  } catch {
    /* fonts are optional */
  }
  const o = d.outcome;
  const accent = GRADE_COLOR[o.grade] ?? '#38e8ff';
  const display = '"Space Grotesk", "Segoe UI", system-ui, sans-serif';
  const mono = '"JetBrains Mono", ui-monospace, Menlo, monospace';

  // background
  const bg = g.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, '#04060c');
  bg.addColorStop(0.6, '#070c18');
  bg.addColorStop(1, '#0b0f1c');
  g.fillStyle = bg;
  g.fillRect(0, 0, CARD_W, CARD_H);
  // glow
  const glow = g.createRadialGradient(CARD_W / 2, 1050, 50, CARD_W / 2, 1050, 700);
  glow.addColorStop(0, hexA(accent, 0.22));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, CARD_W, CARD_H);
  // scanlines
  g.fillStyle = 'rgba(255,255,255,0.018)';
  for (let y = 0; y < CARD_H; y += 4) g.fillRect(0, y, CARD_W, 1);

  // skyline, lit in proportion to people kept powered
  drawSkyline(g, o.peoplePoweredPct, accent);

  const pad = 80;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.font = `700 132px ${display}`;
  g.letterSpacing = '18px';
  g.fillText('BLACKOUT', pad - 6, 200);
  g.letterSpacing = '0px';
  g.fillStyle = accent;
  g.fillRect(pad, 232, 120, 6);
  g.fillStyle = '#9fb0cc';
  g.font = `600 34px ${mono}`;
  g.fillText('NOVA CITY INCIDENT REPORT', pad, 292);
  g.fillStyle = '#5d6c88';
  g.font = `500 26px ${mono}`;
  g.fillText(`${d.mode === 'daily' ? 'DAILY STORM' : 'STORM'} #${d.seed}  ·  90 SECONDS`, pad, 334);

  // operator
  g.fillStyle = '#5d6c88';
  g.font = `500 26px ${mono}`;
  g.fillText('OPERATOR', pad, 410);
  g.fillStyle = '#ffffff';
  g.font = `700 52px ${display}`;
  g.fillText(truncate(g, d.name.toUpperCase() || 'ANONYMOUS', CARD_W - pad * 2), pad, 466);

  // big stability + grade
  g.fillStyle = '#5d6c88';
  g.font = `500 26px ${mono}`;
  g.fillText('CITY STABILITY', pad, 552);
  g.fillStyle = accent;
  g.font = `700 190px ${display}`;
  g.fillText(`${o.stability}%`, pad - 8, 720);
  // grade badge
  const bx = CARD_W - pad - 230;
  g.strokeStyle = accent;
  g.lineWidth = 5;
  roundRect(g, bx, 560, 230, 180, 22);
  g.stroke();
  g.fillStyle = hexA(accent, 0.12);
  g.fill();
  g.fillStyle = accent;
  g.font = `700 140px ${display}`;
  g.textAlign = 'center';
  g.fillText(o.grade, bx + 115, 702);
  g.textAlign = 'left';
  g.fillStyle = '#ffffff';
  g.font = `700 40px ${display}`;
  g.fillText(o.title, pad, 790);

  // stats rows
  const rows: [string, string][] = [
    ['PEOPLE KEPT POWERED', `${o.peoplePowered.toLocaleString('en-GB')} / 250,000`],
    ['CRITICAL SERVICES PROTECTED', `${o.criticalProtected} / ${o.critical.length}`],
    ['INFRASTRUCTURE LOST', o.infrastructureLost.length ? String(o.infrastructureLost.length) : 'NONE'],
    ['FINAL RATING', `${o.grade} · ${o.title}`],
  ];
  let y = 860;
  for (const [k, v] of rows) {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(pad, y + 18, CARD_W - pad * 2, 2);
    g.fillStyle = '#7f8faa';
    g.font = `500 26px ${mono}`;
    g.fillText(k, pad, y);
    g.fillStyle = '#ffffff';
    g.font = `700 30px ${mono}`;
    g.textAlign = 'right';
    g.fillText(truncate(g, v, 460), CARD_W - pad, y);
    g.textAlign = 'left';
    y += 62;
  }

  // frequency trace
  drawTrace(g, d.timeline, pad, 1105, CARD_W - pad * 2, 60, accent);

  g.fillStyle = '#ffffff';
  g.font = `700 46px ${display}`;
  g.textAlign = 'center';
  g.fillText('“Would you have done better?”', CARD_W / 2, 1240);
  g.fillStyle = '#5d6c88';
  g.font = `500 22px ${mono}`;
  g.fillText('Same storm. Your decisions.  ' + shortUrl(d.url), CARD_W / 2, 1284);
  g.fillStyle = '#3e4a60';
  g.font = `500 18px ${mono}`;
  g.fillText('FICTIONAL SIMULATION · NO REAL CITY, PEOPLE OR EVENTS · NOT AN ENGINEERING TOOL', CARD_W / 2, 1320);
  g.textAlign = 'left';
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.host + x.pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function drawSkyline(g: CanvasRenderingContext2D, powered: number, accent: string) {
  let s = 12345;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const base = 1350;
  let x = -10;
  g.save();
  g.globalAlpha = 0.32;
  while (x < CARD_W + 10) {
    const w = 30 + r() * 60;
    const h = 40 + r() * r() * 170;
    g.fillStyle = '#0a1020';
    g.fillRect(x, base - h, w, h);
    for (let wy = base - h + 10; wy < base - 8; wy += 14) {
      for (let wx = x + 6; wx < x + w - 6; wx += 10) {
        const lit = r() < powered * 0.55;
        g.fillStyle = lit ? 'rgba(255,200,120,0.85)' : 'rgba(40,52,76,0.6)';
        g.fillRect(wx, wy, 4, 6);
      }
    }
    x += w + 2;
  }
  g.restore();
  g.fillStyle = hexA(accent, 0.05);
  g.fillRect(0, base - 210, CARD_W, 210);
}

function drawTrace(g: CanvasRenderingContext2D, tl: { t: number; freq: number }[], x: number, y: number, w: number, h: number, accent: string) {
  g.fillStyle = '#5d6c88';
  g.font = '500 20px "JetBrains Mono", monospace';
  g.fillText('GRID FREQUENCY  0:00 → 1:30', x, y - 12);
  g.strokeStyle = 'rgba(255,255,255,0.1)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y + h / 2);
  g.lineTo(x + w, y + h / 2);
  g.stroke();
  if (!tl.length) return;
  g.strokeStyle = accent;
  g.lineWidth = 3;
  g.beginPath();
  tl.forEach((p, i) => {
    const px = x + (p.t / 90) * w;
    const f = p.freq <= 0 ? 47.5 : p.freq;
    const py = y + h / 2 - Math.max(-1, Math.min(1, (f - 50) / 1.5)) * (h / 2);
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
  g.stroke();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function truncate(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function cardBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not create image'))), 'image/png'));
}

export async function downloadCard(canvas: HTMLCanvasElement, filename: string) {
  const blob = await cardBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Native share sheet with the image where supported. Returns false if not supported. */
export async function shareCard(canvas: HTMLCanvasElement, text: string, url: string): Promise<boolean> {
  const blob = await cardBlob(canvas);
  const file = new File([blob], 'blackout-nova-city.png', { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], text: `${text} ${url}`, title: 'BLACKOUT: Nova City incident report' });
    return true;
  }
  if (nav.share) {
    await nav.share({ text, url, title: 'BLACKOUT: Nova City incident report' });
    return true;
  }
  return false;
}
