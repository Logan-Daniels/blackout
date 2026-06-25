#!/usr/bin/env node
/*
 * photo-overrides.mjs - fill missing player headshots by pasting Fox PAGE urls.
 * Run from the project root (alongside players.json / photos-extra.json).
 *
 *   node scripts/photo-overrides.mjs --list       print every squad player with no Fox photo
 *   node scripts/photo-overrides.mjs --skeleton   write/refresh photo-overrides.json: every such
 *                                                 player grouped by country, alphabetical, each with
 *                                                 a blank "fox_url" to fill in
 *   node scripts/photo-overrides.mjs              read photo-overrides.json, FETCH each filled Fox
 *                                                 page, scrape its headshot image, and merge it into
 *                                                 photos-extra.json (skips ones already done;
 *                                                 add --force to redo them)
 *
 * You only paste the player's Fox PAGE url, e.g. https://www.foxsports.com/soccer/raphinha-player
 * (Fox's slug can be unrelated to the name - that's fine, the page is what matters). The script
 * pulls the b.fssta.com/.../headshots/NNNN.png image off the page exactly like build-players does
 * and stores it under a team-scoped "country|name" key, which always wins over a guessed photo.
 * A direct b.fssta headshot url is also accepted and used as-is.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const PLAYERS = 'data/players.json', PHOTOX = 'data/photos-extra.json', OVR = 'photo-overrides.json';
const HEADSHOT_RX = /https?:\/\/b\.fssta\.com\/uploads\/application\/soccer\/headshots\/\d+(?:\.vresize\.\d+\.\d+\.[a-z]+\.\d+)?\.png/gi;
const PAGE_RX = /^https?:\/\/(?:www\.)?foxsports\.com\/soccer\/[a-z0-9-]+-player\/?$/i;
const BLOCK_RX = /incapsula|request unsuccessful|access denied|distil|captcha|unusual traffic|you have been blocked|cf-browser-verification|too many requests/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nrm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const key = (team, name) => nrm(team) + '|' + nrm(name);
const isHeadshot = u => { HEADSHOT_RX.lastIndex = 0; return /^https?:\/\/b\.fssta\.com\//i.test(u) && HEADSHOT_RX.test(u); };

if (!existsSync(PLAYERS)) { console.error(PLAYERS + ' not found - run from the project root.'); process.exit(1); }
const teams = JSON.parse(readFileSync(PLAYERS, 'utf8')).teams || {};

function noFoxByCountry() {
  const by = {};
  for (const tm of Object.keys(teams)) for (const p of (teams[tm].players || []))
    if (p.src !== 'fox') (by[tm] = by[tm] || []).push({ name: (p.name || '').trim(), pos: p.pos || '' });
  for (const tm of Object.keys(by)) by[tm].sort((a, b) => a.name.localeCompare(b.name));
  return by;
}

const arg = (process.argv[2] || '').toLowerCase();
const force = process.argv.includes('--force');

if (arg === '--list') {
  const by = noFoxByCountry(); let n = 0;
  Object.keys(by).sort().forEach(tm => { n += by[tm].length; console.log('  ' + tm.padEnd(16) + '(' + by[tm].length + '): ' + by[tm].map(p => p.name).join(', ')); });
  console.log('\n' + n + ' players with no Fox photo.');
  process.exit(0);
}

if (arg === '--skeleton') {
  let prev = {};
  if (existsSync(OVR)) { try { prev = JSON.parse(readFileSync(OVR, 'utf8')); } catch (e) {} }
  const prevUrl = {};
  for (const tm of Object.keys(prev)) if (Array.isArray(prev[tm])) for (const p of prev[tm]) if (p && p.name) prevUrl[key(tm, p.name)] = p.fox_url || '';
  const by = noFoxByCountry();
  const out = { _README: 'Paste each player\u2019s Fox PAGE url into "fox_url", e.g. https://www.foxsports.com/soccer/raphinha-player , then run: node scripts/photo-overrides.mjs  (it fetches the page and scrapes the headshot image). Leave blank to skip. Filled entries are kept when you re-run --skeleton.' };
  let kept = 0;
  for (const tm of Object.keys(by).sort()) out[tm] = by[tm].map(p => { const u = prevUrl[key(tm, p.name)] || ''; if (u) kept++; return { name: p.name, pos: p.pos, fox_url: u }; });
  writeFileSync(OVR, JSON.stringify(out, null, 2) + '\n');
  const total = Object.keys(by).reduce((a, tm) => a + by[tm].length, 0);
  console.log('wrote ' + OVR + ': ' + total + ' players across ' + Object.keys(by).length + ' countries (' + kept + ' already have a url). Paste Fox page URLs, then run with no flag.');
  process.exit(0);
}

// default: fetch + scrape + merge
if (!existsSync(OVR)) { console.error('No ' + OVR + ' found. Run with --skeleton first.'); process.exit(1); }
const ovr = JSON.parse(readFileSync(OVR, 'utf8'));
const px = existsSync(PHOTOX) ? JSON.parse(readFileSync(PHOTOX, 'utf8')) : {};
px.photos = px.photos || {};

// fetch one Fox page, return its headshot url, null (no headshot / 404), or 'throttle'.
// mirrors build-players foxTry minus the surname check (you picked the page deliberately).
async function scrape(url) {
  let backoff = 700;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }); }
    catch (e) { if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    if (r.status === 404) return null;
    if (r.status === 429 || r.status === 403 || r.status >= 500 || !r.ok) { if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    const html = await r.text();
    if (html.length < 1500 || (html.length < 15000 && BLOCK_RX.test(html))) { if (attempt < 2) await sleep(backoff); backoff *= 2; continue; }
    HEADSHOT_RX.lastIndex = 0;
    const m = html.match(HEADSHOT_RX);
    if (m && m.length) return m.find(u => /vresize/.test(u)) || m[0];
    return null;
  }
  return 'throttle';
}

const jobs = [];
for (const tm of Object.keys(ovr)) {
  if (tm.startsWith('_') || !Array.isArray(ovr[tm])) continue;
  for (const p of ovr[tm]) { if (!p || !p.name) continue; const u = String(p.fox_url || '').trim(); if (u) jobs.push({ tm, name: p.name, url: u }); }
}

let done = 0, skipped = 0; const failed = [];
console.log(jobs.length + ' filled url(s) to process...');
for (const j of jobs) {
  const k = key(j.tm, j.name);
  if (!force && isHeadshot(px.photos[k] || '')) { skipped++; continue; }
  let head = null;
  if (isHeadshot(j.url)) head = j.url;
  else if (PAGE_RX.test(j.url)) {
    const res = await scrape(j.url);
    if (res === 'throttle') { failed.push(j.tm + ' / ' + j.name + ' (rate-limited, re-run)'); await sleep(1500); continue; }
    head = res; await sleep(300);
  } else { failed.push(j.tm + ' / ' + j.name + ' (not a Fox page or headshot url: ' + j.url + ')'); continue; }
  if (head) { px.photos[k] = head; done++; }
  else failed.push(j.tm + ' / ' + j.name + ' (no headshot found on page)');
}

writeFileSync(PHOTOX, JSON.stringify(px, null, 2) + '\n');
console.log('\nmerged ' + done + ' headshot(s) into ' + PHOTOX + (skipped ? ', skipped ' + skipped + ' already done' : '') + (failed.length ? ', ' + failed.length + ' failed:' : '.'));
failed.forEach(f => console.log('  ' + f));
if (failed.some(f => /rate-limited/.test(f))) console.log('Re-run to retry the rate-limited ones.');
