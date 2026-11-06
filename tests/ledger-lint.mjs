#!/usr/bin/env node
// ledger-lint: the gatekeeper for the truth ledger (src/content/ledger.json).
//
// Fails (exit code 1) when:
//   - a claim or an explainable has no truth tag, or a tag that isn't one of
//     Real, Approximated, Simulated, Metaphor
//   - a claim or an explainable has no source
//   - a Real claim or explainable has no citation, or a Simulated or Metaphor
//     one has no on-screen disclosure (an explainable may get these through
//     the claims it cites)
//   - a citation has no title or no https URL, a disclosure has no text, or an
//     artifact has no path (or names a file that isn't there)
//   - the ledger has no "updated" date, or a citation's "checked" date isn't a
//     real YYYY-MM-DD date, is later than "updated", or comes without a
//     "supports" line saying what the page was checked for
//   - an id is malformed or used twice
//   - an on-screen caption in src/content/shots.json cites no claim, cites a
//     claim that doesn't exist, or runs to 12 words or more
//
// Warns (exit code 0) when a citation hasn't been opened and checked yet, or an
// artifact is still planned. --strict turns warnings into failures; use it
// before any public release. Any other option is an error (exit code 2).
//
// --self-test runs the linter against small broken ledgers and fails if any of
// them slips through, so the rules above can't quietly stop working.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABELS = ['Real', 'Approximated', 'Simulated', 'Metaphor'];
export const SOURCE_KINDS = ['citation', 'disclosure', 'artifact'];
/** Captions must be "under 12 words". */
export const MAX_CAPTION_WORDS = 11;
const CLAIM_ID = /^C\d{2,3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/** True for a YYYY-MM-DD string that names a day that exists. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function checkLabel(where, label, fail) {
  if (label === undefined || label === null || label === '') {
    fail(where, `missing truth tag (label); use one of ${LABELS.join(', ')}`);
  } else if (!LABELS.includes(label)) {
    fail(where, `unknown truth tag "${label}"; use one of ${LABELS.join(', ')}`);
  }
}

function isHttpsUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates a sources list and returns the set of source kinds it contains. */
function checkSources(where, sources, { fail, warn, root, updated }) {
  const kinds = new Set();
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(where, 'missing source');
    return kinds;
  }
  sources.forEach((source, i) => {
    const at = `${where} source ${i + 1}`;
    if (!isObject(source)) return fail(at, 'not an object');
    if (!SOURCE_KINDS.includes(source.kind)) {
      return fail(at, `kind must be one of ${SOURCE_KINDS.join(', ')}`);
    }
    if (source.kind === 'citation') {
      if (!nonEmpty(source.title)) fail(at, 'citation has no title');
      if (!isHttpsUrl(source.url)) fail(at, 'citation needs an https URL');
      if (source.checked === undefined) warn(at, `citation not yet opened and checked: ${source.title ?? source.url}`);
      else {
        if (typeof source.checked !== 'string' || !ISO_DATE.test(source.checked)) fail(at, '"checked" must be a YYYY-MM-DD date');
        else if (!isCalendarDate(source.checked)) fail(at, `"checked" is not a real date: ${source.checked}`);
        else if (updated && source.checked > updated) fail(at, `"checked" (${source.checked}) is after the ledger's "updated" date (${updated})`);
        if (!nonEmpty(source.supports)) fail(at, 'a checked citation needs a "supports" line saying what the page confirms');
      }
    } else if (source.kind === 'disclosure') {
      if (!nonEmpty(source.text)) fail(at, 'disclosure has no text (what the screen says)');
    } else if (source.kind === 'artifact') {
      if (!nonEmpty(source.path)) fail(at, 'artifact has no path');
      else if (source.status === 'planned') warn(at, `planned artifact not built yet: ${source.path}`);
      else if (source.status === 'present') {
        if (root && !existsSync(resolve(root, source.path))) fail(at, `artifact not found: ${source.path}`);
      } else fail(at, 'artifact status must be "planned" or "present"');
    }
    kinds.add(source.kind);
  });
  return kinds;
}

/**
 * Lint a ledger (and optionally the shot table's captions).
 * Returns { errors, warnings, counts }; nothing is printed.
 */
export function lint({ ledger, shots, root, strict = false }) {
  const errors = [];
  const warnings = [];
  const fail = (where, message) => errors.push(`${where}: ${message}`);
  const warn = (where, message) => (strict ? errors : warnings).push(`${where}: ${message}`);
  const counts = { claims: 0, explainables: 0, captions: 0, byLabel: Object.fromEntries(LABELS.map((l) => [l, 0])) };

  if (!isObject(ledger)) {
    fail('ledger', 'not a JSON object');
    return { errors, warnings, counts };
  }
  if (!Array.isArray(ledger.claims)) fail('ledger', '"claims" must be a list');
  if (!Array.isArray(ledger.explainables)) fail('ledger', '"explainables" must be a list (it may be empty)');
  let updated;
  if (isCalendarDate(ledger.updated)) updated = ledger.updated;
  else fail('ledger', '"updated" must be a real YYYY-MM-DD date (the day the ledger was last checked)');
  const context = { fail, warn, root, updated };

  const claims = Array.isArray(ledger.claims) ? ledger.claims : [];
  const ids = new Set();
  /** The source kinds behind each claim, so explainables can rest on them. */
  const claimKinds = new Map();
  claims.forEach((claim, i) => {
    const where = isObject(claim) && nonEmpty(claim.id) ? claim.id : `claims[${i}]`;
    if (!isObject(claim)) return fail(where, 'not an object');
    counts.claims++;
    if (!nonEmpty(claim.id) || !CLAIM_ID.test(claim.id)) fail(where, 'id must look like C01');
    else if (ids.has(claim.id)) fail(where, 'duplicate id');
    else ids.add(claim.id);
    if (!nonEmpty(claim.claim)) fail(where, 'missing claim text');
    checkLabel(where, claim.label, fail);
    if (LABELS.includes(claim.label)) counts.byLabel[claim.label]++;
    const kinds = checkSources(where, claim.sources, context);
    if (nonEmpty(claim.id)) claimKinds.set(claim.id, kinds);
    if (claim.label === 'Real' && Array.isArray(claim.sources) && claim.sources.length > 0 && !kinds.has('citation')) {
      fail(where, 'a Real claim needs at least one citation');
    }
    if ((claim.label === 'Simulated' || claim.label === 'Metaphor') && Array.isArray(claim.sources) && claim.sources.length > 0 && !kinds.has('disclosure')) {
      fail(where, `a ${claim.label} claim needs an on-screen disclosure`);
    }
  });

  const explainables = Array.isArray(ledger.explainables) ? ledger.explainables : [];
  const explainableIds = new Set();
  explainables.forEach((item, i) => {
    const where = isObject(item) && nonEmpty(item.id) ? `explainable ${item.id}` : `explainables[${i}]`;
    if (!isObject(item)) return fail(where, 'not an object');
    counts.explainables++;
    if (!nonEmpty(item.id)) fail(where, 'missing id');
    else if (explainableIds.has(item.id)) fail(where, 'duplicate id');
    else explainableIds.add(item.id);
    if (!nonEmpty(item.title)) fail(where, 'missing title');
    checkLabel(where, item.label, fail);
    const hasSources = Array.isArray(item.sources) && item.sources.length > 0;
    const hasClaims = Array.isArray(item.claims) && item.claims.length > 0;
    if (!hasSources && !hasClaims) fail(where, 'missing source (give "sources" or the "claims" it rests on)');
    const kinds = hasSources ? checkSources(where, item.sources, context) : new Set();
    if (hasClaims) {
      for (const ref of item.claims) {
        if (!ids.has(ref)) fail(where, `cites unknown claim ${ref}`);
        for (const kind of claimKinds.get(ref) ?? []) kinds.add(kind);
      }
    }
    if (hasSources || hasClaims) {
      if (item.label === 'Real' && !kinds.has('citation')) {
        fail(where, 'a Real explainable needs a citation, its own or through a claim it cites');
      }
      if ((item.label === 'Simulated' || item.label === 'Metaphor') && !kinds.has('disclosure')) {
        fail(where, `a ${item.label} explainable needs an on-screen disclosure, its own or through a claim it cites`);
      }
    }
  });

  if (shots !== undefined) {
    const list = isObject(shots) && Array.isArray(shots.shots) ? shots.shots : null;
    if (!list) fail('shots', '"shots" must be a list');
    (list ?? []).forEach((shot, i) => {
      const where = `shot ${isObject(shot) && shot.id !== undefined ? shot.id : i + 1} caption`;
      if (!isObject(shot)) return fail(where, 'not an object');
      counts.captions++;
      if (!nonEmpty(shot.caption)) return fail(where, 'missing caption');
      const words = shot.caption.trim().split(/\s+/).length;
      if (words > MAX_CAPTION_WORDS) fail(where, `${words} words; captions stay under 12`);
      if (!Array.isArray(shot.claims) || shot.claims.length === 0) fail(where, 'cites no ledger claim');
      else for (const ref of shot.claims) if (!ids.has(ref)) fail(where, `cites unknown claim ${ref}`);
    });
  }

  return { errors, warnings, counts };
}

// ---------------------------------------------------------------------------
// Self-test: every rule must catch its broken fixture.
// ---------------------------------------------------------------------------

const checkedCitation = { kind: 'citation', title: 'A source', url: 'https://example.org/source', checked: '2026-11-06', supports: 'Says the thing.' };
const disclosure = { kind: 'disclosure', text: 'Labeled on screen.' };

function fixture(mutate = () => {}) {
  const ledger = {
    updated: '2026-11-06',
    claims: [
      { id: 'C01', claim: 'A real thing.', label: 'Real', sources: [{ ...checkedCitation }] },
      { id: 'C02', claim: 'A simulated thing.', label: 'Simulated', sources: [{ ...disclosure }] },
    ],
    explainables: [],
  };
  const shots = { shots: [{ id: 1, caption: 'A short caption.', claims: ['C01'] }] };
  mutate(ledger, shots);
  return { ledger, shots };
}

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const explainable = (fields) => (l) => l.explainables.push({ id: 'rack', title: 'Rack', ...fields });

const SELF_TESTS = [
  { name: 'a valid ledger with no explainables passes', make: () => fixture(), expect: null },
  { name: 'a ledger whose claims are not a list fails', make: () => fixture((l) => (l.claims = {})), expect: /"claims" must be a list/ },
  { name: 'a malformed claim id fails', make: () => fixture((l) => (l.claims[0].id = 'X1')), expect: /id must look like C01/ },
  { name: 'a claim with no text fails', make: () => fixture((l) => delete l.claims[0].claim), expect: /missing claim text/ },
  { name: 'a claim with no truth tag fails', make: () => fixture((l) => delete l.claims[0].label), expect: /missing truth tag/ },
  { name: 'a claim with an unknown truth tag fails', make: () => fixture((l) => (l.claims[0].label = 'Mostly true')), expect: /unknown truth tag/ },
  { name: 'a claim with no sources fails', make: () => fixture((l) => delete l.claims[0].sources), expect: /missing source/ },
  { name: 'a claim with an empty source list fails', make: () => fixture((l) => (l.claims[0].sources = [])), expect: /missing source/ },
  { name: 'a Real claim backed only by a disclosure fails', make: () => fixture((l) => (l.claims[0].sources = [{ ...disclosure }])), expect: /needs at least one citation/ },
  { name: 'a Simulated claim with no disclosure fails', make: () => fixture((l) => (l.claims[1].sources = [{ ...checkedCitation }])), expect: /Simulated claim needs an on-screen disclosure/ },
  { name: 'a Metaphor claim with no disclosure fails', make: () => fixture((l) => l.claims.push({ id: 'C03', claim: 'A figure of speech.', label: 'Metaphor', sources: [{ ...checkedCitation }] })), expect: /Metaphor claim needs an on-screen disclosure/ },
  { name: 'a source of unknown kind fails', make: () => fixture((l) => l.claims[0].sources.push({ kind: 'rumour' })), expect: /kind must be one of/ },
  { name: 'a citation without an https URL fails', make: () => fixture((l) => (l.claims[0].sources[0].url = 'http://example.org')), expect: /https URL/ },
  { name: 'a citation with no title fails', make: () => fixture((l) => delete l.claims[0].sources[0].title), expect: /citation has no title/ },
  { name: 'a disclosure with no text fails', make: () => fixture((l) => (l.claims[1].sources[0].text = ' ')), expect: /disclosure has no text/ },
  { name: 'an artifact with no path fails', make: () => fixture((l) => l.claims[1].sources.push({ kind: 'artifact', status: 'planned' })), expect: /artifact has no path/ },
  { name: 'an artifact with an unknown status fails', make: () => fixture((l) => l.claims[1].sources.push({ kind: 'artifact', path: 'src/main.ts', status: 'done' })), expect: /status must be/ },
  { name: 'a present artifact whose file is missing fails', make: () => fixture((l) => l.claims[1].sources.push({ kind: 'artifact', path: 'src/no-such-file.ts', status: 'present' })), root: SELF_ROOT, expect: /artifact not found/ },
  { name: 'a planned artifact only warns', make: () => fixture((l) => l.claims[1].sources.push({ kind: 'artifact', path: 'src/later.ts', status: 'planned' })), expect: null, warns: /planned artifact/ },
  { name: 'a checked date in another format fails', make: () => fixture((l) => (l.claims[0].sources[0].checked = '06/11/2026')), expect: /YYYY-MM-DD/ },
  { name: 'an impossible checked date fails', make: () => fixture((l) => (l.claims[0].sources[0].checked = '2026-02-30')), expect: /not a real date/ },
  { name: 'a checked date after the ledger\'s update fails', make: () => fixture((l) => (l.claims[0].sources[0].checked = '2026-12-01')), expect: /after the ledger's "updated" date/ },
  { name: 'a checked citation with no supports line fails', make: () => fixture((l) => delete l.claims[0].sources[0].supports), expect: /needs a "supports" line/ },
  { name: 'an impossible updated date fails', make: () => fixture((l) => (l.updated = '2026-11-31')), expect: /"updated" must be a real/ },
  { name: 'a ledger with no updated date fails', make: () => fixture((l) => delete l.updated), expect: /"updated" must be a real/ },
  { name: 'a blank supports line fails', make: () => fixture((l) => (l.claims[0].sources[0].supports = '   ')), expect: /needs a "supports" line/ },
  { name: 'a ledger that is not an object fails', make: () => ({ ledger: [], shots: undefined }), expect: /not a JSON object/ },
  { name: 'a claim that is not an object fails', make: () => fixture((l) => l.claims.push('C03')), expect: /not an object/ },
  { name: 'a source that is not an object fails', make: () => fixture((l) => l.claims[0].sources.push('a web page')), expect: /source 2: not an object/ },
  { name: 'a one-digit claim id fails', make: () => fixture((l) => (l.claims[0].id = 'C1')), expect: /id must look like C01/ },
  { name: 'a duplicate claim id fails', make: () => fixture((l) => (l.claims[1].id = 'C01')), expect: /duplicate id/ },
  { name: 'an explainable with no truth tag fails', make: () => fixture(explainable({ claims: ['C01'] })), expect: /missing truth tag/ },
  { name: 'an explainable with no source fails', make: () => fixture(explainable({ label: 'Approximated' })), expect: /missing source/ },
  { name: 'an explainable citing an unknown claim fails', make: () => fixture(explainable({ label: 'Approximated', claims: ['C99'] })), expect: /unknown claim C99/ },
  { name: 'an explainable with no title fails', make: () => fixture(explainable({ title: '', label: 'Approximated', claims: ['C01'] })), expect: /missing title/ },
  { name: 'explainables that are not a list fail', make: () => fixture((l) => (l.explainables = {})), expect: /"explainables" must be a list/ },
  { name: 'an explainable that is not an object fails', make: () => fixture((l) => l.explainables.push(42)), expect: /explainables\[0\]: not an object/ },
  { name: 'an explainable with no id fails', make: () => fixture(explainable({ id: '', label: 'Approximated', claims: ['C01'] })), expect: /missing id/ },
  { name: 'a duplicate explainable id fails', make: () => fixture((l) => { explainable({ label: 'Approximated', claims: ['C01'] })(l); explainable({ label: 'Approximated', claims: ['C01'] })(l); }), expect: /explainable rack: duplicate id/ },
  { name: 'an explainable\'s own citation is checked like a claim\'s', make: () => fixture(explainable({ label: 'Approximated', sources: [{ kind: 'citation', url: 'https://example.org' }] })), expect: /explainable rack source 1: citation has no title/ },
  { name: 'a Metaphor explainable with no disclosure fails', make: () => fixture(explainable({ label: 'Metaphor', claims: ['C01'] })), expect: /Metaphor explainable needs an on-screen disclosure/ },
  { name: 'a Real explainable with no citation fails', make: () => fixture(explainable({ label: 'Real', sources: [{ ...disclosure }] })), expect: /Real explainable needs a citation/ },
  { name: 'a Real explainable resting on a Real claim passes', make: () => fixture(explainable({ label: 'Real', claims: ['C01'] })), expect: null },
  { name: 'a Simulated explainable with no disclosure fails', make: () => fixture(explainable({ label: 'Simulated', claims: ['C01'] })), expect: /Simulated explainable needs an on-screen disclosure/ },
  { name: 'a Simulated explainable resting on a disclosed claim passes', make: () => fixture(explainable({ label: 'Simulated', claims: ['C02'] })), expect: null },
  { name: 'a caption citing an unknown claim fails', make: () => fixture((_, s) => (s.shots[0].claims = ['C99'])), expect: /unknown claim C99/ },
  { name: 'a caption citing no claim fails', make: () => fixture((_, s) => (s.shots[0].claims = [])), expect: /cites no ledger claim/ },
  { name: 'a shot with no caption fails', make: () => fixture((_, s) => (s.shots[0].caption = '')), expect: /missing caption/ },
  { name: 'a shot table whose shots are not a list fails', make: () => fixture((_, s) => { s.shot = s.shots; delete s.shots; }), expect: /"shots" must be a list/ },
  { name: 'a shot that is not an object fails', make: () => fixture((_, s) => s.shots.push(null)), expect: /shot 2 caption: not an object/ },
  { name: 'a 12-word caption split over two lines fails', make: () => fixture((_, s) => (s.shots[0].caption = 'one two three four five six\nseven eight nine ten eleven twelve')), expect: /captions stay under 12/ },
  { name: 'an 11-word caption passes', make: () => fixture((_, s) => (s.shots[0].caption = 'one two three four five six seven eight nine ten eleven')), expect: null },
  { name: 'a 12-word caption fails', make: () => fixture((_, s) => (s.shots[0].caption = 'one two three four five six seven eight nine ten eleven twelve')), expect: /captions stay under 12/ },
  { name: 'an unchecked citation only warns by default', make: () => fixture((l) => delete l.claims[0].sources[0].checked), expect: null, warns: /not yet opened/ },
  { name: 'an unchecked citation fails in strict mode', make: () => fixture((l) => delete l.claims[0].sources[0].checked), strict: true, expect: /not yet opened/ },
];

function selfTest() {
  let failed = 0;
  for (const test of SELF_TESTS) {
    const { ledger, shots } = test.make();
    const { errors, warnings } = lint({ ledger, shots, root: test.root, strict: Boolean(test.strict) });
    let ok = test.expect ? errors.some((e) => test.expect.test(e)) : errors.length === 0;
    if (ok && test.warns) ok = warnings.some((w) => test.warns.test(w));
    if (!ok) failed++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${test.name}${ok ? '' : `\n        errors: ${JSON.stringify(errors)}\n        warnings: ${JSON.stringify(warnings)}`}`);
  }
  console.log(failed === 0 ? `ledger-lint self-test: all ${SELF_TESTS.length} rules hold` : `ledger-lint self-test: ${failed} rule(s) broken`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { error: `${path}: ${error.message}` };
  }
}

const OPTIONS = ['--strict', '--self-test'];

function main(argv) {
  const unknown = argv.filter((arg) => !OPTIONS.includes(arg));
  if (unknown.length > 0) {
    console.error(`ledger-lint: unknown option ${unknown.join(' ')}; the options are ${OPTIONS.join(' and ')}`);
    return 2;
  }
  if (argv.includes('--self-test')) return selfTest();
  const strict = argv.includes('--strict');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const ledgerFile = readJson(resolve(root, 'src/content/ledger.json'));
  const shotsFile = readJson(resolve(root, 'src/content/shots.json'));
  const loadErrors = [ledgerFile.error, shotsFile.error].filter(Boolean);
  if (loadErrors.length > 0) {
    for (const e of loadErrors) console.error(`FAIL ${e}`);
    return 1;
  }
  const { errors, warnings, counts } = lint({ ledger: ledgerFile.value, shots: shotsFile.value, root, strict });
  for (const w of warnings) console.warn(`warn ${w}`);
  for (const e of errors) console.error(`FAIL ${e}`);
  const tally = LABELS.map((l) => `${counts.byLabel[l]} ${l}`).join(', ');
  console.log(
    `ledger-lint${strict ? ' --strict' : ''}: ${counts.claims} claims (${tally}), ${counts.explainables} explainables, ${counts.captions} captions; ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  return errors.length > 0 ? 1 : 0;
}

/** True when this file is the script node was asked to run, even through a symlink. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
