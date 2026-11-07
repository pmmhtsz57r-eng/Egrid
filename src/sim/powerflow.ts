/**
 * DC power flow on one electrical island.
 *
 * The DC approximation assumes flat voltage magnitudes, small angle differences and lossless
 * lines, so the flow on line i-j is (θi - θj) / x. It is the standard simplification used for
 * contingency screening; it is NOT an AC load flow and ignores reactive power and losses.
 */

export interface FlowLine {
  index: number;
  from: number;
  to: number;
  x: number;
}

/**
 * Solves B·θ = P with bus 0 as the angle reference and returns the flow on each line (MW,
 * positive from → to). `injection` is in MW and must sum to zero over the island.
 */
export function dcFlow(busCount: number, lines: FlowLine[], injection: number[]): number[] {
  const flows = new Array<number>(lines.length).fill(0);
  if (busCount <= 1 || lines.length === 0) return flows;
  const n = busCount - 1;
  // B matrix without the reference row/column, per unit on a 100 MVA base.
  const B: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const l of lines) {
    const b = 1 / l.x;
    const i = l.from - 1;
    const j = l.to - 1;
    if (i >= 0) B[i][i] += b;
    if (j >= 0) B[j][j] += b;
    if (i >= 0 && j >= 0) {
      B[i][j] -= b;
      B[j][i] -= b;
    }
  }
  const P = injection.slice(1).map((p) => p / 100);
  const theta = [0, ...solve(B, P)];
  return lines.map((l) => ((theta[l.from] - theta[l.to]) / l.x) * 100);
}

/** Gaussian elimination with partial pivoting. Deterministic: fixed operation order. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) continue;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    if (Math.abs(M[r][r]) < 1e-12) continue;
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Connected components of an undirected graph given as edges between indices. */
export function components(count: number, edges: [number, number][]): number[] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  return parent.map((_, i) => find(i));
}
