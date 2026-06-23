#!/usr/bin/env node
/*
 * build-players.mjs  ·  builds players.json: a per-team dictionary of World Cup
 * squad members (and managers) with a photo link, a stats-page link, shirt
 * number and canonical name. Photos come from Fox Sports first (richest set),
 * then ESPN as a fallback; the site shows initials when neither has one.
 *
 * Run AFTER build-data.mjs:   node scripts/build-players.mjs
 *
 * Fox rate-limits bursts of requests, so this script backs off when throttled,
 * only remembers genuine "no such page" misses, and RE-TRIES every player that
 * does not yet have a Fox photo each time you run it. If a run gets throttled
 * partway through, just run it again later (the IP limit resets) and it fills in
 * the rest. Players already matched to a Fox photo are skipped on re-runs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DATA = 'data.json', OUT = 'players.json', VERSION = 3;
const FOX = 'https://www.foxsports.com/soccer/';
const HEAD_BASE = 'https://b.fssta.com/uploads/application/soccer/headshots/';
const FBREF = n => 'https://fbref.com/search/search.fcgi?search=' + encodeURIComponent(String(n || '').trim());
const HEADSHOT_RX = /https?:\/\/b\.fssta\.com\/uploads\/application\/soccer\/headshots\/\d+(?:\.vresize\.\d+\.\d+\.[a-z]+\.\d+)?\.png/gi;
const BLOCK_RX = /incapsula|request unsuccessful|access denied|distil|captcha|unusual traffic|you have been blocked|cf-browser-verification|too many requests/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const slugify = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Fox slugs are inconsistent (abdullah-al-hamdan vs khalid-alghannam), so generate an
// ordered list of plausible slugs per player: standard, apostrophe-stripped, particle-joined,
// particle-collapsed, particle-dropped. Tried in order; first page that actually matches wins.
const PARTICLES = { al: 1, el: 1, ad: 1, ben: 1, bin: 1, abu: 1, ould: 1, ibn: 1, abd: 1, van: 1, von: 1, de: 1, da: 1, di: 1, dos: 1, del: 1, der: 1, la: 1, le: 1 };
function candidateSlugs(name) {
  const base = slugify(name);
  const stripped = slugify(norm(name).replace(/['\u2019.]/g, ''));   // N'Golo -> ngolo (not dashed)
  const set = [];
  const push = v => { if (v && set.indexOf(v) < 0) set.push(v); };
  push(base); push(stripped);
  [base, stripped].forEach(b => {
    if (!b) return; const toks = b.split('-');
    const joined = []; for (let i = 0; i < toks.length; i++) { if (PARTICLES[toks[i]] && i + 1 < toks.length) { joined.push(toks[i] + toks[i + 1]); i++; } else joined.push(toks[i]); }
    push(joined.join('-'));
    if (toks.length > 2) push(toks[0] + '-' + toks.slice(1).join(''));   // collapse all after first name
    push(toks.filter((t, i) => i === 0 || !PARTICLES[t]).join('-'));      // drop particles
  });
  return set;
}
// main surname token (last meaningful, non-particle word) used to verify a guessed page is the right player
function surnameToken(name) {
  const toks = norm(name).replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) if (!PARTICLES[toks[i]] && toks[i].length >= 3) return toks[i];
  return toks[toks.length - 1] || '';
}

if (!existsSync(DATA)) { console.error('players: ' + DATA + ' not found. Run build-data.mjs first.'); process.exit(1); }
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const teams = prev.teams || {};
// a pre-fix players.json cached throttled lookups as permanent misses: drop that cache once.
const foxMiss = new Set(prev.v === VERSION ? (prev.foxMiss || []) : []);
if (prev.teams && prev.v !== VERSION) console.log('players: upgrading cache - will retry everyone without a Fox photo yet.');

/* exact Fox player-page URLs resolved from team roster pages (build-rosters.mjs) */
const rosters = existsSync('fox-urls.json') ? (JSON.parse(readFileSync('fox-urls.json', 'utf8')).teams || {}) : {};
if (!Object.keys(rosters).length) console.log('players: no fox-urls.json found - run build-rosters.mjs first for exact URLs (otherwise slugs are guessed).');
// match a squad member to a roster player. The roster anchor's text is the
// player's current name (even when the slug is unrelated, e.g. Ghedjemis ->
// marvin-emmanuel), so match on that first; fall back to surname/token overlap
// for spelling differences (Achraf vs Achref).
// Some Fox slugs share no token with the player's name, so the surname check below
// can never match them. Pin those by hand here: "<Team>|<name>" -> Fox slug.
// e.g. Brazil's Raphinha lives at /soccer/raphael-2-player (slug "raphael-2").
const SLUG_OVERRIDES = {
  'brazil|raphinha': 'raphael-2'
};
const _ovrNorm = s => norm(s);
function overrideSlugFor(team, name) {
  const k = _ovrNorm(team) + '|' + _ovrNorm(name);
  return SLUG_OVERRIDES[k] || null;
}
function resolveExact(team, name) {
  const r = rosters[team]; if (!r || !r.players) return null;
  // honour a hand-pinned slug first, even if the roster scrape missed this player
  const forced = overrideSlugFor(team, name);
  if (forced) {
    const hit = r.players.find(p => p.slug === forced);
    if (hit) return hit;
    return { slug: forced, url: FOX + forced + '-player', name: name, fid: null, head: null };
  }
  const q = norm(name);
  for (const p of r.players) if (p.name && norm(p.name) === q) return p;   // exact name match
  const toks = q.split(/\s+/).filter(Boolean); if (!toks.length) return null;
  const surname = toks[toks.length - 1];
  let best = null, score = 0;
  for (const p of r.players) {
    const pt = norm(p.name || '').split(/\s+/).filter(Boolean);
    const parts = p.slug.split('-');
    if (!pt.includes(surname) && !parts.includes(surname)) continue;       // surname must match name or slug
    const s = toks.filter(t => pt.includes(t) || parts.includes(t)).length;
    if (s > score) { score = s; best = p; }
  }
  return best;   // {slug,url,name,fid,head} or null
}

/* collect unique squad members + managers from the match detail */
const seen = new Set(), want = [], managers = {};
for (const key of Object.keys(data.detail || {})) {
  const d = data.detail[key];
  for (const sk of ['home', 'away']) {
    const side = d[sk]; if (!side || !side.name) continue;
    if (side.coach && !managers[side.name]) managers[side.name] = side.coach;
    for (const p of [...(side.xi || []), ...(side.subs || [])]) {
      const id = norm(side.name) + '|' + norm(p.name); if (!p.name || seen.has(id)) continue; seen.add(id);
      want.push({ team: side.name, name: p.name, num: p.n != null ? p.n : null, pos: p.pos || '', espnPhoto: p.photo || null });
    }
  }
}

/* fetch a Fox player page; backs off on throttling, caches only genuine misses */
// `cool` is a gentle, fast-decaying global pacing delay (rises during throttle
// bursts, capped low, recovers on success) so a block storm never pins the run.
// `backoff` is a per-player retry wait, local to one fox() call.
let cool = 0, throttles = 0;
// fetch one Fox URL: returns {photo,stats} on a verified hit, 'throttle' if rate-limited (don't cache), or null (genuine miss/wrong page)
async function foxTry(url, surname) {
  let backoff = 700;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }); }
    catch (e) { throttles++; cool = Math.min(cool + 600, 4000); if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    if (r.status === 429 || r.status === 403 || r.status >= 500) { throttles++; cool = Math.min(cool + 600, 4000); if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    if (r.status === 404) { cool = Math.max(0, cool - 800); return null; }
    if (!r.ok) { throttles++; if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    const html = await r.text();
    if (html.length < 1500 || (html.length < 15000 && BLOCK_RX.test(html))) { throttles++; cool = Math.min(cool + 600, 4000); if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }  // tiny block wall
    cool = Math.max(0, cool - 800);
    const m = html.match(HEADSHOT_RX);
    if (m && m.length) {
      if (surname && norm(html.slice(0, 20000)).indexOf(surname) < 0) return null;   // landed on a different player's page
      return { photo: m.find(u => /vresize/.test(u)) || m[0], stats: url };
    }
    return null;   // real page, no headshot
  }
  return 'throttle';   // exhausted retries while throttled
}
async function fox(name, explicitURL) {
  const base = slugify(name); if (!base && !explicitURL) return null;
  if (!explicitURL && foxMiss.has(base)) return null;
  const surname = explicitURL ? '' : surnameToken(name);          // verify guessed slugs; trust an exact roster URL
  const urls = explicitURL ? [explicitURL] : candidateSlugs(name).map(s => FOX + s + '-player');
  for (const u of urls) {
    const res = await foxTry(u, surname);
    if (res === 'throttle') return null;   // bail; retried next run, not cached as a miss
    if (res) return res;
  }
  if (!explicitURL) foxMiss.add(base);     // all candidates genuinely missed
  return null;
}

const isFox = (team, nm) => { const ex = (teams[team] && teams[team].players || []).find(p => norm(p.name) === norm(nm)); return ex && ex.src === 'fox'; };
let done = 0, foxHits = 0;
const todo = want.filter(w => !isFox(w.team, w.name)).length;
console.log('players: ' + want.length + ' squad members seen, ' + todo + ' still need a Fox lookup (re-run later to fill in any the rate limit skips)...');
for (const w of want) {
  teams[w.team] = teams[w.team] || { manager: null, players: [] };
  const ex = teams[w.team].players.find(p => norm(p.name) === norm(w.name));
  if (ex && ex.src === 'fox') {
    const rxPrev = resolveExact(w.team, w.name);                                  // cheap, local: no network
    if (!rxPrev || rxPrev.url === ex.stats) { if (w.num != null) ex.num = w.num; if (w.pos) ex.pos = w.pos; continue; }  // stored photo already matches the roster (or no roster URL) - keep it
    // a roster URL now exists and differs from the stored (guessed) one -> fall through and re-resolve to correct photo + link
  }
  let photo = null, stats = FBREF(w.name), src = 'none';   // ESPN fallback removed: no photo unless Fox resolves it (front end shows clean initials otherwise)
  const rx = resolveExact(w.team, w.name);
  if (rx && (rx.head || rx.fid)) {                       // roster gave a photo (or an id to build one): no fetch needed
    photo = rx.head || (HEAD_BASE + rx.fid + '.png'); stats = rx.url; src = 'fox'; foxHits++;
  } else {
    const f = await fox(w.name, rx && rx.url);           // exact URL when known, else guess the slug
    if (f) { photo = f.photo; stats = f.stats; src = 'fox'; foxHits++; }
    await sleep(220 + cool);
  }
  if (ex) { ex.photo = photo; ex.stats = stats; ex.src = src; ex.num = w.num; ex.pos = w.pos; }
  else teams[w.team].players.push({ name: w.name, num: w.num, pos: w.pos, photo: photo || null, stats, src });
  if (++done % 20 === 0) console.log('players: ' + done + '/' + todo + ' looked up (' + foxHits + ' new Fox hits' + (throttles ? ', ' + throttles + ' throttled/retried' : '') + ')...');
  if (done % 200 === 0) { console.log('players: pausing 8s to stay under Fox rate limits...'); await sleep(8000); cool = 0; }
}

/* managers: try a Fox page too (some have one), else just the name */
for (const team of Object.keys(managers)) {
  const name = managers[team]; teams[team] = teams[team] || { manager: null, players: [] };
  if (teams[team].manager && teams[team].manager.src === 'fox' && norm(teams[team].manager.name) === norm(name)) continue;
  let photo = null, stats = FBREF(name), src = 'none';
  const f = await fox(name); if (f) { photo = f.photo; stats = f.stats; src = 'fox'; foxHits++; }
  await sleep(220 + cool);
  teams[team].manager = { name, photo, stats, src };
}

for (const team of Object.keys(teams)) if (teams[team].players) teams[team].players.sort((a, b) => (a.num == null ? 999 : a.num) - (b.num == null ? 999 : b.num));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), v: VERSION, teams, foxMiss: [...foxMiss].sort() }));
const total = Object.values(teams).reduce((n, t) => n + ((t.players || []).length), 0);
const withFox = Object.values(teams).reduce((n, t) => n + ((t.players || []).filter(p => p.src === 'fox').length), 0);
console.log('players: ' + total + ' players across ' + Object.keys(teams).length + ' teams; ' + withFox + ' have Fox photos (' + foxHits + ' new this run, ' + throttles + ' throttled retries). Re-run to pick up any the rate limit skipped.');
