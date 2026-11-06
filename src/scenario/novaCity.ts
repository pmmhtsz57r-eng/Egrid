import type { NetworkDef } from '../sim/types';

/**
 * NOVA CITY: a fictional European city of 250,000 people.
 * All names, figures and facilities are invented for the game.
 *
 * Map units are metres / 10 (the map is about 2.6 km across). North is -z.
 *
 *            G2 Nordwind (wind)
 *                 |
 *        S02 Nordtor ---- S03 Bahnhof
 *        /    |               |      \
 * G1 - S01   S05 Zentrum ---- +       S07 Flussufer - G3 Talsperre (hydro)
 *        \    |      \                 /
 *        S04 Westpark  S06 Südstadt - S08 Ostend - G3
 */
export const NOVA_CITY: NetworkDef = {
  name: 'Nova City',
  population: 250_000,
  depot: [5, 12],
  buses: [
    { id: 'G1', pos: [-118, 18] },
    { id: 'G2', pos: [-38, -122] },
    { id: 'G3', pos: [122, 22] },
    { id: 'S01', pos: [-62, 0] },
    { id: 'S02', pos: [-24, -56] },
    { id: 'S03', pos: [38, -52] },
    { id: 'S04', pos: [-56, 56] },
    { id: 'S05', pos: [2, 2] },
    { id: 'S06', pos: [16, 58] },
    { id: 'S07', pos: [66, -6] },
    { id: 'S08', pos: [70, 54] },
  ],
  generators: [
    {
      id: 'G1', name: 'Harbour Gas Station', short: 'Harbour Gas', kind: 'gas', bus: 'G1',
      capacity: 190, min: 70, emergencyRating: 1.1, overloadSeconds: 25, ramp: 3,
      inertiaH: 5, droopLimit: 0.08, initial: 150, pos: [-118, 18],
    },
    {
      id: 'G2', name: 'Nordwind Wind Farm', short: 'Nordwind', kind: 'wind', bus: 'G2',
      capacity: 110, min: 0, emergencyRating: 1, overloadSeconds: 0, ramp: 20,
      inertiaH: 0.1, droopLimit: 0, initial: 90, pos: [-38, -122],
    },
    {
      id: 'G3', name: 'Talsperre Hydro Dam', short: 'Talsperre', kind: 'hydro', bus: 'G3',
      capacity: 80, min: 10, emergencyRating: 1, overloadSeconds: 0, ramp: 8,
      inertiaH: 3, droopLimit: 0.12, initial: 50, pos: [122, 22],
    },
  ],
  lines: [
    { id: 'L1', name: 'Harbour – Altstadt', from: 'G1', to: 'S01', x: 0.04, limit: 150 },
    { id: 'L2', name: 'Harbour – Westpark', from: 'G1', to: 'S04', x: 0.05, limit: 105 },
    { id: 'L3', name: 'Nordwind – Nordtor', from: 'G2', to: 'S02', x: 0.06, limit: 115 },
    { id: 'L4', name: 'Talsperre – Flussufer', from: 'G3', to: 'S07', x: 0.05, limit: 60 },
    { id: 'L5', name: 'Talsperre – Ostend', from: 'G3', to: 'S08', x: 0.05, limit: 55 },
    { id: 'L6', name: 'Altstadt – Nordtor', from: 'S01', to: 'S02', x: 0.05, limit: 34 },
    { id: 'L7', name: 'Nordtor – Bahnhof', from: 'S02', to: 'S03', x: 0.06, limit: 47 },
    { id: 'L8', name: 'Bahnhof – Flussufer', from: 'S03', to: 'S07', x: 0.06, limit: 42 },
    { id: 'L9', name: 'Altstadt – Zentrum', from: 'S01', to: 'S05', x: 0.05, limit: 37 },
    { id: 'L10', name: 'Zentrum – Bahnhof', from: 'S05', to: 'S03', x: 0.06, limit: 42 },
    { id: 'L11', name: 'Zentrum – Südstadt', from: 'S05', to: 'S06', x: 0.05, limit: 37 },
    { id: 'L12', name: 'Westpark – Südstadt', from: 'S04', to: 'S06', x: 0.06, limit: 35 },
    { id: 'L13', name: 'Südstadt – Ostend', from: 'S06', to: 'S08', x: 0.06, limit: 37 },
    { id: 'L14', name: 'Flussufer – Ostend', from: 'S07', to: 'S08', x: 0.06, limit: 37 },
    { id: 'L15', name: 'Altstadt – Westpark', from: 'S01', to: 'S04', x: 0.05, limit: 42 },
  ],
  substations: [
    { id: 'S01', name: 'Altstadt', rating: 80, pos: [-62, 0] },
    { id: 'S02', name: 'Nordtor', rating: 62, pos: [-24, -56] },
    { id: 'S03', name: 'Bahnhof', rating: 48, pos: [38, -52] },
    { id: 'S04', name: 'Westpark', rating: 70, pos: [-56, 56] },
    { id: 'S05', name: 'Zentrum', rating: 48, pos: [2, 2] },
    { id: 'S06', name: 'Südstadt', rating: 64, pos: [16, 58] },
    { id: 'S07', name: 'Flussufer', rating: 50, pos: [66, -6] },
    { id: 'S08', name: 'Ostend', rating: 46, pos: [70, 54] },
  ],
  zones: [
    { id: 'Z01', name: 'Altstadt', kind: 'residential', primary: 'S01', alternate: 'S02', load: 22, population: 33_000, uflsStage: 2, pos: [-78, -22], size: [34, 26] },
    { id: 'Z02', name: 'Hafen Industrial', kind: 'industrial', primary: 'S01', load: 40, population: 2_000, uflsStage: 0, processMinimum: 9, pos: [-92, 28], size: [30, 30] },
    {
      id: 'Z03', name: 'Central Hospital', kind: 'hospital', primary: 'S02', alternate: 'S01', load: 18, population: 14_000, uflsStage: 0,
      critical: { id: 'H1', name: 'Central Hospital', load: 6, dependants: 640, backup: { capacity: 6, startDelay: 8, autoStart: true, ups: 12 } },
      pos: [-48, -40], size: [24, 22],
    },
    { id: 'Z04', name: 'Nordviertel', kind: 'residential', primary: 'S02', alternate: 'S05', load: 24, population: 30_000, uflsStage: 3, pos: [-10, -80], size: [36, 24] },
    {
      id: 'Z05', name: 'Central Station & Rail R02', kind: 'rail', primary: 'S03', alternate: 'S06', load: 20, population: 0, uflsStage: 3,
      critical: { id: 'R02', name: 'Railway Network R02', load: 14, dependants: 11_500, minVoltage: 0.95 },
      pos: [40, -76], size: [40, 14],
    },
    {
      id: 'Z06', name: 'Kern Data Centre', kind: 'datacentre', primary: 'S04', load: 30, population: 0, uflsStage: 0,
      critical: { id: 'DC', name: 'Data Centre (112 call routing)', load: 30, dependants: 250_000, backup: { capacity: 32, startDelay: 10, autoStart: false, ups: 40 } },
      pos: [-84, 74], size: [22, 18],
    },
    { id: 'Z07', name: 'Westpark', kind: 'residential', primary: 'S04', alternate: 'S05', load: 26, population: 34_000, uflsStage: 1, pos: [-40, 34], size: [32, 28] },
    {
      id: 'Z08', name: 'Emergency Services HQ', kind: 'emergency', primary: 'S05', alternate: 'S03', load: 10, population: 9_000, uflsStage: 0,
      critical: { id: 'ES', name: 'Emergency Services HQ', load: 3, dependants: 420, backup: { capacity: 3, startDelay: 6, autoStart: true, ups: 20 } },
      pos: [18, -18], size: [20, 18],
    },
    {
      id: 'Z09', name: 'St. Aurel Hospital', kind: 'hospital', primary: 'S06', alternate: 'S08', load: 20, population: 24_000, uflsStage: 0,
      critical: { id: 'H2', name: 'St. Aurel Hospital', load: 5, dependants: 480, backup: { capacity: 5, startDelay: 8, autoStart: true, ups: 12 } },
      pos: [36, 78], size: [26, 22],
    },
    { id: 'Z10', name: 'Neustadt', kind: 'residential', primary: 'S06', alternate: 'S07', load: 30, population: 38_000, uflsStage: 2, pos: [-8, 80], size: [36, 26] },
    { id: 'Z11', name: 'Flussufer', kind: 'residential', primary: 'S07', alternate: 'S08', load: 25, population: 32_000, uflsStage: 3, pos: [88, -28], size: [30, 30] },
    { id: 'Z12', name: 'Ostend', kind: 'residential', primary: 'S08', alternate: 'S07', load: 25, population: 34_000, uflsStage: 1, pos: [94, 76], size: [30, 28] },
  ],
};
