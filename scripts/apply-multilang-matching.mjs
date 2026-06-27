#!/usr/bin/env node
// apply-multilang-matching.mjs — one-time, idempotent migration.
//
// It edits YOUR build-data.mjs and data/wc-fixtures.json in place so highlight
// titles in more languages get matched, WITHOUT disturbing any broadcasters you
// have already added:
//   - build-data.mjs : replaces the English/French-only highlight test with a
//     shared multilingual HL_RX (adds Dutch, German, Portuguese, Italian words).
//   - wc-fixtures.json : merges Dutch and German team-name aliases (deduped).
// Run it once, eyeball `git diff`, then `DEEP=1 node scripts/build-data.mjs` to
// re-match. Safe to run twice (it detects work already done). You can delete
// this file afterwards.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const findIn = (n, dirs) => { for (const d of dirs) { const p = join(d, n); if (existsSync(p)) return p; } return null; };
const ROOT = dirname(findIn('index.html', [join(here, '..'), here, process.cwd()]) || join(here, '..'));
const buildPath = findIn('build-data.mjs', [here, ROOT, join(ROOT, 'scripts'), process.cwd()]);
const fixturesPath = findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT, here, process.cwd()]);
if (!buildPath || !fixturesPath) { console.error('Could not find build-data.mjs and/or wc-fixtures.json. Run from inside the repo.'); process.exit(1); }

// ---------- 1) build-data.mjs : shared multilingual highlight regex ----------
let b = readFileSync(buildPath, 'utf8');
if (b.includes('const HL_RX')) {
  console.log('build-data.mjs: HL_RX already present, leaving as is.');
} else {
  const edits = [
    ["const pair = (a, b) => [a, b].sort().join('~');\n",
     "const pair = (a, b) => [a, b].sort().join('~');\n// recognises a \"this is a match recap\" title across languages (tested against norm()'d, diacritic-stripped text)\nconst HL_RX = /highlight|résum|resum|faits saillants|temps forts|samenvatting|zusammenfassung|melhores momentos|destaques|gli highlights|sintesi/;\n"],
    ["  const isHL = /highlight|résum|resum|faits saillants|temps forts/.test(n);",
     "  const isHL = HL_RX.test(n);"],
    ["        else if (/highlight|résum|resum/.test(norm(title))) unmatched.push({ id: it.id, title, src: feed.src, type, round });",
     "        else if (HL_RX.test(norm(title))) unmatched.push({ id: it.id, title, src: feed.src, type, round });"],
  ];
  for (const [oldS, newS] of edits) {
    const c = b.split(oldS).length - 1;
    if (c !== 1) { console.error(`build-data.mjs: expected to find this once, found ${c}x:\n  ${oldS.split('\n')[0]}\nAborting without writing build-data.mjs.`); process.exit(1); }
    b = b.replace(oldS, newS);
  }
  writeFileSync(buildPath, b);
  console.log('build-data.mjs: added HL_RX and pointed classify + the recap bucket at it.');
}

// ---------- 2) wc-fixtures.json : Dutch + German aliases ----------
const ADD = {
  'Mexico': ['mexiko'],
  'South Africa': ['zuid-afrika', 'zuid afrika', 'südafrika'],
  'South Korea': ['zuid-korea', 'zuid korea', 'südkorea'],
  'Czechia': ['tsjechië', 'tschechien'],
  'Canada': ['kanada'],
  'Bosnia and Herzegovina': ['bosnië en herzegovina', 'bosnië herzegovina', 'bosnië', 'bosnien und herzegowina', 'bosnien'],
  'Qatar': ['katar'],
  'Switzerland': ['zwitserland', 'schweiz'],
  'Brazil': ['brazilië', 'brasilien'],
  'Morocco': ['marokko'],
  'Haiti': ['haïti'],
  'Scotland': ['schotland', 'schottland'],
  'United States': ['verenigde staten', 'vereinigte staaten'],
  'Paraguay': [],
  'Australia': ['australië', 'australien'],
  'Türkiye': ['turkije', 'türkei'],
  'Germany': ['duitsland', 'deutschland'],
  'Curaçao': ['curaçao'],
  "Côte d'Ivoire": ['ivoorkust', 'elfenbeinküste'],
  'Ecuador': [],
  'Netherlands': ['nederland', 'niederlande'],
  'Japan': [],
  'Sweden': ['zweden', 'schweden'],
  'Tunisia': ['tunesië', 'tunesien'],
  'Belgium': ['belgië', 'belgien'],
  'Egypt': ['egypte', 'ägypten'],
  'Iran': [],
  'New Zealand': ['nieuw-zeeland', 'nieuw zeeland', 'neuseeland'],
  'Spain': ['spanje', 'spanien'],
  'Cabo Verde': ['kaapverdië', 'kap verde'],
  'Saudi Arabia': ['saudi-arabië', 'saoedi-arabië', 'saudi-arabien'],
  'Uruguay': [],
  'France': ['frankrijk', 'frankreich'],
  'Senegal': [],
  'Iraq': ['irak'],
  'Norway': ['noorwegen', 'norwegen'],
  'Argentina': ['argentinië', 'argentinien'],
  'Algeria': ['algerije', 'algerien'],
  'Austria': ['oostenrijk', 'österreich'],
  'Jordan': ['jordanië', 'jordanien'],
  'Portugal': [],
  'DR Congo': ['dr congo', 'dr kongo', 'kongo-kinshasa', 'demokratische republik kongo'],
  'Uzbekistan': ['oezbekistan', 'usbekistan'],
  'Colombia': ['kolumbien'],
  'England': ['engeland'],
  'Croatia': ['kroatië', 'kroatien'],
  'Ghana': [],
  'Panama': [],
};
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const cfg = JSON.parse(readFileSync(fixturesPath, 'utf8'));
const A = cfg.aliases || {};
let added = 0, missing = [];
for (const team of Object.keys(ADD)) {
  if (!A[team]) { missing.push(team); continue; }
  const seen = new Set(A[team].map(norm));
  for (const name of ADD[team]) if (!seen.has(norm(name))) { A[team].push(name); seen.add(norm(name)); added++; }
}
if (missing.length) console.log('wc-fixtures.json: these teams were not in aliases and were skipped:', missing.join(', '));
if (added) { writeFileSync(fixturesPath, JSON.stringify(cfg, null, 2) + '\n'); console.log(`wc-fixtures.json: added ${added} Dutch/German alias(es).`); }
else console.log('wc-fixtures.json: all Dutch/German aliases already present, leaving as is.');

console.log('\nDone. Next: review with `git diff`, then re-match with:  DEEP=1 node scripts/build-data.mjs');
