#!/usr/bin/env node
/* clean-team-info.mjs — tidy an existing team-info.json WITHOUT crawling Fox.
 *
 * Use this to rescue a complete-but-messy team-info.json (e.g. an older full
 * crawl that still has national teams listed as "clubs" and placeholder/flag
 * crests). Club affiliations and crests don't change mid-tournament, so an older
 * full file is perfectly good for the site once cleaned.
 *
 *   node clean-team-info.mjs <input.json> [output.json]
 *
 * If output is omitted it writes <input>.clean.json (never overwrites the input).
 * It applies the SAME rules as the spider:
 *   - remove clubs whose id looks like a national team (…-men-team / …-women-team)
 *   - null out crests that are Placeholder images or country flag-logos
 *   - drop clubs left with no real crest? NO — we keep them (name is still useful),
 *     we only drop the national-team pseudo-clubs and detach them from players/seasons.
 */
import fs from 'fs';

const inPath = process.argv[2];
if (!inPath) { console.error('usage: node clean-team-info.mjs <input.json> [output.json]'); process.exit(1); }
const outPath = process.argv[3] || inPath.replace(/\.json$/i, '') + '.clean.json';

const isNationalTeamId = (id) => /(?:-men|-women)-team$/.test(id || '');
const isFlagCrest = (u) => typeof u === 'string' && /\/countries\/flag-logos\//.test(u);
const isPlaceholder = (u) => typeof u === 'string' && /placeholder/i.test(u);
const cleanCrest = (u) => (!u || isPlaceholder(u) || isFlagCrest(u)) ? null : u;

const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const clubs = doc.clubs || {};
const players = doc.players || {};
const seasons = doc.seasons || {};

const before = Object.keys(clubs).length;
let crestsCleared = 0;
const bad = new Set();

for (const [cid, c] of Object.entries(clubs)) {
  if (c && c.crest) { const cc = cleanCrest(c.crest); if (cc !== c.crest) { c.crest = cc; crestsCleared++; } }
  if (isNationalTeamId(cid) || isFlagCrest((c || {}).crest)) bad.add(cid);
}
for (const cid of bad) delete clubs[cid];

// detach removed pseudo-clubs from players and the season map
let detachedPlayers = 0;
for (const p of Object.values(players)) {
  if (p && bad.has(p.club)) { p.club = null; if ('club_num' in p) p.club_num = null; detachedPlayers++; }
}
for (const rows of Object.values(seasons)) {
  for (const cid of Object.keys(rows)) if (bad.has(cid)) delete rows[cid];
}

doc.clubs = clubs; doc.players = players; doc.seasons = seasons;
fs.writeFileSync(outPath, JSON.stringify(doc, null, 1));

const after = Object.keys(clubs).length;
const withCrest = Object.values(clubs).filter(c => c && c.crest).length;
const leftovers = Object.keys(clubs).filter(k => isNationalTeamId(k) || isFlagCrest((clubs[k] || {}).crest)).length;
console.log(`clubs: ${before} -> ${after}  (removed ${bad.size} national-team entries)`);
console.log(`crests: cleared ${crestsCleared} placeholder/flag crests; ${withCrest} clubs still have a real crest`);
console.log(`players detached from removed clubs: ${detachedPlayers}`);
console.log(`national leftovers now (want 0): ${leftovers}`);
console.log(`wrote ${outPath}`);
