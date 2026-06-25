/*
 * build-photos.mjs  ·  photo fallback for the leaderboard
 *
 * The roster pipeline (build-rosters -> build-players) already scrapes Fox player
 * pages for everyone in a built squad. But a player can still show up on the
 * leaderboard from revealed match data while having no roster entry at all (for
 * example a national team that isn't in the team list yet, like England). Those
 * players have no photo, so the avatar falls back to initials.
 *
 * This script closes that gap. It reads data.json (the revealed lineups that feed
 * the leaderboard) and players.json (who already has a photo), finds every player
 * who appears in a lineup but has no roster photo, visits their Fox player page
 * (https://www.foxsports.com/soccer/<first>-<last>-player) and pulls the b.fssta
 * headshot out of the HTML. Results are written to photos-extra.json, which
 * index.html loads and applies before falling back to initials.
 *
 * It is polite and resumable: genuine misses are cached so re-runs don't refetch
 * them, throttled requests are left uncached, and anything already resolved is
 * skipped. Run it AFTER build-data / build-players, then commit photos-extra.json.
 *
 * Usage:  node scripts/build-photos.mjs
 *   (must run on your machine; the sandbox can't reach foxsports.com.)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DATA   = './data/data.json';
const PLAYERS= './data/players.json';
const OUT    = './data/photos-extra.json';
const VERSION= 1;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEAD_RX = /https?:\/\/b\.fssta\.com\/uploads\/application\/soccer\/headshots\/\d+(?:\.vresize\.\d+\.\d+\.[a-z]+\.\d+)?\.png/gi;
const DELAY_MS = 400;        // pause between players
const MAX_THROTTLE = 8;      // give up the run after this many 429/503 in a row

const sleep = ms => new Promise(r => setTimeout(r, ms));

// mirrors index.html nrm(): lowercase + strip diacritics, keep spaces. Used as the
// photos-extra key so the app's lookup matches.
const key = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Fox URL slug: diacritics stripped, apostrophes/periods dropped, the rest hyphenated.
const slug = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/['\u2019.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function load(path, dflt){ try{ return JSON.parse(readFileSync(path, 'utf8')); }catch(e){ return dflt; } }

// one Fox page: {photo} on a hit, 'throttle' if rate-limited, null on a real miss/error
async function scrape(url){
  let r;
  try{ r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }); }
  catch(e){ return null; }
  if(r.status === 429 || r.status === 503) return 'throttle';
  if(!r.ok) return null;
  const html = await r.text();
  const m = html.match(HEAD_RX);
  if(!m || !m.length) return null;
  const plain = m.find(u => !/vresize/.test(u));   // prefer the full headshot, like players.json
  return { photo: plain || m[0] };
}

async function resolve(name){
  const base = slug(name);
  if(!base) return null;
  // most pages are <slug>-player; some carry a numeric disambiguator
  const cands = [`${base}-player`, `${base}-2-player`, `${base}-3-player`];
  for(const c of cands){
    const out = await scrape(`https://www.foxsports.com/soccer/${c}`);
    if(out === 'throttle') return 'throttle';
    if(out && out.photo) return out.photo;
    await sleep(120);
  }
  return null;
}

async function main(){
  const data = load(DATA, null);
  if(!data || !data.detail){ console.error('build-photos: no data.json (or no .detail) - run build-data first.'); process.exit(1); }
  const players = load(PLAYERS, { teams: {} });

  // who already has a roster photo, by team -> set of normalised names
  const rosterPhoto = {};
  Object.keys(players.teams || {}).forEach(tm => {
    const set = new Set();
    (players.teams[tm].players || []).forEach(p => { if(p && p.name && p.photo) set.add(key(p.name)); });
    rosterPhoto[key(tm)] = set;
  });

  // index: normalised player name -> set of teams that field someone with that name.
  // A name shared across teams (e.g. Luis Suarez of Colombia vs Uruguay) can't be
  // resolved by slug guessing - "<slug>-player" only ever points at one of them -
  // so those are skipped here and listed for a manual, team-scoped entry instead.
  const nameTeams = {};
  Object.values(data.detail).forEach(d => {
    if(!d) return;
    ['home', 'away'].forEach(sk => {
      const side = d[sk]; if(!side || !side.name) return;
      (side.xi || []).concat(side.subs || []).forEach(pl => {
        if(!pl || !pl.name) return;
        const k = key(pl.name);
        (nameTeams[k] = nameTeams[k] || new Set()).add(key(side.name));
      });
    });
  });

  // every player (and coach) appearing in a revealed lineup, minus those with a roster
  // photo and minus shared-name players (which can't be slug-resolved safely).
  const need = new Map();      // normalised name -> display name
  const ambiguous = new Map(); // "team|name" -> display "Name (Team)" for manual resolution
  Object.values(data.detail).forEach(d => {
    if(!d) return;
    ['home', 'away'].forEach(sk => {
      const side = d[sk]; if(!side) return;
      const teamSet = rosterPhoto[key(side.name || '')];
      const list = (side.xi || []).concat(side.subs || []);
      list.forEach(pl => {
        if(!pl || !pl.name) return;
        const k = key(pl.name);
        if(teamSet && teamSet.has(k)) return;   // already covered by the roster
        if((nameTeams[k] && nameTeams[k].size > 1)){   // shared across teams -> needs a manual team-scoped entry
          ambiguous.set(key(side.name || '') + '|' + k, `${pl.name} (${side.name})`);
          return;
        }
        if(!need.has(k)) need.set(k, pl.name);
      });
      if(side.coach){ const k = key(side.coach); if(!(teamSet && teamSet.has(k)) && !(nameTeams[k] && nameTeams[k].size > 1) && !need.has(k)) need.set(k, side.coach); }
    });
  });

  // resume from a previous run
  const prev = load(OUT, {});
  const photos = (prev.v === VERSION && prev.photos) ? prev.photos : {};
  const miss = new Set((prev.v === VERSION && prev.miss) ? prev.miss : []);

  const todo = [...need.entries()].filter(([k]) => !photos[k] && !miss.has(k));
  console.log(`build-photos: ${need.size} lineup players without a roster photo; ${todo.length} to look up (rest cached).`);

  let hits = 0, throttles = 0, streak = 0;
  for(const [k, name] of todo){
    const res = await resolve(name);
    if(res === 'throttle'){
      throttles++; streak++;
      if(streak >= MAX_THROTTLE){ console.log('  rate-limited repeatedly - stopping early; re-run later to finish.'); break; }
      await sleep(DELAY_MS * 4);
      continue;
    }
    streak = 0;
    if(res){ photos[k] = res; hits++; if(hits <= 20) console.log(`  ${name}  ->  ${res}`); }
    else { miss.add(k); }
    await sleep(DELAY_MS);
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), v: VERSION, photos, miss: [...miss].sort(), ambiguous: [...ambiguous.keys()].sort() }));
  console.log(`build-photos: wrote ${OUT} - ${Object.keys(photos).length} photos total (${hits} new this run, ${throttles} throttled). Commit it alongside data.json.`);
  if(ambiguous.size){
    console.log(`\nbuild-photos: ${ambiguous.size} shared-name player(s) skipped (a name shared across teams can't be slug-resolved). Add a team-scoped entry by hand in photos-extra.json under "photos", e.g.  "${[...ambiguous.keys()][0]}": "https://b.fssta.com/.../<id>.png"`);
    [...ambiguous.values()].sort().forEach(v => console.log(`  - ${v}`));
  }
}

main();
