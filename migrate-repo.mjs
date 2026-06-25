#!/usr/bin/env node
/* migrate-repo.mjs - one-time tidy-up for the BLACKOUT repo.
 *
 * Moves the data JSONs into data/ and the PWA icons into images/icons/, then
 * rewrites every reference to match: index.html, manifest.webmanifest, the
 * build scripts, and both GitHub Actions workflows.
 *
 * Safe by design. It works out every text change first and ASSERTS that each
 * string it expects is present the right number of times. If anything does not
 * match your files it prints what it could not find and exits WITHOUT writing
 * or moving a single thing, so a mismatch can never leave you half-migrated.
 *
 * Run it once from the repo root:
 *     node migrate-repo.mjs            # do it
 *     node migrate-repo.mjs --dry-run  # just check every edit matches, change nothing
 *
 * Afterwards review with `git status` and `git diff`, serve locally and watch
 * the Network tab for any 404, then commit.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const die = (m) => { console.error('\n  ABORTED: ' + m + '\n  Nothing was changed.'); process.exit(1); };

if (!existsSync('index.html')) die('no index.html here. Run this from the repo root.');

/* ---- files that move (git mv, so history is kept) ---- */
const DATA_JSONS = [
  'aliases.json', 'club-overrides.json', 'clubs.json', 'country-names-i18n.json',
  'data.json', 'federations.json', 'fifa-squads.json', 'fox-urls.json',
  'league-logos.json', 'managers.json', 'photos-extra.json', 'players-clubs.json',
  'players.json', 'team-info.json', 'wc-fixtures.json',
];
const ICONS = ['icon-180.png', 'icon-192.png', 'icon-512.png'];
const moves = [
  ...DATA_JSONS.map((f) => [f, 'data/' + f]),
  ...ICONS.map((f) => [f, 'images/icons/' + f]),
];

/* ---- text edits: path -> [ [find, replace, expectedCount], ... ] ----
 * find/replace are plain strings (no regex), matched literally. */
const edits = {
  'index.html': [
    ["const DATA_URL='./data.json';", "const DATA_URL='./data/data.json';", 1],
    ["const PLAYERS_URL='./players.json';", "const PLAYERS_URL='./data/players.json';", 1],
    ["const CLUBS_URL='./clubs.json';", "const CLUBS_URL='./data/clubs.json';", 1],
    ["const PCLUBS_URL='./players-clubs.json';", "const PCLUBS_URL='./data/players-clubs.json';", 1],
    ["const PHOTOX_URL='./photos-extra.json';", "const PHOTOX_URL='./data/photos-extra.json';", 1],
    ["const TEAMINFO_URL='./team-info.json';", "const TEAMINFO_URL='./data/team-info.json';", 1],
    ["const MANAGERS_URL='./managers.json';", "const MANAGERS_URL='./data/managers.json';", 1],
    ["const FIFASQUADS_URL='./fifa-squads.json';", "const FIFASQUADS_URL='./data/fifa-squads.json';", 1],
    ["const FOXURLS_URL='./fox-urls.json';", "const FOXURLS_URL='./data/fox-urls.json';", 1],
    ["const FEDERATIONS_URL='./federations.json';", "const FEDERATIONS_URL='./data/federations.json';", 1],
    ["const LEAGUELOGOS_URL='./league-logos.json';", "const LEAGUELOGOS_URL='./data/league-logos.json';", 1],
    ["const CLUBOVERRIDE_URL='./club-overrides.json';", "const CLUBOVERRIDE_URL='./data/club-overrides.json';", 1],
    ["fetchJSON('./aliases.json?t='", "fetchJSON('./data/aliases.json?t='", 1],
    ['href="./icon-180.png"', 'href="./images/icons/icon-180.png"', 1],
  ],
  'manifest.webmanifest': [
    ['"./icon-192.png"', '"./images/icons/icon-192.png"', 1],
    ['"./icon-512.png"', '"./images/icons/icon-512.png"', 1],
  ],
  'scripts/build-data.mjs': [
    // ROOT-relative: join(ROOT, 'x.json') -> join(ROOT, 'data', 'x.json')
    ["join(ROOT, 'data.json')", "join(ROOT, 'data', 'data.json')", 3],
    ["join(ROOT, 'wc-fixtures.json')", "join(ROOT, 'data', 'wc-fixtures.json')", 1],
    ["join(ROOT, 'managers.json')", "join(ROOT, 'data', 'managers.json')", 1],
    ["join(ROOT, 'team-info.json')", "join(ROOT, 'data', 'team-info.json')", 2],
    // player-photos.json is an optional, uncommitted local override; left at the root on purpose.
  ],
  'scripts/should-build.mjs': [
    ["readJSON('wc-fixtures.json', {})", "readJSON('data/wc-fixtures.json', {})", 1],
    ["readJSON('data.json', {})", "readJSON('data/data.json', {})", 1],
  ],
  'scripts/build-rosters.mjs': [
    ["const DATA = 'data.json', OUT = 'fox-urls.json';", "const DATA = 'data/data.json', OUT = 'data/fox-urls.json';", 1],
  ],
  'scripts/build-players.mjs': [
    ["const DATA = 'data.json', OUT = 'players.json', VERSION = 3;", "const DATA = 'data/data.json', OUT = 'data/players.json', VERSION = 3;", 1],
    ["existsSync('fox-urls.json') ? (JSON.parse(readFileSync('fox-urls.json', 'utf8')).teams || {}) : {}",
     "existsSync('data/fox-urls.json') ? (JSON.parse(readFileSync('data/fox-urls.json', 'utf8')).teams || {}) : {}", 1],
  ],
  'scripts/build-photos.mjs': [
    ["const DATA   = './data.json';", "const DATA   = './data/data.json';", 1],
    ["const PLAYERS= './players.json';", "const PLAYERS= './data/players.json';", 1],
    ["const OUT    = './photos-extra.json';", "const OUT    = './data/photos-extra.json';", 1],
  ],
  'scripts/build-clubs.mjs': [
    ["loadJSON('players.json', { teams: {} })", "loadJSON('data/players.json', { teams: {} })", 1],
    ["loadJSON('wc-fixtures.json', { aliases: {} })", "loadJSON('data/wc-fixtures.json', { aliases: {} })", 1],
    ["loadJSON('clubs.json', {})", "loadJSON('data/clubs.json', {})", 1],
    ["saveJSON('clubs.json', {", "saveJSON('data/clubs.json', {", 1],
    ["saveJSON('players-clubs.json', overlay);", "saveJSON('data/players-clubs.json', overlay);", 1],
  ],
  'scripts/build-logos.mjs': [
    ["process.env.CLUBS_PATH  || './clubs.json';", "process.env.CLUBS_PATH  || './data/clubs.json';", 1],
    ["readFile('./players-clubs.json', 'utf8')", "readFile('./data/players-clubs.json', 'utf8')", 1],
  ],
  'scripts/audit-photos.mjs': [
    ["existsSync('players.json')", "existsSync('data/players.json')", 1],
    ["readFileSync('players.json', 'utf8')", "readFileSync('data/players.json', 'utf8')", 1],
    ["existsSync('fox-urls.json') ? (JSON.parse(readFileSync('fox-urls.json', 'utf8')).teams || {}) : {}",
     "existsSync('data/fox-urls.json') ? (JSON.parse(readFileSync('data/fox-urls.json', 'utf8')).teams || {}) : {}", 1],
  ],
  'scripts/photo-overrides.mjs': [
    // move players + photos-extra; photo-overrides.json is a local override, left at the root.
    ["const PLAYERS = 'players.json', PHOTOX = 'photos-extra.json', OVR = 'photo-overrides.json';",
     "const PLAYERS = 'data/players.json', PHOTOX = 'data/photos-extra.json', OVR = 'photo-overrides.json';", 1],
  ],
  'scripts/add-broadcaster.mjs': [
    ["findIn('wc-fixtures.json', [ROOT, here, join(ROOT, 'scripts'), process.cwd()])",
     "findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT, here, join(ROOT, 'scripts'), process.cwd()])", 1],
    ["wc-fixtures.json sits at the repo root", "wc-fixtures.json sits in data/", 1],
  ],
  'scripts/fox_team_spider.py': [
    ['foxurls="fox-urls.json"', 'foxurls="data/fox-urls.json"', 1],
  ],
  '.github/workflows/update-data.yml': [
    ['git status --porcelain data.json', 'git status --porcelain data/data.json', 1],
    ['git add data.json', 'git add data/data.json', 1],
  ],
  '.github/workflows/update-squads.yml': [
    ['if [ -f team-info.json ]; then cp team-info.json out/team-info.json; fi',
     'if [ -f data/team-info.json ]; then cp data/team-info.json out/team-info.json; fi', 1],
    ['cp out/team-info.json team-info.json', 'cp out/team-info.json data/team-info.json', 1],
    ['git add fox-urls.json players.json team-info.json photos-extra.json',
     'git add data/fox-urls.json data/players.json data/team-info.json data/photos-extra.json', 1],
  ],
};

/* ---- pass 1: read + verify every edit, change nothing yet ---- */
const staged = {};
let editCount = 0;
for (const [file, rules] of Object.entries(edits)) {
  if (!existsSync(file)) die(`expected file not found: ${file}`);
  let s = readFileSync(file, 'utf8');
  for (const [find, repl, want] of rules) {
    const got = s.split(find).length - 1;
    if (got !== want) die(`${file}: expected ${want}x but found ${got}x of:\n    ${JSON.stringify(find)}\n  This file differs from what the migration was written against.`);
    s = s.split(find).join(repl);
    editCount++;
  }
  staged[file] = s;
}
console.log(`Checked ${editCount} edits across ${Object.keys(edits).length} files - all matched.`);

if (DRY) {
  console.log('\nDry run: every edit matches and nothing was changed. Re-run without --dry-run to apply.');
  process.exit(0);
}

/* ---- pass 2: write the edited files ---- */
for (const [file, content] of Object.entries(staged)) writeFileSync(file, content);
console.log('Wrote the edited files.');

/* ---- pass 3: move the files (git mv keeps history) ---- */
mkdirSync('data', { recursive: true });
mkdirSync('images/icons', { recursive: true });
let moved = 0, skipped = 0;
for (const [from, to] of moves) {
  if (existsSync(to) && !existsSync(from)) { skipped++; continue; } // already moved
  if (!existsSync(from)) { console.warn(`  note: ${from} not found, skipped.`); skipped++; continue; }
  try { execSync(`git mv "${from}" "${to}"`, { stdio: 'pipe' }); moved++; }
  catch (e) { die(`git mv failed for ${from} -> ${to}: ${String(e.stderr || e.message).trim()}`); }
}
console.log(`Moved ${moved} files into data/ and images/icons/ (${skipped} already in place or absent).`);

console.log(`
Done. Next:
  1. git status                      review the moves and edits
  2. python3 -m http.server 8000     then open http://localhost:8000, hard-refresh
                                      (Cmd+Shift+R) and watch the Network tab: no 404s
  3. node scripts/should-build.mjs   smoke-test a script that reads data/ (needs no keys)
  4. git commit                      when it all checks out
`);
