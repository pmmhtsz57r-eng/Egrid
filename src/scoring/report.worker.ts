import { createCrisis } from '../scenario/crisis';
import type { TimedAction } from '../sim/types';
import { buildReport } from './report';

self.onmessage = (e: MessageEvent<{ seed: number; actions: TimedAction[] }>) => {
  const { seed, actions } = e.data;
  const report = buildReport(createCrisis(seed), actions);
  (self as unknown as Worker).postMessage(report);
};
