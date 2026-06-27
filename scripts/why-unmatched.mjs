#!/usr/bin/env node
// why-unmatched.mjs — explain why a highlight source is short of matches.
//
// It crawls one source's playlist (back to the tournament start) and runs each
// title through the SAME two gates build-data.mjs uses:
//   1. the "looks like a highlight" gate in classify()  (highlight/resume/faits
//      saillants/temps forts — English and French only), and
//   2. teamsInText(), which only knows the team names listed in
//      data/wc-fixtures.json "aliases" (English, French, Spanish, German).
// A title has to clear both to be attached to a fixture. The script prints, per
// video, whether each gate passed, then lists the played group matches this
// source has no clip for. It is read-only: it does not touch any file.
//
// Usage:
//   node scripts/why-unmatched.mjs <src-key>            # e.g. nossport, orfsport (key must be in wc-fixtures playlists)
//   node scripts/why-unmatched.mjs <playlist-id> --src <key>
//   flags: --src <key>, --all (print every title, not just the dropped ones)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const argv = process.argv.slice(2);
const opts = {}, positional = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); if (k === 'all') opts.all = true; else { opts[k] = argv[i + 1]; i++; } } else positional.push(a); }
const here = dirname(fileURLToPath(import.meta.url));
const findIn = (n, dirs) => { for (const d of dirs) { const p = join(d, n); if (existsSync(p)) return p; } return null; };
const ROOT = dirname(findIn('index.html', [join(here, '..'), here, process.cwd()]) || join(here, '..'));
const keyFile = (n) => { for (const d of [join(ROOT, 'keys'), join(here, 'keys'), join(process.cwd(), 'keys')]) { const f = join(d, n + '.txt'); if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } return ''; };
const KEY = process.env.YT_API_KEY || keyFile('youtube');
if (!KEY) { console.error('Need a YouTube key (keys/youtube.txt or YT_API_KEY).'); process.exit(1); }

const cfg = JSON.parse(readFileSync(findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT]), 'utf8'));
const ALIASES = cfg.aliases, FIXTURES = cfg.fixtures, PLAYLISTS = cfg.playlists || {};
const arg = positional[0];
if (!arg) { console.error('Usage: node scripts/why-unmatched.mjs <src-key|playlist-id> [--src key] [--all]'); process.exit(1); }
const src = opts.src || arg;
const playlistId = PLAYLISTS[arg] || (/[?&]list=([A-Za-z0-9_-]+)/.exec(arg) || [])[1] || arg;

const TOURNAMENT_START = Date.parse('2026-06-11T00:00:00-04:00');
const MATCH_END_BUFFER = 120 * 60000;
const now = Date.now();

// ---- exact copies of build-data's matching primitives ----
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ALIAS_RX = [];
for (const team of Object.keys(ALIASES)) for (const a of ALIASES[team]) {
  let n = norm(a).replace(/[.'’&]/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  ALIAS_RX.push({ team, rx: new RegExp('\\b' + n + '\\b') });
}
function teamsInText(text) { const n = norm(text).replace(/[.'’&]/g, ' '); const found = []; for (const { team, rx } of ALIAS_RX) if (found.indexOf(team) < 0 && rx.test(n)) found.push(team); return found; }
const isHighlight = title => /highlight|résum|resum|faits saillants|temps forts|samenvatting|zusammenfassung|melhores momentos|destaques|gli highlights|sintesi/.test(norm(title));  // keep in sync with build-data HL_RX
const parseDur = iso => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };

async function getJSON(url) { const r = await fetch(url); if (!r.ok) { let d = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error && j.error.message) d = j.error.message; } catch {} throw new Error(d); } return r.json(); }

// ---- crawl the playlist back to the tournament start (same stop rule as build-data) ----
const vids = [];
let pageToken = '', pages = 0;
do {
  const pl = await getJSON('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + playlistId + '&key=' + encodeURIComponent(KEY) + (pageToken ? '&pageToken=' + pageToken : ''));
  const items = pl.items || [];
  const ids = items.map(it => it.contentDetails && it.contentDetails.videoId).filter(Boolean);
  if (ids.length) { const vj = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=' + ids.join(',') + '&key=' + encodeURIComponent(KEY)); for (const it of (vj.items || [])) vids.push({ title: (it.snippet && it.snippet.title) || '', dur: parseDur(it.contentDetails && it.contentDetails.duration) }); }
  pageToken = pl.nextPageToken || ''; pages++;
  const oldest = Math.min(...items.map(it => Date.parse((it.contentDetails && it.contentDetails.videoPublishedAt) || (it.snippet && it.snippet.publishedAt))).filter(n => !isNaN(n)).concat([Infinity]));
  if (oldest < TOURNAMENT_START) break;
} while (pageToken && pages < 100);

// ---- classify each title ----
let okHL = 0, ok2 = 0;
const droppedNotHL = [], droppedTeams = [];
const matchedPairs = new Set();
for (const v of vids) {
  const hl = isHighlight(v.title);
  const teams = teamsInText(v.title);
  if (opts.all) console.log(`[HL ${hl ? '✓' : '✗'}] [teams ${teams.length}${teams.length ? ': ' + teams.join(', ') : ''}] ${v.title}`);
  if (!hl) { droppedNotHL.push(v.title); continue; }
  okHL++;
  if (teams.length === 2) { ok2++; matchedPairs.add([teams[0], teams[1]].sort().join(' v ')); }
  else droppedTeams.push({ title: v.title, teams });
}

console.log(`\n=== ${src}  (playlist ${playlistId}) ===`);
console.log(`crawled ${vids.length} video(s) back to the tournament start`);
console.log(`  ${okHL} passed the highlight gate, ${ok2} of those named exactly two known teams`);
console.log(`  dropped: ${droppedNotHL.length} not recognised as highlights, ${droppedTeams.length} highlights whose team names are not in the alias table`);

if (droppedNotHL.length) { console.log(`\nNot recognised as highlights (classify gate) — first ${Math.min(12, droppedNotHL.length)}:`); droppedNotHL.slice(0, 12).forEach(t => console.log('  · ' + t)); }
if (droppedTeams.length) { console.log(`\nHighlights with unrecognised team names — first ${Math.min(12, droppedTeams.length)}:`); droppedTeams.slice(0, 12).forEach(d => console.log(`  · [found: ${d.teams.join(', ') || 'none'}] ${d.title}`)); }

// ---- which played group matches has this source NOT supplied? ----
let data = {}; const dp = findIn('data.json', [join(ROOT, 'data'), ROOT]); if (dp) { try { data = JSON.parse(readFileSync(dp, 'utf8')); } catch {} }
const videos = data.videos || {};
const gaps = [];
for (const fx of FIXTURES) {
  const [fid, home, away, kickoff] = fx;
  if (!/^[A-L][1-9]$/.test(fid)) continue;            // group fixtures only (KO not checked here)
  const played = !isNaN(Date.parse(kickoff)) && (Date.parse(kickoff) + MATCH_END_BUFFER) <= now;
  if (!played) continue;
  const has = videos[fid] && videos[fid][src];
  if (!has) gaps.push(`${fid}  ${home} v ${away}`);
}
console.log(`\nPlayed group matches with NO ${src} clip in data.json: ${gaps.length}`);
gaps.forEach(g => console.log('  · ' + g));
console.log('\n(KO matches are not checked here; they only start 28 Jun. "Highlights with unrecognised team names" above is the list to fix by adding aliases.)');
