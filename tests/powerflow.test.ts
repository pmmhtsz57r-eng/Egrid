import { describe, expect, it } from 'vitest';
import { components, dcFlow, solve } from '../src/sim/powerflow';

describe('DC power flow', () => {
  it('splits flow between parallel paths in inverse proportion to reactance', () => {
    // bus 0 injects 100 MW, bus 1 consumes it; two lines with x = 0.1 and 0.3
    const f = dcFlow(2, [{ index: 0, from: 0, to: 1, x: 0.1 }, { index: 1, from: 0, to: 1, x: 0.3 }], [100, -100]);
    expect(f[0]).toBeCloseTo(75, 6);
    expect(f[1]).toBeCloseTo(25, 6);
  });

  it('conserves power at every bus of a meshed network', () => {
    const lines = [
      { index: 0, from: 0, to: 1, x: 0.05 }, { index: 1, from: 1, to: 2, x: 0.08 },
      { index: 2, from: 0, to: 2, x: 0.06 }, { index: 3, from: 2, to: 3, x: 0.04 }, { index: 4, from: 1, to: 3, x: 0.07 },
    ];
    const inj = [120, -30, -40, -50];
    const f = dcFlow(4, lines, inj);
    for (let b = 0; b < 4; b++) {
      const net = lines.reduce((a, l, i) => a + (l.from === b ? f[i] : 0) - (l.to === b ? f[i] : 0), 0);
      expect(net).toBeCloseTo(inj[b], 6);
    }
  });

  it('solves a linear system exactly', () => {
    expect(solve([[2, 1], [1, 3]], [3, 5]).map((v) => Number(v.toFixed(9)))).toEqual([0.8, 1.4]);
  });

  it('finds islands', () => {
    const c = components(5, [[0, 1], [3, 4]]);
    expect(c[0]).toBe(c[1]);
    expect(c[3]).toBe(c[4]);
    expect(c[2]).not.toBe(c[0]);
    expect(c[3]).not.toBe(c[0]);
  });
});
