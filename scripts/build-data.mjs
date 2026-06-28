#!/usr/bin/env node
/* BLACKOUT data builder — run by GitHub Actions (or locally).
 * Writes data.json next to index.html so visitors need NO key of their own.
 *
 * Sources (all free):
 *   - Results: openfootball (public domain, no key).
 *   - Highlights: broadcaster YouTube playlists via the YouTube Data API
 *     (YT_API_KEY). One entry per match per broadcaster, by type. No titles
 *     are ever stored (broadcaster titles can contain the score).
 *   - Match detail (lineups, box-score stats, player photos): TheSportsDB
 *     (free key "123" by default; set TSDB_KEY for a Patreon key). Best effort
 *     and provider-agnostic: whatever is available is added, the rest is left
 *     blank and the site degrades gracefully. No betting odds.
 *
 * Optional: GEMINI_API_KEY lets a model resolve recap titles the rules miss.
 *
 * Output schema (data.json):
 *   { generatedAt, lastDeep,
 *     videos:  { <matchKey>: { <source>: { x?, r?, g? } } },   // youtube ids
 *     detail:  { <matchKey>: { home, away, events, teamStats } },
 *     ofMatches: [ ... openfootball matches ... ] }
 *   matchKey = group fixture id ('A1'..'L6') or knockout number ('73'..'104').
 *   source in { fifa, tsn, rds, fox, itv };  type x=extended r=regular g=game-in-30.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const keyFile = (name) => { try { const f = join(ROOT, 'keys', name + '.txt'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
const OPENFOOTBALL_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const TOURNAMENT_START = Date.parse('2026-06-11T00:00:00-04:00');
const MATCH_END_BUFFER = 120 * 60000;
const DEEP_EVERY_MS = 6 * 3600000;

const cfg = JSON.parse(readFileSync(join(ROOT, 'data', 'wc-fixtures.json'), 'utf8'));
const FIXTURES = cfg.fixtures;            // [[id, home, away, kickoffISO], ...]
const KO_START = cfg.koRoundStart;        // { R32: iso, ... }
const ALIASES = cfg.aliases;              // { myName: [aliasStrings...] }
const PLAYLISTS = cfg.playlists || {};    // { fifa, tsn, fox_x, fox_r, itv, rds }
const KEY = process.env.YT_API_KEY || keyFile('youtube');
const TSDB_KEY = process.env.TSDB_KEY || '123';
let   TSDB_LEAGUE = process.env.TSDB_LEAGUE_ID || cfg.tsdbLeagueId || '';
const AI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keyFile('gemini');
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// API-Football (api-sports.io): the detail source when a key is present.
const AF_KEY = process.env.API_FOOTBALL_KEY || '';
const AF_HOST = process.env.API_FOOTBALL_HOST || 'https://v3.football.api-sports.io';
const AF_LEAGUE = process.env.AF_LEAGUE_ID || cfg.afLeagueId || '1';   // FIFA World Cup
const AF_SEASON = process.env.AF_SEASON || cfg.afSeason || '2026';
const AF_LIMIT = 90;          // stay safely under the free 100/day quota
const AF_RUN_CAP = 12;        // matches to fetch per run (newest first)
const AF_RATINGS = (process.env.AF_RATINGS || cfg.afRatings || 'on') !== 'off';  // off => skip per-player ratings call (3 req/match instead of 4)
const now = Date.now();
// Force a fresh re-fetch of all ESPN detail pages (e.g. after a schema change). Set FORCE_DETAIL=1.
const FORCE_DETAIL = (process.env.FORCE_DETAIL || '') !== '';

/* ---------- managers (ESPN's summary omits coaches, so we supply them) ----------
 * Managers and manager bookings now live in managers.json next to index.html, so
 * they can be edited by hand without touching this script. Shape:
 *   {
 *     "teams": {
 *       "Tunisia": [
 *         { "name": "Sami Trabelsi", "from": null, "to": "F2", "photo": "", "url": "" },
 *         { "name": "New Boss",      "from": "F4", "to": null, "photo": "", "url": "" }
 *       ],
 *       "Brazil": [ { "name": "Carlo Ancelotti", "from": null, "to": null, "photo": "", "url": "" } ]
 *     },
 *     "cards": [
 *       { "match": "C1", "team": "Brazil", "type": "yellow", "min": 66 },
 *       { "match": "C4", "team": "Haiti",  "type": "red", "sy": true, "min": 80 }
 *     ]
 *   }
 * Each team is a list of spells. "from"/"to" are fixture ids (group "A1".."L6" or
 * knockout "73".."104") bounding the spell; null = open-ended. A spell with both
 * null covers the whole tournament. "to" is inclusive. The build picks the spell
 * whose window contains each fixture (by kickoff order), so a country that changes
 * manager mid-tournament shows the right one on each match. "cards" lists manager
 * bookings (yellow/red, sy for a second yellow) which are injected as mgr-flagged
 * events so they appear by the manager and in the timeline, and count toward the
 * team conduct score. */
const MGR_SEED = {
  'Argentina': 'Lionel Scaloni', 'Brazil': 'Carlo Ancelotti', 'France': 'Didier Deschamps',
  'Germany': 'Julian Nagelsmann', 'Spain': 'Luis de la Fuente', 'Netherlands': 'Ronald Koeman',
  'Belgium': 'Rudi Garcia', 'Portugal': 'Roberto Martinez', 'England': 'Thomas Tuchel',
  'Croatia': 'Zlatko Dalic', 'Italy': 'Luciano Spalletti',
  'Canada': 'Jesse Marsch', 'United States': 'Mauricio Pochettino', 'Mexico': 'Javier Aguirre',
  'Morocco': 'Walid Regragui', 'Japan': 'Hajime Moriyasu', 'Senegal': 'Pape Thiaw',
  'Uruguay': 'Marcelo Bielsa', 'Switzerland': 'Murat Yakin', 'Scotland': 'Steve Clarke',
  'Norway': 'Stale Solbakken', 'Austria': 'Ralf Rangnick', 'Ecuador': 'Sebastian Beccacece',
  'Egypt': 'Hossam Hassan', 'Iran': 'Amir Ghalenoei', 'Australia': 'Tony Popovic',
  'South Korea': 'Hong Myung-bo', 'Paraguay': 'Gustavo Alfaro', "Cote d'Ivoire": 'Emerse Fae',
  'Bosnia and Herzegovina': 'Sergej Barbarez', 'Czechia': 'Ivan Hasek', 'Sweden': 'Jon Dahl Tomasson',
  'South Africa': 'Hugo Broos', 'New Zealand': 'Darren Bazeley', 'Cabo Verde': 'Bubista',
  'Curacao': 'Dick Advocaat', 'Iraq': 'Graham Arnold', 'Turkiye': 'Vincenzo Montella', 'Algeria': 'Vladimir Petkovic'
};
const MANAGERS_PATH = join(ROOT, 'data', 'managers.json');
let MGR_DOC = { teams: {}, cards: [] };
if (existsSync(MANAGERS_PATH)) {
  try { MGR_DOC = JSON.parse(readFileSync(MANAGERS_PATH, 'utf8')); MGR_DOC.teams = MGR_DOC.teams || {}; MGR_DOC.cards = MGR_DOC.cards || []; }
  catch (e) { console.error('managers.json parse error, using seed:', e.message); }
} else {
  // First run: write a starter file from the seed so it can be edited by hand.
  for (const k of Object.keys(MGR_SEED)) MGR_DOC.teams[k] = [{ name: MGR_SEED[k], from: null, to: null, photo: '', url: '' }];
  try { writeFileSync(MANAGERS_PATH, JSON.stringify(MGR_DOC, null, 2)); console.log('wrote starter managers.json (' + Object.keys(MGR_DOC.teams).length + ' teams)'); }
  catch (e) { console.error('could not write managers.json:', e.message); }
}

/* which front-end source a playlist belongs to, and whether it is the "extended" feed */
const FEEDS = [
  { pl: 'tsn',   src: 'tsn'  },
  { pl: 'rds',   src: 'rds'  },
  { pl: 'itv',   src: 'itv'  },
  { pl: 'bein',      src: 'bein'      },
  { pl: 'telemundo', src: 'telemundo' },
  { pl: 'fifa',      src: 'fifa'      },
  { pl: 'fox_x', src: 'fox', forceExtended: true },
  { pl: 'fox_r', src: 'fox' },
  { pl: 'sportstudiofussball', src: 'sportstudiofussball' },
  { pl: 'rtesport', src: 'rtesport' },
  { pl: 'sbssport', src: 'sbssport' },
  { pl: 'tvnzsport', src: 'tvnzsport' },
  { pl: 'nossport', src: 'nossport' },
  { pl: 'orfsport', src: 'orfsport' },
  { pl: 'caztv_g', src: 'caztv', type: 'g' },
  { pl: 'caztv_r', src: 'caztv', type: 'r' },
  { pl: 'caztv_full', src: 'caztv', type: 'full' },
  { pl: 'tvaztecadeportes', src: 'tvaztecadeportes' },
  { pl: 'tudnmxico', src: 'tudnmxico', split: [{ kw: ['mini resumen'], type: 'minirec' }, { kw: ['resumen y goles', 'resumen'], type: 'recap' }]  },
  { pl: 'livemodetv_r', src: 'livemodetv', type: 'r' },
  { pl: 'livemodetv_full', src: 'livemodetv', type: 'full' },
  { pl: 'sporttv', src: 'sporttv', split: [{ kw: ['resumo'], type: 'r' }, { kw: ['golo'], type: 'g' }]  },
  { pl: 'sporza', src: 'sporza' },
  { pl: 'caztv_goals', src: 'caztv', type: 'goals' },
  { pl: 'dsports', src: 'dsports' },
  { pl: 'daznitalia', src: 'daznitalia' },
  { pl: 'supersport', src: 'supersport' },
  { pl: 'daznes', src: 'daznes' },
  { pl: 'tvri', src: 'tvri' },
  { pl: 'daznjapan', src: 'daznjapan', split: [{ kw: ['match recap'], type: 'recap' }, { kw: ['ハイライト'], type: 'short' }]  },
  { pl: 'trtspor', src: 'trtspor' },
  { pl: 'jtbcsports', src: 'jtbcsports', type: 'r' },
];

/* ---------- load existing data.json (merge target so links persist) ---------- */
let prev = {};
if (existsSync(join(ROOT, 'data', 'data.json'))) { try { prev = JSON.parse(readFileSync(join(ROOT, 'data', 'data.json'), 'utf8')); } catch {} }
const videos = prev.videos || {};
const durations = prev.durations || {};   // real clip length in seconds, keyed by video id
const detail = prev.detail || {};
const afState = prev.afState || { date: '', used: 0, map: {}, tried: {} };
const DEEP_FORCE = /^(1|true|yes)$/i.test(process.env.DEEP || '');
const DEEP_ONLY = (process.env.DEEP_ONLY || '').trim();   // deep-crawl just this one src; the others stay on the cheap regular crawl
// A targeted DEEP_ONLY suppresses the global 6-hourly deep so the other feeds stay cheap; DEEP=1 still forces a full deep of everything.
const deep = DEEP_FORCE || (!DEEP_ONLY && (!prev.lastDeep || (now - Date.parse(prev.lastDeep)) > DEEP_EVERY_MS));

/* ---------- name matching ---------- */
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ALIAS_RX = [];
for (const team of Object.keys(ALIASES)) for (const a of ALIASES[team]) {
  const clean = norm(a).replace(/[.'’&]/g, ' ').trim();
  if (!clean) continue;
  const n = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // \b is only meaningful next to [A-Za-z0-9_]; beside CJK it never fires, so a Japanese/Chinese
  // alias wrapped in \b...\b can never match. Apply the boundary only where the alias edge is a
  // Latin letter or digit; for a CJK edge, match as a substring. Latin aliases are unchanged.
  const wb = c => (/[a-z0-9]/i.test(c) ? '\\b' : '');
  ALIAS_RX.push({ team, rx: new RegExp(wb(clean[0]) + n + wb(clean[clean.length - 1])) });
}
function teamsInText(text) {
  const n = norm(text).replace(/[.'’&]/g, ' '); const found = [];
  for (const { team, rx } of ALIAS_RX) if (found.indexOf(team) < 0 && rx.test(n)) found.push(team);
  return found;
}
const canon = name => teamsInText(name)[0] || name;       // a single team name -> my canonical name
function roundOfTitle(title) {
  const n = norm(title);
  if (/third place|3rd place|petite finale/.test(n)) return '3P';
  if (/semi[\s-]?final|semifinal|demi[\s-]?finale/.test(n)) return 'SF';
  if (/quarter[\s-]?final|quarterfinal|quart de finale/.test(n)) return 'QF';
  if (/round of 16|last 16|huitieme/.test(n)) return 'R16';
  if (/round of 32|seizieme/.test(n)) return 'R32';
  if (/\bfinale?\b/.test(n)) return 'F';
  return 'GROUP';
}
const parseDur = iso => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const fixtureFor = (t1, t2) => FIXTURES.find(m => (m[1] === t1 && m[2] === t2) || (m[1] === t2 && m[2] === t1));
const groupPlayed = fx => { const t = Date.parse(fx[3]); return !isNaN(t) && (t + MATCH_END_BUFFER) <= now; };
const koRoundStarted = r => { const t = Date.parse(KO_START[r]); return !isNaN(t) && (t + MATCH_END_BUFFER) <= now; };
const pair = (a, b) => [a, b].sort().join('~');
// recognises a "this is a match recap" title across languages (tested against norm()'d, diacritic-stripped text)
const HL_RX = /highlight|résum|resum|faits saillants|temps forts|samenvatting|zusammenfassung|melhores momentos|destaques|gli highlights|sintesi/;

function classify(feed, durSec, title) {
  const n = norm(title);
  const isHL = HL_RX.test(n);
  if (feed.pl === 'fifa') return 'r';   // curated FIFA highlights playlist: attach matches as recaps regardless of title wording
  if (feed.pl === 'tsn') { if (/game in 30|in\s?30/.test(n)) return 'g'; return isHL ? 'r' : null; }
  if (feed.split) { for (const r of feed.split) if (r.kw.some(k => n.includes(norm(k)))) return r.type; return null; }   // mixed playlist: pick the type by title keyword (first rule wins); a video matching no rule is dropped, which filters out non-highlights
  if (feed.type) return feed.type;   // a playlist declared to be one highlight type (multi-playlist broadcaster): attach matches as that type regardless of title wording, like the FIFA playlist
  if (feed.forceExtended) return isHL || durSec > 14 * 60 ? 'x' : null;   // Fox extended feed (kept for back-compat; equivalent to type:'x')
  if (!isHL) return null;                                                  // everything else must look like a recap
  return (/extended/.test(n) || durSec > 16 * 60) ? 'x' : 'r';
}

/* ---------- knockout number lookup (filled from openfootball) ---------- */
const koNumByPair = {};   // "TeamA~TeamB" (canonical, sorted) -> "73"

function keyFor(teams, round) {
  if (round === 'GROUP') { const m = fixtureFor(teams[0], teams[1]); return (m && groupPlayed(m)) ? m[0] : null; }
  if (!koRoundStarted(round)) return null;
  return koNumByPair[pair(teams[0], teams[1])] || null;
}
function attach(key, src, type, vid) {
  if (!key) return false;
  const v = videos[key] = videos[key] || {};
  const s = v[src] = v[src] || {};
  if (!s[type]) { s[type] = vid; return true; }
  return false;
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { let d = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error && j.error.message) d = j.error.message; } catch {} throw new Error(d); }
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===================== 1) results from openfootball ===================== */
let ofMatches = [];
try {
  const of = await getJSON(OPENFOOTBALL_URL);
  ofMatches = (of.matches || []).map(m => {
    const o = { round: m.round, date: m.date, team1: m.team1, team2: m.team2 };
    if (m.num != null) o.num = m.num;
    if (m.group) o.group = m.group;
    if (m.ground) o.ground = m.ground;
    if (m.score) { o.score = { ft: m.score.ft }; if (m.score.p || m.score.pen) o.score.p = m.score.p || m.score.pen; }
    return o;
  });
  for (const m of ofMatches) if (m.num != null) koNumByPair[pair(canon(m.team1), canon(m.team2))] = String(m.num);
  console.log(`openfootball: ${ofMatches.length} matches (${ofMatches.filter(m => m.score && m.score.ft).length} scored)`);
} catch (e) { console.error('openfootball fetch failed:', e.message); }

/* ===================== 2) highlight videos (multi-source) ===================== */
let added = 0;
const unmatched = [];   // recap-looking titles we could not place, for the optional AI step
async function ytPlaylist(playlistId, onItem, deepThis) {
  let pageToken = '', pages = 0; const MAXPAGES = (deepThis === undefined ? deep : deepThis) ? 100 : 3;
  do {
    const pl = await getJSON('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + playlistId + '&key=' + encodeURIComponent(KEY) + (pageToken ? '&pageToken=' + pageToken : ''));
    const items = pl.items || [];
    const ids = items.map(it => it.contentDetails && it.contentDetails.videoId).filter(Boolean);
    if (ids.length) {
      const vj = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=' + ids.join(',') + '&key=' + encodeURIComponent(KEY));
      for (const it of (vj.items || [])) onItem(it);
    }
    pageToken = pl.nextPageToken || ''; pages++;
    const oldest = Math.min(...items.map(it => Date.parse((it.contentDetails && it.contentDetails.videoPublishedAt) || (it.snippet && it.snippet.publishedAt))).filter(n => !isNaN(n)).concat([Infinity]));
    if (oldest < TOURNAMENT_START) break;
  } while (pageToken && pages < MAXPAGES);
}
if (KEY) {
  for (const feed of FEEDS) {
    const playlistId = PLAYLISTS[feed.pl];
    if (!playlistId) { console.log(`youtube: no playlist configured for ${feed.pl} — skipped`); continue; }
    try {
      let n = 0;
      const feedDeep = deep || (!!DEEP_ONLY && feed.src === DEEP_ONLY);
      await ytPlaylist(playlistId, it => {
        const title = (it.snippet && it.snippet.title) || '';
        const dur = parseDur(it.contentDetails && it.contentDetails.duration);
        const type = classify(feed, dur, title); if (!type) return;
        const teams = teamsInText(title); const round = roundOfTitle(title);
        if (teams.length === 2) { if (attach(keyFor(teams, round), feed.src, type, it.id)) { durations[it.id] = dur; added++; n++; } }
        else if (HL_RX.test(norm(title))) unmatched.push({ id: it.id, title, src: feed.src, type, round });
      }, feedDeep);
      console.log(`youtube[${feed.pl}->${feed.src}]: +${n} link(s)` + (feedDeep && !deep ? '  [deep]' : ''));
    } catch (e) { console.error(`youtube[${feed.pl}] failed:`, e.message); }
  }
  console.log(`youtube: ${added} link(s) total; ${unmatched.length} recap title(s) unmatched`);
} else {
  console.log('YT_API_KEY not set — skipping highlight links (results + detail still written).');
}

/* ===================== 3) optional AI fallback for unmatched recaps ===================== */
if (AI_KEY && unmatched.length) {
  try {
    const teamList = Object.keys(ALIASES);
    const batch = unmatched.slice(0, 60);
    const prompt = 'These are YouTube titles that look like football match recaps. For each, identify the TWO teams playing, using EXACTLY these names: ' + JSON.stringify(teamList) +
      '. Return ONLY a JSON array like [{"i":0,"team1":"Mexico","team2":"South Africa"}]. If a title is not a single match between two of those teams, use null. No prose, no markdown.\n\nTitles:\n' +
      batch.map((u, i) => i + '. ' + u.title).join('\n');
    const resp = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${encodeURIComponent(AI_KEY)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
    });
    const text = ((resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || []).map(p => p.text || '').join('').replace(/```json|```/g, '').trim();
    let parsed = JSON.parse(text); if (!Array.isArray(parsed)) parsed = parsed.results || parsed.items || parsed.matches || [];
    let aiAdded = 0;
    for (const item of parsed) {
      if (!item || item.team1 == null || item.team2 == null) continue;
      const u = batch[item.i]; if (!u) continue;
      if (attach(keyFor([item.team1, item.team2], u.round), u.src, u.type, u.id)) aiAdded++;
    }
    added += aiAdded; console.log(`ai fallback: resolved ${aiAdded} extra link(s)`);
  } catch (e) { console.error('ai fallback skipped:', e.message); }
}

/* ===================== 3b) channel fallback: recover matches a deep source forgot to playlist ===================== */
// Title-by-title matcher, reused for channel crawls (mirrors the per-feed loop above).
function matchItem(feedLike, it) {
  const title = (it.snippet && it.snippet.title) || '';
  const dur = parseDur(it.contentDetails && it.contentDetails.duration);
  const type = classify(feedLike, dur, title); if (!type) return false;
  const teams = teamsInText(title); const round = roundOfTitle(title);
  if (teams.length === 2) return attach(keyFor(teams, round), feedLike.src, type, it.id);
  if (HL_RX.test(norm(title))) unmatched.push({ id: it.id, title, src: feedLike.src, type, round });
  return false;
}
let channelUploads = (prev.channelUploads && typeof prev.channelUploads === 'object') ? { ...prev.channelUploads } : {};
if (KEY) {
  const kickoffOf = {};                                            // match key -> kickoff ms (group from fixtures, KO from openfootball)
  for (const fx of FIXTURES) if (/^[A-L][1-9]$/.test(fx[0]) && fx[3]) kickoffOf[fx[0]] = Date.parse(fx[3]);
  for (const m of ofMatches) if (m.num != null && m.date) kickoffOf[String(m.num)] = Date.parse(m.date);
  const playedK = k => kickoffOf[k] != null && !isNaN(kickoffOf[k]) && (kickoffOf[k] + MATCH_END_BUFFER) <= now;
  const srcFeed = {};
  for (const f of FEEDS) if (!srcFeed[f.src]) srcFeed[f.src] = f;   // first feed per source (its playlist + forceExtended)
  for (const src of Object.keys(srcFeed)) {
    const srcDeep = deep || (!!DEEP_ONLY && src === DEEP_ONLY);     // only when this source is being deep-crawled
    if (!srcDeep) continue;
    let tMax = -Infinity;                                          // latest kickoff this source already has a clip for
    for (const k of Object.keys(videos)) if (videos[k][src] && kickoffOf[k] != null && !isNaN(kickoffOf[k]) && kickoffOf[k] > tMax) tMax = kickoffOf[k];
    if (tMax === -Infinity) continue;                              // nothing posted yet: cannot tell forgotten from not-yet-uploaded
    const gaps = Object.keys(kickoffOf).filter(k => playedK(k) && kickoffOf[k] < tMax && !(videos[k] && videos[k][src]));
    if (!gaps.length) continue;                                    // no earlier played match is missing
    try {
      let uploads = channelUploads[src];
      if (!uploads) {
        const plId = PLAYLISTS[srcFeed[src].pl];
        const pj = await getJSON('https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=' + plId + '&key=' + encodeURIComponent(KEY));
        const chId = pj.items && pj.items[0] && pj.items[0].snippet && pj.items[0].snippet.channelId;
        if (!chId) { console.log(`channel fallback[${src}]: could not resolve channel; skipped`); continue; }
        uploads = 'UU' + chId.slice(2); channelUploads[src] = uploads;     // uploads playlist id is the channel id with UC -> UU
      }
      let chN = 0;
      await ytPlaylist(uploads, it => { if (matchItem({ src, forceExtended: srcFeed[src].forceExtended }, it)) { added++; chN++; } }, true);
      console.log(`channel fallback[${src}]: ${gaps.length} expected gap(s) -> crawled channel uploads, +${chN} link(s)`);
    } catch (e) { console.error(`channel fallback[${src}] failed:`, e.message); }
  }
}

/* ===================== 3c) manual video overrides (data/video-overrides.json) ===================== */
try {
  const ovPath = join(ROOT, 'data', 'video-overrides.json');
  if (existsSync(ovPath)) {
    const ov = JSON.parse(readFileSync(ovPath, 'utf8'));
    const list = Array.isArray(ov) ? ov : (ov.videos || []);
    let ovN = 0, ovTotal = 0;
    for (const e of list) { if (!e || !e.match || !e.src || !e.id) continue; ovTotal++; if (attach(String(e.match), e.src, e.type || 'r', e.id)) ovN++; }
    if (ovTotal) console.log(`video-overrides: applied ${ovN} new of ${ovTotal} manual link(s)`);
  }
} catch (e) { console.error('video-overrides failed:', e.message); }

/* ===================== 4) match detail from TheSportsDB (best effort) ===================== */
const TSDB = p => `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}/${p}`;
const POS = s => { const c = (String(s || '').trim()[0] || '').toUpperCase(); return c === 'G' ? 'G' : c === 'D' ? 'D' : c === 'M' ? 'M' : c === 'F' ? 'F' : (/goal/i.test(s) ? 'G' : /def|back/i.test(s) ? 'D' : /mid/i.test(s) ? 'M' : /for|att|wing|strik/i.test(s) ? 'F' : 'M'); };
const photoCache = {};   // teamId -> { normName: url }
let overrides = {};
if (existsSync(join(ROOT, 'player-photos.json'))) { try { overrides = JSON.parse(readFileSync(join(ROOT, 'player-photos.json'), 'utf8')); } catch {} }
const ovr = name => { for (const k of Object.keys(overrides)) if (norm(k) === norm(name)) return overrides[k]; return null; };

async function rosterPhotos(teamId) {
  if (!teamId) return {};
  if (photoCache[teamId]) return photoCache[teamId];
  const map = {};
  try {
    const j = await getJSON(TSDB('lookup_all_players.php?id=' + teamId));
    for (const p of (j.player || [])) { const u = p.strCutout || p.strThumb; if (p.strPlayer && u) map[norm(p.strPlayer)] = u; }
  } catch {}
  photoCache[teamId] = map; await sleep(350); return map;
}
function photoFor(name, lineupUrl, roster) { return ovr(name) || lineupUrl || roster[norm(name)] || null; }

const parseLineupList = str => String(str || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
  let n = null, name = x, mm;
  if ((mm = /^(\d{1,2})[:.)\-]\s*(.+)$/.exec(x))) { n = +mm[1]; name = mm[2].trim(); }
  else if ((mm = /^(.+?)\s*[:\-]\s*(\d{1,2})$/.exec(x))) { name = mm[1].trim(); n = +mm[2]; }
  return { n, name };
});
async function buildSide(ev, isHome, teamName, teamId) {
  const roster = await rosterPhotos(teamId);
  const side = { name: canon(teamName) || teamName, formation: '', coach: '', xi: [], subs: [] };
  const HK = isHome ? 'Home' : 'Away';
  side.formation = ev['str' + HK + 'Formation'] || '';
  const byName = {};
  const add = (str, pos, toSubs) => { for (const p of parseLineupList(str)) { if (!p.name) continue; const e = { n: p.n, name: p.name, pos, photo: photoFor(p.name, null, roster) }; (toSubs ? side.subs : side.xi).push(e); byName[norm(p.name)] = e; } };
  add(ev['str' + HK + 'LineupGoalkeeper'], 'G', false);
  add(ev['str' + HK + 'LineupDefense'], 'D', false);
  add(ev['str' + HK + 'LineupMidfield'], 'M', false);
  add(ev['str' + HK + 'LineupForward'], 'F', false);
  add(ev['str' + HK + 'LineupSubstitutes'], '', true);
  try {
    const j = await getJSON(TSDB('lookuplineup.php?id=' + ev.idEvent)); await sleep(300);
    const rows = (j.lineup || []).filter(r => (r.strHome === (isHome ? 'Yes' : 'No')));
    for (const r of rows) {
      if (!side.formation && r.strFormation) side.formation = r.strFormation;
      const nm = norm(r.strPlayer || ''); let e = byName[nm];
      if (!e) {
        if (!r.strPlayer) continue;
        e = { n: r.intSquadNumber ? +r.intSquadNumber : null, name: r.strPlayer, pos: POS(r.strPosition), photo: photoFor(r.strPlayer, r.strCutout || r.strThumb, roster) };
        (r.strSubstitute === 'Yes' ? side.subs : side.xi).push(e); byName[nm] = e;
      } else {
        if (e.n == null && r.intSquadNumber) e.n = +r.intSquadNumber;
        if (!e.photo) e.photo = photoFor(r.strPlayer, r.strCutout || r.strThumb, roster);
      }
      const rt = parseFloat(r.intRating != null ? r.intRating : r.strRating); if (!isNaN(rt)) e.rating = rt;
      const on = parseInt(r.intSubMinute != null ? r.intSubMinute : r.strSubMinute, 10); if (!isNaN(on)) e.on = on;
    }
  } catch {}
  return side;
}

/* ===================== 4) match detail from ESPN (public, no key, covers the live tournament) ===================== */
const keyOf = m => m.num != null ? String(m.num) : (fixtureFor(canon(m.team1), canon(m.team2)) || [])[0] || null;
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';
const espnGet = async path => { const r = await fetch(ESPN_BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; blackout/1.0; +https://github.com)' } }); if (!r.ok) throw new Error('ESPN HTTP ' + r.status); return r.json(); };
const ESPN_POS = s => { s = (s || '').toUpperCase(); if (/^G/.test(s)) return 'G'; if (/^(DM|CDM|CM|CAM|AM|LM|RM|MF|M)/.test(s)) return 'M'; if (/^(RWB|LWB|CB|CD|LB|RB|WB|SW|DF|D)/.test(s)) return 'D'; if (/^(ST|CF|LW|RW|SS|FW|F)/.test(s)) return 'F'; return ({ G: 'G', D: 'D', M: 'M', F: 'F' })[s.charAt(0)] || 'M'; };
// Derive line band (0 GK,1 DEF,2 DM,3 MID,4 AM,5 FWD) and lateral key (0 right..4 left) from ESPN's descriptive position name.
const espnBand = n => { n = String(n || '').toLowerCase(); if (/goalkeep|keeper/.test(n)) return 0; if (/back|defender|defen[cs]e|sweeper/.test(n)) return 1; if (/defensive midfield|holding/.test(n)) return 2; if (/attacking midfield|second striker|playmaker/.test(n)) return 4; if (/midfield/.test(n)) return 3; if (/forward|strik|wing|attack/.test(n)) return 5; return 3; };
const espnLat = n => { n = String(n || '').toLowerCase(); if (/cent(er|re)\s*right|right\s*cent(er|re)/.test(n)) return 1; if (/cent(er|re)\s*left|left\s*cent(er|re)/.test(n)) return 3; if (/\bright\b/.test(n)) return 0; if (/\bleft\b/.test(n)) return 4; return 2; };
const BAND_POS = ['G', 'D', 'M', 'M', 'M', 'F'];
const espnClock = c => { const t = String((c && (c.displayValue || c.value)) || ''); const m = /(\d+)/.exec(t), ex = /\+\s*(\d+)/.exec(t); return { min: m ? +m[1] : 0, extra: ex ? +ex[1] : 0 }; };
const espnName = a => { if (!a) return ''; if (typeof a === 'string') return a; return a.displayName || a.fullName || a.shortName || a.name || (a.athlete && (a.athlete.displayName || a.athlete.fullName || a.athlete.shortName || a.athlete.name)) || ''; };
function espnBuildDetail(sum) {
  const rosters = sum.rosters || [];
  const espnPos = x => { const pp = (typeof x === 'string') ? x : (x && (x.abbreviation || x.name)) || ''; return ESPN_POS(pp); };
  const ratingOf = stats => { if (!Array.isArray(stats)) return null; for (const s of stats) { const nm = String((s && (s.name || s.abbreviation || s.shortDisplayName)) || '').toLowerCase(); if (/rating|rtg/.test(nm)) { const v = s.displayValue != null ? s.displayValue : s.value; if (v != null && v !== '' && !isNaN(parseFloat(v))) return parseFloat(v); } } return null; };
  const coachOf = ru => { const cz = ru && (ru.coach || ru.coaches); const c0 = Array.isArray(cz) ? cz[0] : cz; if (!c0) return ''; return c0.displayName || c0.name || [c0.firstName, c0.lastName].filter(Boolean).join(' ') || ''; };
  const sideOf = ru => {
    const side = { name: ru && ru.team ? canon(ru.team.displayName || ru.team.name) : '', formation: (ru && ru.formation) || '', coach: coachOf(ru), xi: [], subs: [] };
    (ru && ru.roster || []).forEach(p => {
      const a = p.athlete || {};
      const rt = ratingOf(p.stats || (a && a.stats));
      const posObj = p.position || a.position;
      const pNm = (typeof posObj === 'string') ? posObj : ((posObj && (posObj.name || posObj.displayName)) || '');
      let band = pNm ? espnBand(pNm) : ({ G: 0, D: 1, M: 3, F: 5 })[espnPos(posObj)];
      if (band == null) band = 3;
      const e = { n: p.jersey != null ? +p.jersey : (a.jersey != null ? +a.jersey : null), name: espnName(a), pos: BAND_POS[band], ord: band * 10 + (pNm ? espnLat(pNm) : 2), photo: (a.headshot && a.headshot.href) || (a.id ? ('https://a.espncdn.com/i/headshots/soccer/players/full/' + a.id + '.png') : null) };
      if (rt != null) e.rating = rt;
      (p.starter ? side.xi : side.subs).push(e);
    });
    return side;
  };
  let home, away;
  rosters.forEach(ru => { if (ru.homeAway === 'home') home = sideOf(ru); else if (ru.homeAway === 'away') away = sideOf(ru); });
  if (!home) home = rosters[0] ? sideOf(rosters[0]) : { name: '', formation: '', coach: '', xi: [], subs: [] };
  if (!away) away = rosters[1] ? sideOf(rosters[1]) : { name: '', formation: '', coach: '', xi: [], subs: [] };
  const homeId = (rosters.find(r => r.homeAway === 'home') || rosters[0] || {}).team && (rosters.find(r => r.homeAway === 'home') || rosters[0]).team.id;
  const awayId = (rosters.find(r => r.homeAway === 'away') || rosters[1] || {}).team && (rosters.find(r => r.homeAway === 'away') || rosters[1]).team.id;
  const teamStats = [];
  const bt = (sum.boxscore && sum.boxscore.teams) || [];
  const byId = {}; bt.forEach(t => { if (t.team) byId[t.team.id] = t.statistics || []; });
  const hS = byId[homeId] || (bt[0] && bt[0].statistics) || [], aS = byId[awayId] || (bt[1] && bt[1].statistics) || [];
  const amap = {}; aS.forEach(s => { amap[s.name || s.label] = (s.displayValue != null ? s.displayValue : s.value); });
  const pct = (k, v) => (v != null && /poss/i.test(String(k)) && !/%/.test(String(v)) && /^[\d.]+$/.test(String(v))) ? (v + '%') : v;
  hS.forEach(s => { const k = s.name || s.label, label = s.label || s.displayName || s.name, hv = (s.displayValue != null ? s.displayValue : s.value); if (hv == null && !(k in amap)) return; teamStats.push({ label: label, h: pct(k, hv), a: pct(k, (k in amap ? amap[k] : null)) }); });
  const events = [];
  const subByName = {}; [...home.subs, ...away.subs].forEach(p => subByName[norm(p.name)] = p);
  const startByName = {}; [...home.xi, ...away.xi].forEach(p => startByName[norm(p.name)] = p);
  const pick = (...as) => { for (const a of as) if (a && a.length) return a; return []; };
  const sideOfPlayer = nm => { const x = norm(nm); if (!x) return null; if ([...home.xi, ...home.subs].some(p => norm(p.name) === x)) return 'home'; if ([...away.xi, ...away.subs].some(p => norm(p.name) === x)) return 'away'; return null; };
  const _hc = sum.header && sum.header.competitions && sum.header.competitions[0];
  const _merged = [].concat(sum.keyEvents || [], (_hc && _hc.details) || []);
  const keyEv = _merged.length ? _merged : pick((sum.commentary || []).map(c => c.play).filter(Boolean), sum.scoringPlays, sum.details);
  keyEv.forEach(ev => {
    const txt = ((ev.type && (ev.type.text || ev.type.name)) || ev.text || '').toLowerCase();
    const tside = ev.team ? (ev.team.id === homeId ? 'home' : 'away') : null;
    const cl = espnClock(ev.clock || ev.time); const inv = ev.athletesInvolved || ev.participants || [];
    if ((/goal/.test(txt) || ev.scoringPlay) && !/no goal|disallow|missed|goal kick/.test(txt)) {
      const og = !!ev.ownGoal || /own goal/.test(txt), pen = !!ev.penaltyKick || /penalt/.test(txt);
      const scorer = espnName(inv[0]), assist = (!og && inv.length > 1) ? espnName(inv[1]) : '';
      const opp = sd => sd === 'home' ? 'away' : (sd === 'away' ? 'home' : null), scSide = sideOfPlayer(scorer);
      const gside = og ? (scSide ? opp(scSide) : opp(tside)) : (scSide || tside);
      if (gside && scorer) { const o = { min: cl.min, team: gside, type: 'goal', player: scorer }; if (cl.extra) o.minx = '+' + cl.extra; if (pen) o.pen = true; if (og) o.og = true; if (assist && assist !== scorer) o.assist = assist; events.push(o); }
    } else if (/yellow|red card|second yellow|sent off|booking/.test(txt) || ev.yellowCard || ev.redCard) {
      const sy = /second yellow|2nd yellow|two yellow|second booking/.test(txt);
      const red = !!ev.redCard || sy || /red card|sent off/.test(txt); const pl = espnName(inv[0]); const cside = sideOfPlayer(pl) || tside;
      if (cside && pl) { const o = { min: cl.min, team: cside, type: red ? 'red' : 'card', player: pl }; if (cl.extra) o.minx = '+' + cl.extra; if (red && sy) o.sy = true; events.push(o); }
    } else if (/substitut/.test(txt)) {
      const names = inv.map(x => norm(espnName(x)));
      const onN = names.find(nn => subByName[nn]), offN = names.find(nn => startByName[nn]);
      if (onN) { const onP = subByName[onN]; onP.on = cl.min; if (offN && startByName[offN]) { onP.forName = startByName[offN].name; startByName[offN].off = cl.min; } }
    }
  });
  { const _seen = new Set(); for (let i = 0; i < events.length;) { const e = events[i], k = e.type + '|' + e.min + '|' + (e.minx || '') + '|' + norm(e.player); if (_seen.has(k)) events.splice(i, 1); else { _seen.add(k); i++; } } }
  events.sort((a, b) => (a.min || 0) - (b.min || 0));
  return { home, away, events, teamStats, src: 'espn', _dbg: { srcLen: keyEv.length, sample: (keyEv && keyEv[0]) || null } };
}
if (ofMatches.length) {
  try {
    let map = prev.espnMap || {};
    const played = ofMatches.filter(m => m.score && m.score.ft && m.score.ft.length === 2);
    if (played.some(m => { const k = keyOf(m); return k && !map[k]; })) {
      try {
        const sb = await espnGet('/scoreboard?dates=20260611-20260719&limit=400');
        (sb.events || []).forEach(ev => {
          const comp = (ev.competitions && ev.competitions[0]) || {}, cs = comp.competitors || [];
          const h = cs.find(c => c.homeAway === 'home'), a = cs.find(c => c.homeAway === 'away'); if (!h || !a) return;
          const A = canon(h.team.displayName || h.team.name), B = canon(a.team.displayName || a.team.name), date = (ev.date || '').slice(0, 10);
          const om = ofMatches.find(m => pair(canon(m.team1), canon(m.team2)) === pair(A, B) && (!m.date || !date || Math.abs(Date.parse(m.date) - Date.parse(date)) <= 2 * 86400000));
          const k = om && keyOf(om); if (k) map[k] = ev.id;
        });
        console.log('espn: mapped ' + Object.keys(map).length + '/' + played.length + ' fixtures to ESPN ids');
      } catch (e) { console.error('espn scoreboard failed:', e.message); }
    }
    let made = 0;
    const queue = played.slice().sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
    for (const m of queue) {
      const key = keyOf(m); if (!key) continue;
      if (!FORCE_DETAIL && detail[key] && detail[key].src === 'espn' && detail[key].home && detail[key].home.xi && detail[key].home.xi.length >= 7 && detail[key].home.xi[0] && detail[key].home.xi[0].ord != null) continue;  // skip only if already built with layout data (ord)
      const eid = map[key]; if (!eid) continue;
      try {
        const sum = await espnGet('/summary?event=' + eid); await sleep(900);
        const d = espnBuildDetail(sum);
        if (d && (d.home.xi.length || d.away.xi.length || d.teamStats.length || d.events.length)) {
          detail[key] = d; made++;
          const hc = sum.header && sum.header.competitions && sum.header.competitions[0];
          console.log('espn ' + key + ': ' + d.home.xi.length + 'v' + d.away.xi.length + ' players, ' + d.events.length + ' events, ' + d.teamStats.length + ' stats; sources ' + JSON.stringify({ details: ((hc && hc.details) || []).length, keyEvents: (sum.keyEvents || []).length, commentary: (sum.commentary || []).length, scoringPlays: (sum.scoringPlays || []).length }));
          if (d.events.length === 0 && d._dbg && d._dbg.srcLen > 0) console.log('  espn ' + key + ' raw event sample: ' + JSON.stringify(d._dbg.sample).slice(0, 500));
          delete d._dbg;
        }
      } catch (e) { console.error('espn detail ' + key + ' failed:', e.message); }
    }
    prev.espnMap = map;
    console.log('espn: built ' + made + ' detail page(s)');
  } catch (e) { console.error('espn enrichment skipped:', e.message); }
}

/* ===================== 4) match detail from API-Football (api-sports.io) ===================== */
const afPhoto = id => id ? ('https://media.api-sports.io/football/players/' + id + '.png') : null;
async function afGet(path) {
  const headers = process.env.API_FOOTBALL_RAPIDAPI
    ? { 'x-rapidapi-key': AF_KEY, 'x-rapidapi-host': (AF_HOST.replace(/^https?:\/\//, '')) }
    : { 'x-apisports-key': AF_KEY };
  const r = await fetch(AF_HOST + path, { headers });
  afState.used++;
  if (!r.ok) throw new Error('AF HTTP ' + r.status + (r.status === 429 ? ' (rate/quota)' : ''));
  const j = await r.json();
  const errs = j && j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) throw new Error('AF: ' + JSON.stringify(errs));
  await sleep(7000);   // ~8/min, under the free per-minute cap
  return j;
}
async function buildAFMatch(fid) {
  const lj = await afGet('/fixtures/lineups?fixture=' + fid);
  const lus = lj.response || [];
  const mkSide = lu => {
    const side = { name: lu ? canon(lu.team.name) : '', formation: lu ? (lu.formation || '') : '', coach: (lu && lu.coach && lu.coach.name) || '', xi: [], subs: [] };
    if (lu) {
      for (const e of (lu.startXI || [])) { const p = e.player || {}; side.xi.push({ n: p.number || null, name: p.name || '', pos: (p.pos || '').toUpperCase().slice(0, 1) || '', photo: afPhoto(p.id) }); }
      for (const e of (lu.substitutes || [])) { const p = e.player || {}; side.subs.push({ n: p.number || null, name: p.name || '', pos: (p.pos || '').toUpperCase().slice(0, 1) || '', photo: afPhoto(p.id) }); }
    }
    return side;
  };
  const home = mkSide(lus[0] || null), away = mkSide(lus[1] || null);
  const homeId = lus[0] && lus[0].team.id, awayId = lus[1] && lus[1].team.id;
  const teamStats = [];
  try {
    const sj = await afGet('/fixtures/statistics?fixture=' + fid);
    const sr = sj.response || []; const byTeam = {}; for (const t of sr) byTeam[t.team.id] = t.statistics || [];
    const hStats = byTeam[homeId] || (sr[0] && sr[0].statistics) || [];
    const aStats = byTeam[awayId] || (sr[1] && sr[1].statistics) || [];
    const amap = {}; for (const x of aStats) amap[x.type] = x.value;
    for (const x of hStats) { if (x.value == null && !(x.type in amap)) continue; teamStats.push({ label: x.type, h: x.value, a: (x.type in amap ? amap[x.type] : null) }); }
  } catch (e) { console.error('  af stats ' + fid + ':', e.message); if (/HTTP 429|quota|rate|requests/i.test(e.message)) throw e; }
  const events = [];
  const subByName = {}; [...home.subs, ...away.subs].forEach(p => subByName[norm(p.name)] = p);
  const startByName = {}; [...home.xi, ...away.xi].forEach(p => startByName[norm(p.name)] = p);
  try {
    const ej = await afGet('/fixtures/events?fixture=' + fid);
    for (const e of (ej.response || [])) {
      const tside = (e.team && e.team.id === homeId) ? 'home' : 'away';
      const min = (e.time && e.time.elapsed) || 0, extra = (e.time && e.time.extra) || 0;
      const T = (e.type || '').toLowerCase(), det = e.detail || '';
      if (T === 'goal') {
        if (/missed penalty/i.test(det)) continue;
        const og = /own goal/i.test(det), pen = /penalty/i.test(det);
        let gside = tside;
        if (og) { const sn = norm((e.player && e.player.name) || ''); const sSide = [...home.xi, ...home.subs].some(p => norm(p.name) === sn) ? 'home' : ([...away.xi, ...away.subs].some(p => norm(p.name) === sn) ? 'away' : null); gside = sSide ? (sSide === 'home' ? 'away' : 'home') : (tside === 'home' ? 'away' : 'home'); }
        const ev = { min, team: gside, type: 'goal', player: (e.player && e.player.name) || '' };
        if (extra) ev.minx = '+' + extra; if (pen) ev.pen = true; if (og) ev.og = true;
        events.push(ev);
      } else if (T === 'card') {
        const sy = /second yellow|2nd yellow/i.test(det);
        const red = sy || /red/i.test(det);
        const ev = { min, team: tside, type: red ? 'red' : 'card', player: (e.player && e.player.name) || '' };
        if (extra) ev.minx = '+' + extra; if (red && sy) ev.sy = true; events.push(ev);
      } else if (T === 'subst') {
        const a = norm((e.player && e.player.name) || ''), b = norm((e.assist && e.assist.name) || '');
        let onN, offN; if (subByName[a]) { onN = a; offN = b; } else if (subByName[b]) { onN = b; offN = a; } else { onN = b; offN = a; }
        const onP = subByName[onN], offP = startByName[offN];
        if (onP) { onP.on = min; if (offP) onP.forName = offP.name; }
        if (offP) offP.off = min;
      }
    }
  } catch (e) { console.error('  af events ' + fid + ':', e.message); if (/HTTP 429|quota|rate|requests/i.test(e.message)) throw e; }
  if (AF_RATINGS && afState.used + 1 <= AF_LIMIT) {
    try {
      const pj = await afGet('/fixtures/players?fixture=' + fid);
      const byName = {}; [...home.xi, ...home.subs, ...away.xi, ...away.subs].forEach(p => byName[norm(p.name)] = p);
      for (const t of (pj.response || [])) for (const pr of (t.players || [])) {
        const p = byName[norm((pr.player && pr.player.name) || '')]; if (!p) continue;
        const g = ((pr.statistics && pr.statistics[0]) || {}).games || {};
        const rt = parseFloat(g.rating); if (!isNaN(rt)) p.rating = rt;
        if (!p.photo && pr.player && pr.player.photo) p.photo = pr.player.photo;
      }
    } catch (e) { console.error('  af players ' + fid + ':', e.message); }
  }
  events.sort((a, b) => (a.min || 0) - (b.min || 0));
  return { home, away, events, teamStats, src: 'af' };
}
if (ofMatches.length && AF_KEY) {
  const today = new Date().toISOString().slice(0, 10);
  if (afState.date !== today) { afState.date = today; afState.used = 0; }
  afState.map = afState.map || {}; afState.tried = afState.tried || {};
  const played = ofMatches.filter(m => m.score && m.score.ft && m.score.ft.length === 2);
  try {
    if (played.some(m => { const k = keyOf(m); return k && !afState.map[k]; }) && afState.used < AF_LIMIT) {
      const fj = await afGet('/fixtures?league=' + AF_LEAGUE + '&season=' + AF_SEASON);
      for (const f of (fj.response || [])) {
        const a = canon(f.teams.home.name), b = canon(f.teams.away.name), date = (f.fixture.date || '').slice(0, 10);
        const om = ofMatches.find(m => pair(canon(m.team1), canon(m.team2)) === pair(a, b) && (!m.date || !date || Math.abs(Date.parse(m.date) - Date.parse(date)) <= 2 * 86400000));
        const k = om && keyOf(om); if (k) afState.map[k] = f.fixture.id;
      }
      console.log('api-football: mapped ' + Object.keys(afState.map).length + '/' + played.length + ' fixtures to AF ids');
    }
  } catch (e) { console.error('api-football fixtures map failed:', e.message, '(if this mentions plan/subscription, the free tier may not cover season ' + AF_SEASON + ')'); }
  let made = 0;
  const queue = played.slice().sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  for (const m of queue) {
    const key = keyOf(m); if (!key) continue;
    if (detail[key] && detail[key].home && detail[key].home.xi && detail[key].home.xi.length >= 7) continue;  // already built (ESPN or AF)
    const fid = afState.map[key]; if (!fid) continue;
    if ((afState.tried[key] || 0) > now - 6 * 3600000) continue;                            // tried recently, back off
    if (made >= AF_RUN_CAP || afState.used + 4 > AF_LIMIT) { console.log('api-football: run/quota cap reached (' + afState.used + '/' + AF_LIMIT + ')'); break; }
    afState.tried[key] = now;
    try {
      const d = await buildAFMatch(fid);
      if (d && (d.home.xi.length || d.away.xi.length || d.teamStats.length || d.events.length)) { detail[key] = d; made++; }
    } catch (e) { console.error('api-football detail ' + key + ' failed:', e.message); if (/HTTP 429|quota|rate|requests/i.test(e.message)) break; }
  }
  console.log('api-football: built ' + made + ' detail page(s); used ' + afState.used + '/' + AF_LIMIT + ' requests today');
}

if (ofMatches.length) {   // fallback: fills only matches API-Football has not already covered
  try {
    if (!TSDB_LEAGUE) {
      try { const all = await getJSON(TSDB('all_leagues.php')); const L = (all.leagues || []).find(l => /world cup/i.test(l.strLeague || '') && /soccer/i.test(l.strSport || '')); if (L) TSDB_LEAGUE = L.idLeague; } catch {}
    }
    let events = [];
    if (TSDB_LEAGUE) {
      for (const season of ['2026', '2026-2026']) {
        try { const j = await getJSON(TSDB('eventsseason.php?id=' + TSDB_LEAGUE + '&s=' + season)); if (j && j.events && j.events.length) { events = j.events; break; } } catch {}
      }
    }
    console.log(`thesportsdb: league ${TSDB_LEAGUE || '(none)'}, ${events.length} season event(s)`);

    // played matches we care about (group + knockout) with a usable key
    const played = ofMatches.filter(m => m.score && m.score.ft && m.score.ft.length === 2);
    let enriched = 0;
    for (const m of played) {
      const t1 = canon(m.team1), t2 = canon(m.team2);
      const key = m.num != null ? String(m.num) : (fixtureFor(t1, t2) || [])[0];
      if (!key) continue;
      if (detail[key] && detail[key].teamStats && detail[key].teamStats.length) continue;   // already enriched
      // find the TheSportsDB event for this match
      const ev = events.find(e => {
        const a = canon(e.strHomeTeam), b = canon(e.strAwayTeam);
        const samePair = pair(a, b) === pair(t1, t2);
        const closeDate = m.date && e.dateEvent ? Math.abs(Date.parse(e.dateEvent) - Date.parse(m.date)) <= 2 * 86400000 : true;
        return samePair && closeDate;
      });
      if (!ev) continue;
      const homeIsT1 = canon(ev.strHomeTeam) === t1;
      let full = ev;
      try { const fe = await getJSON(TSDB('lookupevent.php?id=' + ev.idEvent)); await sleep(200); if (fe && fe.events && fe.events[0]) full = fe.events[0]; } catch {}
      const home = await buildSide(full, true, homeIsT1 ? m.team1 : m.team2, ev.idHomeTeam);
      const away = await buildSide(full, false, homeIsT1 ? m.team2 : m.team1, ev.idAwayTeam);
      const d = { home, away, events: [], teamStats: [] };
      try {
        const sj = await getJSON(TSDB('lookupeventstats.php?id=' + ev.idEvent)); await sleep(300);
        for (const s of (sj.eventstats || [])) if (s.strStat) d.teamStats.push({ label: s.strStat, h: s.intHome, a: s.intAway });
      } catch {}
      // goal/card parse from the event record, if present ("17':Name;90+4':Name (Own Goal)")
      const parseEv = (str, team, type) => String(str || '').split(';').map(x => x.trim()).filter(Boolean).forEach(x => {
        const mm = /(\d+)(\+\d+)?['’]?\s*:?\s*(.+)/.exec(x); if (!mm) return;
        const ev2 = { min: +mm[1], team, type };
        if (mm[2]) ev2.minx = mm[2];
        let player = mm[3].trim();
        if (type === 'goal') { if (/\bpen(alty)?\b/i.test(x)) ev2.pen = true; if (/own[\s-]?goal|\(og\)/i.test(x)) ev2.og = true; }
        ev2.player = player.replace(/\((pen(alty)?|o\.?g\.?|own[\s-]?goal|assist[^)]*)\)/ig, '').replace(/\s{2,}/g, ' ').trim();
        d.events.push(ev2);
      });
      parseEv(homeIsT1 ? ev.strHomeGoalDetails : ev.strAwayGoalDetails, 'home', 'goal');
      parseEv(homeIsT1 ? ev.strAwayGoalDetails : ev.strHomeGoalDetails, 'away', 'goal');
      parseEv(homeIsT1 ? ev.strHomeYellowCards : ev.strAwayYellowCards, 'home', 'card');
      parseEv(homeIsT1 ? ev.strAwayYellowCards : ev.strHomeYellowCards, 'away', 'card');
      parseEv(homeIsT1 ? ev.strHomeRedCards : ev.strAwayRedCards, 'home', 'red');
      parseEv(homeIsT1 ? ev.strAwayRedCards : ev.strHomeRedCards, 'away', 'red');
      d.events.sort((a, b) => (a.min || 0) - (b.min || 0));
      if (home.xi.length || away.xi.length || d.teamStats.length || d.events.length) { detail[key] = d; enriched++; }
    }
    console.log(`thesportsdb: enriched ${enriched} match detail page(s)`);
  } catch (e) { console.error('thesportsdb enrichment skipped:', e.message); }
}

/* ===================== 5) write data.json ===================== */
// Overlay accurate positions from the Fox bios (team-info.json) onto lineup players.
// The lineup feeds often give a generic position that mislabels players as midfielders;
// the Fox bio carries the real one. Match by normalised name within each team.
(function applyFoxPositions(){
  let TI=null;
  try { if (existsSync(join(ROOT, 'data', 'team-info.json'))) TI = JSON.parse(readFileSync(join(ROOT, 'data', 'team-info.json'), 'utf8')); } catch {}
  if (!TI || !TI.players) return;
  const _n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  // team (normalised) -> { playerName(normalised) -> pos letter }
  const byTeam = {};
  for (const k of Object.keys(TI.players)) {
    const p = TI.players[k]; if (!p || !p.pos) continue;
    const tm = _n(p.team || ''); if (!tm) continue;
    (byTeam[tm] = byTeam[tm] || {})[_n(p.name || '')] = String(p.pos).toUpperCase().slice(0, 1);
  }
  let fixed = 0;
  for (const key of Object.keys(detail)) {
    const dd = detail[key]; if (!dd) continue;
    ['home', 'away'].forEach(sd => {
      const side = dd[sd]; if (!side || !side.name) return;
      const map = byTeam[_n(side.name)]; if (!map) return;
      [...(side.xi || []), ...(side.subs || [])].forEach(pl => {
        const fp = map[_n(pl.name || '')];
        if (fp && /^[GDMF]$/.test(fp) && fp !== (pl.pos || '').toUpperCase().slice(0, 1)) { pl.pos = fp; fixed++; }
      });
    });
  }
  if (fixed) console.log('positions: corrected ' + fixed + ' lineup player position(s) from Fox bios');
})();
// Resolve managers and inject manager bookings onto every match. Runs each build
// so edits to managers.json take effect without forcing a detail re-fetch.
// Names are matched accent-insensitively so ASCII keys ("Curacao") hit accented
// names ("Curaçao").
const _mgrNorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
// Global fixture order by kickoff, so spell windows bounded by fixture ids work.
const _fxOrder = {}; (FIXTURES || []).slice().sort((a, b) => Date.parse(a[3]) - Date.parse(b[3])).forEach((f, i) => { _fxOrder[String(f[0])] = i; });
const _ord = id => (id != null && _fxOrder[String(id)] != null) ? _fxOrder[String(id)] : null;
// teams index keyed by normalised name -> array of spells
const MGR_TEAMS = {}; for (const k of Object.keys(MGR_DOC.teams || {})) MGR_TEAMS[_mgrNorm(k)] = MGR_DOC.teams[k];
// pick the spell whose [from,to] window contains the given fixture
function managerFor(teamName, fixtureKey) {
  const spells = MGR_TEAMS[_mgrNorm(teamName)]; if (!spells || !spells.length) return null;
  const fi = _ord(fixtureKey);
  if (fi == null) return spells[spells.length - 1];   // unknown fixture: latest spell
  for (const sp of spells) {
    const lo = sp.from != null ? _ord(sp.from) : -Infinity;
    const hi = sp.to != null ? _ord(sp.to) : Infinity;
    if (fi >= lo && fi <= hi) return sp;
  }
  return spells[spells.length - 1];
}
// manager bookings grouped by fixture key
const MGR_CARDS_BY_FX = {}; (MGR_DOC.cards || []).forEach(c => { if (!c || !c.match) return; (MGR_CARDS_BY_FX[String(c.match)] = MGR_CARDS_BY_FX[String(c.match)] || []).push(c); });
for (const key of Object.keys(detail)) {
  const dd = detail[key]; if (!dd) continue;
  ['home', 'away'].forEach(sd => {
    const side = dd[sd]; if (!side || !side.name) return;
    const sp = managerFor(side.name, key);
    if (sp && sp.name) { side.coach = sp.name; if (sp.photo) side.coachPhoto = sp.photo; if (sp.url) side.coachUrl = sp.url; }
  });
  // inject manager bookings for this fixture
  (MGR_CARDS_BY_FX[key] || []).forEach(c => {
    const tnorm = _mgrNorm(c.team);
    const sd = (dd.home && _mgrNorm(dd.home.name) === tnorm) ? 'home' : ((dd.away && _mgrNorm(dd.away.name) === tnorm) ? 'away' : null);
    if (!sd) return;
    const side = dd[sd]; const mgrName = side.coach || (managerFor(c.team, key) || {}).name || '';
    const type = (c.type === 'red') ? 'red' : 'card';
    const ev = { min: (c.min != null ? c.min : 0), team: sd, type, player: mgrName, mgr: true };
    if (c.minx) ev.minx = c.minx; if (type === 'red' && c.sy) ev.sy = true;
    dd.events = dd.events || []; dd.events.push(ev); dd.events.sort((a, b) => (a.min || 0) - (b.min || 0));
  });
}
// self-clean: drop stored clips of kinds no longer configured for a typed/split source,
// so removing or relabelling a playlist takes effect next build instead of lingering.
const _typedKinds = {};
for (const f of FEEDS) { if (f.type) (_typedKinds[f.src]=_typedKinds[f.src]||new Set()).add(f.type); if (f.split) for (const r of f.split) (_typedKinds[f.src]=_typedKinds[f.src]||new Set()).add(r.type); }
let _pruned = 0;
for (const k of Object.keys(videos)) for (const s of Object.keys(videos[k])) { const keep=_typedKinds[s]; if(!keep) continue; for (const tp of Object.keys(videos[k][s])) if(!keep.has(tp)){ delete videos[k][s][tp]; _pruned++; } if(!Object.keys(videos[k][s]).length) delete videos[k][s]; }
if (_pruned) console.log(`pruned ${_pruned} orphaned highlight link(s) from removed/relabelled playlists`);

// measure real clip lengths (seconds) for any video not already timed, in one batched pass, so
// cards can show actual durations instead of a per-kind guess; forget timings for vanished clips.
if (KEY) {
  const _ids = new Set();
  for (const k of Object.keys(videos)) for (const sx of Object.keys(videos[k])) for (const tp of Object.keys(videos[k][sx])) { const vid = videos[k][sx][tp]; if (vid) _ids.add(vid); }
  const _missing = [..._ids].filter(vid => durations[vid] == null);
  let _timed = 0;
  for (let i = 0; i < _missing.length; i += 50) {
    try { const vj = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=' + _missing.slice(i, i + 50).join(',') + '&key=' + encodeURIComponent(KEY)); for (const it of (vj.items || [])) { durations[it.id] = parseDur(it.contentDetails && it.contentDetails.duration); _timed++; } }
    catch (e) { console.error('duration fetch failed:', e.message); break; }
  }
  for (const vid of Object.keys(durations)) if (!_ids.has(vid)) delete durations[vid];
  if (_missing.length) console.log(`durations: measured ${_timed} new clip(s), ${_ids.size} total`);
}

const out = {
  generatedAt: new Date().toISOString(),
  lastDeep: deep ? new Date().toISOString() : (prev.lastDeep || null),
  videos, durations, detail, ofMatches, afState, espnMap: prev.espnMap || {}, channelUploads
};
writeFileSync(join(ROOT, 'data', 'data.json'), JSON.stringify(out));
const nVid = Object.values(videos).reduce((a, v) => a + Object.keys(v).length, 0);
console.log(`wrote data.json (${Object.keys(videos).length} matches with video, ${nVid} source-entries; ${Object.keys(detail).length} detail pages)`);
