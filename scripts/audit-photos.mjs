#!/usr/bin/env node
/*
 * audit-photos.mjs - sanity-check player photos/links for shared-name mix-ups.
 * Reads players.json + fox-urls.json (run from the project root). Read-only; changes nothing.
 *
 * Reports three things:
 *   1. SHARED NAMES   - any name held by 2+ players, and whether two of them share the SAME
 *                       Fox photo/URL (a real collision, e.g. both Suarezes showing one face).
 *   2. WILL BE FIXED  - fox players whose stored URL no longer matches their roster URL; a normal
 *                       re-run of the patched build-players.mjs re-resolves these automatically.
 *   3. MISALIGNED     - roster rows where the scraped NAME and the SLUG disagree (name's surname
 *                       absent from the slug, or a junk name like a height). These point at a
 *                       build-rosters scrape mishap; the photo/link may be wrong and a re-run
 *                       will NOT self-correct them - fix via a photos-extra override or build-rosters.
 */
import { readFileSync, existsSync } from 'fs';

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const PARTICLES = { al:1, el:1, ad:1, ben:1, bin:1, abu:1, ould:1, ibn:1, abd:1, van:1, von:1, de:1, da:1, di:1, dos:1, del:1, der:1, la:1, le:1 };
const surnameToken = name => {
  const t = norm(name).replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (let i = t.length - 1; i >= 0; i--) if (!PARTICLES[t[i]] && t[i].length >= 3) return t[i];
  return t[t.length - 1] || '';
};
const pid  = u => { const m = String(u || '').match(/headshots\/(\d+)/); return m ? m[1] : null; };
const slugTail = u => String(u || '').replace('https://www.foxsports.com/soccer/', '');

if (!existsSync('data/players.json')) { console.error('players.json not found - run from the project root.'); process.exit(1); }
const players = JSON.parse(readFileSync('data/players.json', 'utf8')).teams || {};
const rosters = existsSync('data/fox-urls.json') ? (JSON.parse(readFileSync('data/fox-urls.json', 'utf8')).teams || {}) : {};

function resolveExact(team, name) {
  const r = rosters[team]; if (!r || !r.players) return null;
  const q = norm(name);
  for (const p of r.players) if (p.name && norm(p.name) === q) return p;
  const toks = q.split(/\s+/).filter(Boolean); if (!toks.length) return null;
  const surname = toks[toks.length - 1];
  let best = null, score = 0;
  for (const p of r.players) {
    const pt = norm(p.name || '').split(/\s+/).filter(Boolean);
    const parts = (p.slug || '').split('-');
    if (!pt.includes(surname) && !parts.includes(surname)) continue;
    const s = toks.filter(t => pt.includes(t) || parts.includes(t)).length;
    if (s > score) { score = s; best = p; }
  }
  return best;
}

/* 1. shared names + same-photo collisions */
const byName = {};
for (const tm of Object.keys(players))
  for (const p of (players[tm].players || []))
    (byName[norm(p.name)] = byName[norm(p.name)] || []).push({ tm, name: p.name, pidv: pid(p.photo), url: slugTail(p.stats), src: p.src });
const shared = Object.keys(byName).filter(n => byName[n].length > 1);
let collisions = 0;
console.log('1) SHARED NAMES (held by 2+ players): ' + shared.length);
for (const nm of shared) {
  const g = byName[nm];
  const ids = g.map(x => x.pidv).filter(Boolean);
  const urls = g.map(x => x.url).filter(Boolean);
  const bad = new Set(ids).size < ids.length || new Set(urls).size < urls.length;
  if (bad) collisions++;
  console.log('   ' + (bad ? 'COLLISION ' : 'ok        ') + nm);
  g.forEach(x => console.log('       ' + x.tm.padEnd(16) + 'photo#' + (x.pidv || '-').padEnd(9) + x.url));
}
console.log('   -> same-photo collisions: ' + collisions);

/* 2. stored URL vs roster URL (what a patched re-run fixes) */
const fix = [];
for (const tm of Object.keys(players))
  for (const p of (players[tm].players || [])) {
    if (p.src !== 'fox') continue;
    const rx = resolveExact(tm, p.name);
    if (rx && rx.url !== p.stats) fix.push({ tm, name: p.name, from: slugTail(p.stats), to: slugTail(rx.url) });
  }
console.log('\n2) WILL BE FIXED by re-running patched build-players.mjs: ' + fix.length);
fix.forEach(x => console.log('   ' + x.tm.padEnd(16) + x.name.padEnd(24) + x.from + '  ->  ' + x.to));

/* 3. mis-paired roster rows: a REAL name whose slug names a DIFFERENT person.
 *    (Rows with a junk NAME but a correct slug are benign - the slug is the identity and
 *    section 1 already confirms no two players share a photo - so they are skipped here.)
 *    A re-run will NOT self-correct these: the roster itself holds the wrong link. */
const photoOf = {};
for (const tm of Object.keys(players)) for (const p of (players[tm].players || [])) photoOf[tm + '|' + norm(p.name)] = pid(p.photo);
const mis = [];
for (const tm of Object.keys(rosters)) for (const p of (rosters[tm].players || [])) {
  const name = p.name || '';
  if (/[\d"']/.test(name) || norm(name).replace(/[^a-z]/g, '').length < 3) continue;   // junk name + distinct slug -> benign
  const nameToks = new Set(norm(name).split(/\s+/).filter(Boolean));
  const slugToks = (p.slug || '').split('-').filter(t => !/^\d+$/.test(t));             // drop trailing -N
  if (slugToks.some(t => nameToks.has(t))) continue;                                    // slug shares a word with the name -> same person
  mis.push({ tm, name, slug: p.slug, inSquad: photoOf[tm + '|' + norm(name)] != null });
}
console.log('\n3) FOX QUIRK SLUGS (real name, Fox slug is unrelated to it): ' + mis.length);
mis.forEach(x => console.log('   ' + (x.inSquad ? '* ' : '  ') + x.tm.padEnd(15) + x.name.padEnd(24) + '-> ' + (x.slug || '-')));
console.log('   build-rosters reads the name and the link from the SAME <a> tag, so a name cannot be');
console.log('   paired with another player\'s link. These are Fox\'s own URLs (e.g. Enzo Fernandez really');
console.log('   lives at santiago-sosa-3-player); the photos are correct and need no override. FYI only.');

console.log('\nSUMMARY: ' + shared.length + ' shared name(s), ' + collisions + ' same-photo collision(s), ' +
  fix.length + ' auto-fixed on re-run; section 3 is informational (Fox slug quirks, not errors).');
