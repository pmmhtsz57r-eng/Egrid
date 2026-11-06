#!/usr/bin/env node
// Checks src/content/shots.json the same way the page does when it starts:
// it loads src/core/shots.ts through Vite (so no extra tools are needed) and
// builds the camera path. Exits 1 and lists the problems if the path is
// broken, so `npm test` and `npm run build` catch what the page would show.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});

let exitCode = 0;
try {
  const { loadShotTable, ShotTableError } = await server.ssrLoadModule('/src/core/shots.ts');
  try {
    const { shots, path } = loadShotTable();
    console.log(`shot-table-check: ${shots.length} shots, ${path.duration} s, ${path.runs.length} realm stays, ${path.swaps.length} realm changes; the path is continuous`);
  } catch (error) {
    if (!(error instanceof ShotTableError)) throw error;
    console.error('shot-table-check: src/content/shots.json has problems:');
    for (const problem of error.problems) console.error(`  - ${problem}`);
    exitCode = 1;
  }
} catch (error) {
  console.error(`shot-table-check: could not load the shot table: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);
