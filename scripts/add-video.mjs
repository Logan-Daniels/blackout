#!/usr/bin/env node
// add-video.mjs — add one or more highlight URLs to data/video-overrides.json by hand, for clips a
// broadcaster never put in its playlist (or that sit on a different channel). It reads each video's
// title, works out which match it is the same way build-data does, and records it so every future
// build attaches it. It does not rebuild; run "node scripts/build-data.mjs" afterwards to apply.
//
// Usage:
//   node scripts/add-video.mjs nossport "https://www.youtube.com/watch?v=ZQ1IP0ZwewU"
//   node scripts/add-video.mjs nossport <url> <url> <url>
//   node scripts/add-video.mjs tsn <url> --match 73 --type x     # force the match key / clip type
//
// Match key: a group fixture id (e.g. B5) or a knockout number (e.g. 73). Type: r recap (default),
// x extended, g game-in-30. Keys: YouTube from keys/youtube.txt or YT_API_KEY.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const argv = process.argv.slice(2);
const opts = {}, positional = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { opts[a.slice(2)] = argv[i + 1]; i++; } else positional.push(a); }
const src = positional[0];
const urls = positional.slice(1);
if (!src || !urls.length) { console.error('Usage: node scripts/add-video.mjs <src> <youtube-url> [<url> ...] [--match KEY] [--type r|x|g]'); process.exit(1); }
const forcedMatch = opts.match;
const forcedType = opts.type || 'r';

const here = dirname(fileURLToPath(import.meta.url));
const findIn = (n, dirs) => { for (const d of dirs) { const p = join(d, n); if (existsSync(p)) return p; } return null; };
const ROOT = dirname(findIn('index.html', [join(here, '..'), here, process.cwd()]) || join(here, '..'));
const keyFile = (n) => { for (const d of [join(ROOT, 'keys'), join(here, 'keys'), join(process.cwd(), 'keys')]) { const f = join(d, n + '.txt'); if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } return ''; };
const KEY = process.env.YT_API_KEY || keyFile('youtube');
const fixturesPath = findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT]);
const ovPath = join(ROOT, 'data', 'video-overrides.json');
if (!fixturesPath) { console.error('Cannot find wc-fixtures.json.'); process.exit(1); }
if (!KEY && !forcedMatch) { console.error('Need a YouTube key (keys/youtube.txt or YT_API_KEY) to read titles, or pass --match to skip lookup.'); process.exit(1); }

const cfg = JSON.parse(readFileSync(fixturesPath, 'utf8'));
const ALIASES = cfg.aliases, FIXTURES = cfg.fixtures;

// --- matching primitives, identical to build-data ---
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ALIAS_RX = [];
for (const team of Object.keys(ALIASES)) for (const a of ALIASES[team]) { let n = norm(a).replace(/[.'’&]/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'); ALIAS_RX.push({ team, rx: new RegExp('\\b' + n + '\\b') }); }
const teamsInText = text => { const n = norm(text).replace(/[.'’&]/g, ' '); const f = []; for (const { team, rx } of ALIAS_RX) if (f.indexOf(team) < 0 && rx.test(n)) f.push(team); return f; };
const canon = name => teamsInText(name)[0] || name;
const pair = (a, b) => [a, b].sort().join('~');
const fixtureFor = (t1, t2) => FIXTURES.find(m => (m[1] === t1 && m[2] === t2) || (m[1] === t2 && m[2] === t1));
function roundOfTitle(title) {
  const n = norm(title);
  if (/final/.test(n) && !/semi|quarter|1\/2|1\/4/.test(n)) return 'F';
  if (/semi|1\/2/.test(n)) return 'SF';
  if (/quarter|1\/4/.test(n)) return 'QF';
  if (/round of 16|last 16|1\/8|r16/.test(n)) return 'R16';
  if (/round of 32|1\/16|r32|play-?off/.test(n)) return 'R32';
  return 'GROUP';
}
const koNumByPair = {};
async function getJSON(url) { const r = await fetch(url); if (!r.ok) { let d = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error && j.error.message) d = j.error.message; } catch {} throw new Error(d); } return r.json(); }
async function loadKO() {
  try { const of = await getJSON('https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json'); for (const m of (of.matches || [])) if (m.num != null) koNumByPair[pair(canon(m.team1), canon(m.team2))] = String(m.num); } catch (e) { console.error('(could not load knockout numbers: ' + e.message + ')'); }
}
// resolve a match key from the two teams + round, ignoring the played/started timing guard (you are
// adding a clip you know exists). Group -> fixture id; knockout -> openfootball number.
function resolveKey(teams, round) {
  if (round === 'GROUP') { const m = fixtureFor(teams[0], teams[1]); return m ? m[0] : null; }
  return koNumByPair[pair(teams[0], teams[1])] || null;
}
const videoId = u => { u = String(u).trim(); let m; if ((m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(u))) return m[1]; if ((m = /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(u))) return m[1]; if ((m = /\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/.exec(u))) return m[1]; if (/^[A-Za-z0-9_-]{11}$/.test(u)) return u; return null; };
async function titleOf(id) { const j = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + id + '&key=' + encodeURIComponent(KEY)); const it = (j.items || [])[0]; return it && it.snippet ? it.snippet.title : null; }

const ids = urls.map(videoId);
if (ids.some(x => !x)) { console.error('Could not read a video id from: ' + urls.filter((_, i) => !ids[i]).join(', ')); process.exit(1); }
if (!forcedMatch && ids.length) await loadKO();

const resolved = [];
for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  let key = forcedMatch || null, title = '';
  if (!key) {
    try { title = await titleOf(id) || ''; } catch (e) { console.error(`  ${id}: title lookup failed (${e.message})`); }
    const teams = teamsInText(title); const round = roundOfTitle(title);
    if (teams.length === 2) key = resolveKey(teams, round);
    if (!key) { console.error(`  ${id}: could not resolve a match from "${title}" (teams: ${teams.join(', ') || 'none'}). Re-run with --match KEY.`); continue; }
  }
  console.log(`  ${id} -> ${key}${title ? '   (' + title + ')' : ''}`);
  resolved.push({ match: String(key), src, type: forcedType, id });
}
if (!resolved.length) { console.error('Nothing resolved; nothing written.'); process.exit(1); }

// merge into data/video-overrides.json, de-duplicating on src+id
let doc = { _README: 'Manually-added highlight links, applied on every build after crawling. Add with: node scripts/add-video.mjs <src> <url> ...', videos: [] };
if (existsSync(ovPath)) { try { const cur = JSON.parse(readFileSync(ovPath, 'utf8')); if (cur && Array.isArray(cur.videos)) doc = cur; else if (Array.isArray(cur)) doc.videos = cur; } catch (e) { console.error('Existing video-overrides.json is not valid JSON: ' + e.message); process.exit(1); } }
let added = 0, updated = 0;
for (const e of resolved) {
  const j = doc.videos.findIndex(x => x.src === e.src && x.id === e.id);
  if (j >= 0) { if (doc.videos[j].match !== e.match || doc.videos[j].type !== e.type) { doc.videos[j] = e; updated++; } }
  else { doc.videos.push(e); added++; }
}
writeFileSync(ovPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nvideo-overrides.json: ${added} added, ${updated} updated, ${doc.videos.length} total.`);
console.log('Apply with:  node scripts/build-data.mjs   (then hard-refresh).');
