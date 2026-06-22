#!/usr/bin/env node
/*
 * build-rosters.mjs  ·  resolves the EXACT Fox player-page URL for every player,
 * by scraping each team's Fox roster page, and writes fox-urls.json.
 *
 * Why: Fox's URL slug often differs from the player's common name (middle names,
 * alternate spellings, "-2" suffixes, sometimes a different name entirely), so
 * guessing the slug fails. The roster page lists every player with the real link.
 * We grab every /soccer/<slug>-player link off the page and, in build-players,
 * match each squad member to the slug that contains their surname.
 *
 * Run AFTER build-data.mjs and BEFORE (or alongside) build-players.mjs:
 *     node scripts/build-rosters.mjs
 * It only fetches one page per team (~38 requests), so it's light on Fox's limit.
 * Re-runnable: it merges, keeping teams already resolved.
 *
 * If a team logs "FAILED (check slug)", Fox uses a different URL for that nation:
 * find it on foxsports.com (e.g. .../south-korea-men-team-roster) and add it to
 * TEAM_SLUG below as  "<Team name from the log>": "<their-slug>-men".
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DATA = 'data.json', OUT = 'fox-urls.json';
const FOX = 'https://www.foxsports.com/soccer/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BLOCK_RX = /incapsula|request unsuccessful|access denied|distil|captcha|unusual traffic|you have been blocked|too many requests/i;
const HEAD_RX = /https?:\/\/b\.fssta\.com\/uploads\/application\/soccer\/headshots\/\d+(?:\.vresize\.\d+\.\d+\.[a-z]+\.\d+)?\.png/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ESPN team name -> Fox roster slug, only for nations where "<slug>-men" is wrong.
// Add entries here when a team logs FAILED. (Leave as-is otherwise.)
const TEAM_SLUG = {
  "Bosnia and Herzegovina": "bosnia-herzegovina-men",
  "Cabo Verde": "cape-verde-men",
  "Czechia": "czech-republic-men",
  "Côte d'Ivoire": "cote-divoire-men",
  "South Korea": "korea-republic-men",
  "Türkiye": "turkey-men",
};

if (!existsSync(DATA)) { console.error('rosters: ' + DATA + ' not found. Run build-data.mjs first.'); process.exit(1); }
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const out = prev.teams || {};

// teams that actually have squads in the data
const teams = new Set();
for (const k of Object.keys(data.detail || {})) for (const sk of ['home', 'away']) {
  const s = data.detail[k][sk]; if (s && s.name && ((s.xi || []).length || (s.subs || []).length)) teams.add(s.name);
}

// pull every unique player link off the page with its display name (the anchor's
// text, which is the player's CURRENT name even when the slug is unrelated), the
// Fox athlete id (from data-uri, used to build the headshot), and any nearby photo.
function parseRoster(html) {
  const reA = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const bySlug = new Map();
  let m;
  while ((m = reA.exec(html))) {
    const attrs = m[1], inner = m[2];
    const hm = attrs.match(/href="((?:https?:\/\/[^"]*)?\/soccer\/([a-z0-9-]+)-player)"/i);
    if (!hm) continue;
    const slug = hm[2];
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();   // name cell -> player's name; other cells -> "F"/"26"
    const fm = attrs.match(/data-uri="[^"]*athletes\/(\d+)"/i);
    const hh = (inner.match(HEAD_RX) || m[0].match(HEAD_RX));
    const cur = bySlug.get(slug) || { slug, url: FOX + slug + '-player', name: '', fid: null, head: null };
    if (text && /[a-z]/i.test(text) && text.length > cur.name.length && text.length < 60) cur.name = text;
    if (fm && !cur.fid) cur.fid = fm[1];
    if (hh && !cur.head) cur.head = hh[0];
    bySlug.set(slug, cur);
  }
  return [...bySlug.values()];
}

let cool = 0;
async function getRoster(url) {
  let backoff = 800;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (cool) await sleep(cool);
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }); }
    catch (e) { cool = Math.min(cool + 700, 5000); if (attempt < 3) await sleep(backoff); backoff *= 2; continue; }
    if (r.status === 404) return { status: 404 };
    if (r.status === 429 || r.status === 403 || r.status >= 500 || !r.ok) { cool = Math.min(cool + 700, 5000); if (attempt < 3) await sleep(backoff); backoff *= 2; continue; }
    const html = await r.text();
    if (html.length < 1500 || (html.length < 15000 && BLOCK_RX.test(html))) { cool = Math.min(cool + 700, 5000); if (attempt < 3) await sleep(backoff); backoff *= 2; continue; }  // genuine block walls are tiny; don't scan a full page
    cool = Math.max(0, cool - 700);
    return { status: 200, html };
  }
  return { status: 0 };
}

const names = [...teams].sort();
console.log('rosters: resolving Fox URLs for ' + names.length + ' teams...');
let okTeams = 0, failed = [];
for (const team of names) {
  if (out[team] && (out[team].players || []).length) { okTeams++; continue; } // already done; re-run only fills gaps
  const tslug = TEAM_SLUG[team] || (slug(team) + '-men');
  const url = FOX + tslug + '-team-roster';
  const res = await getRoster(url);
  await sleep(500);
  if (res.status !== 200) { failed.push(team); console.log('  ' + team + ' (' + tslug + '): FAILED (check slug) [' + res.status + ']'); continue; }
  const players = parseRoster(res.html);
  if (!players.length) { failed.push(team); console.log('  ' + team + ' (' + tslug + '): 0 player links found (page format?)'); continue; }
  const ids = players.filter(p => p.fid).length, named = players.filter(p => p.name).length;
  out[team] = { slug: tslug, players };
  okTeams++;
  console.log('  ' + team + ': ' + players.length + ' players, ' + named + ' named, ' + ids + ' with photo IDs');
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), teams: out }));
console.log('rosters: wrote ' + OUT + ' for ' + okTeams + '/' + names.length + ' teams.' +
  (failed.length ? ' Needs a slug override (add to TEAM_SLUG, then re-run): ' + failed.join(', ') : ' All teams resolved.'));
