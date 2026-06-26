#!/usr/bin/env node
// add-broadcaster.mjs — register a new broadcaster from a YouTube highlights
// playlist OR a channel, detecting almost everything automatically.
//
// Give it a playlist URL/id or a channel URL/@handle/id. It then:
//   1. reads the broadcaster name from the channel (no --name needed),
//   2. reads the brand colour from the logo file you have dropped in
//      images/broadcasters/<slug>-<hex>.png|svg (no --tint needed),
//   3. wires the feed into data/wc-fixtures.json and build-data.mjs,
//   4. runs build-data.mjs, deep-crawling ONLY this feed (DEEP_ONLY) while the
//      rest stay on the cheap regular crawl; the crawl already stops at the
//      tournament start, so a channel's uploads playlist stays bounded,
//   5. tests the first real highlight with the YouTube API for embeddability,
//      country restriction and audio language, and writes those into the
//      index.html SOURCES entry as linkOut / regions|blocked / lang (so the
//      broadcaster shows up in exactly the countries it is allowed in), and
//   6. if the clips cannot be embedded, asks Gemini whether the actual video
//      titles reveal scores, to pick the gentle (rds) or spoiler (fifa) warning.
//
// Keys: YouTube from keys/youtube.txt or YT_API_KEY; Gemini (only for the
// title check) from keys/gemini.txt, --gemini-key=, GEMINI_API_KEY.
//
// Usage:
//   node scripts/add-broadcaster.mjs "https://www.youtube.com/playlist?list=PL..."
//   node scripts/add-broadcaster.mjs "https://www.youtube.com/@SBSSport"      # a channel
//   node scripts/add-broadcaster.mjs PL... --name "SBS Sport"                 # override the name
//
// Optional overrides:
//   --name, --id, --lang, --tint hex, --regions CA,US, --blocked RU,
//   --linkout / --no-linkout, --warn rds|fifa, --logo <filename>, --ext png|svg,
//   --no-build, --no-ai, --gemini-key=, --model=, --force.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { videoStatus } from './yt-check.mjs';

const argv = process.argv.slice(2);
const BOOL = new Set(['linkout', 'no-linkout', 'no-ai', 'no-build', 'force']);
const opts = {}, positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else { const k = a.slice(2); if (BOOL.has(k)) opts[k] = true; else { opts[k] = argv[i + 1]; i++; } }
  } else positional.push(a);
}
const flag = n => opts[n] === true || opts[n] === 'true' || opts[n] === '';
const opt  = n => (typeof opts[n] === 'string' ? opts[n] : undefined);
const inputArg = positional[0];

let name = opt('name'), id = opt('id'), lang = opt('lang'), tint = opt('tint');
let ext = (opt('ext') || '').replace(/^\./, '');
const noAi = flag('no-ai'), noBuild = flag('no-build'), force = flag('force');
const linkoutFlag = flag('linkout') ? true : (flag('no-linkout') ? false : undefined);
const warnFlag = opt('warn');
const regionsFlag = (opt('regions') || '').toUpperCase().match(/[A-Z]{2}/g) || null;
const blockedFlag = (opt('blocked') || '').toUpperCase().match(/[A-Z]{2}/g) || null;
const logoFlag = opt('logo');
const model = opt('model') || 'gemini-2.5-flash';
const keyFile = (n) => { try { const h = dirname(fileURLToPath(import.meta.url)); for (const d of [join(h, '..', 'keys'), join(h, 'keys'), join(process.cwd(), 'keys')]) { const f = join(d, n + '.txt'); if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } } catch {} return ''; };
const GEMINI_KEY = opt('gemini-key') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keyFile('gemini');
const YT_KEY = process.env.YT_API_KEY || keyFile('youtube');

if (!inputArg) {
  console.error('Usage: node scripts/add-broadcaster.mjs <playlist-or-channel-url> [--name "Name"] [--id key]');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const findIn = (n, dirs) => { for (const d of dirs) { const p = join(d, n); if (existsSync(p)) return p; } return null; };
const indexPath = findIn('index.html', [join(here, '..'), here, process.cwd()]);
if (!indexPath) { console.error('Cannot find index.html. Run this from inside the repo (or its scripts/ folder).'); process.exit(1); }
const ROOT = dirname(indexPath);
const buildPath = findIn('build-data.mjs', [here, ROOT, join(ROOT, 'scripts'), process.cwd()]);
const fixturesPath = findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT, here, join(ROOT, 'scripts'), process.cwd()]);
const dataPath = findIn('data.json', [join(ROOT, 'data'), ROOT, process.cwd()]);
for (const [p, n] of [[fixturesPath, 'wc-fixtures.json'], [buildPath, 'build-data.mjs']]) {
  if (!p) { console.error(`Cannot find ${n}. Run this from inside the repo.`); process.exit(1); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ytGet(path) {
  if (!YT_KEY) throw new Error('no YouTube API key (keys/youtube.txt or YT_API_KEY)');
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path + '&key=' + encodeURIComponent(YT_KEY));
  if (!r.ok) { let m = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error && j.error.message) m = j.error.message; } catch {} throw new Error(m); }
  return r.json();
}

// ---- decide whether the argument is a playlist or a channel ----
function parseInput(s) {
  s = String(s).trim();
  let m;
  if ((m = /[?&]list=([A-Za-z0-9_-]+)/.exec(s))) return { kind: 'playlist', id: m[1] };
  if ((m = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/.exec(s))) return { kind: 'channel', ref: { type: 'id', value: m[1] } };
  if ((m = /youtube\.com\/(@[A-Za-z0-9_.-]+)/.exec(s))) return { kind: 'channel', ref: { type: 'handle', value: m[1] } };
  if ((m = /youtube\.com\/user\/([A-Za-z0-9_.-]+)/.exec(s))) return { kind: 'channel', ref: { type: 'user', value: m[1] } };
  if ((m = /youtube\.com\/c\/([A-Za-z0-9_.%-]+)/.exec(s))) return { kind: 'channel', ref: { type: 'custom', value: decodeURIComponent(m[1]) } };
  if (/^@[A-Za-z0-9_.-]+$/.test(s)) return { kind: 'channel', ref: { type: 'handle', value: s } };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return { kind: 'channel', ref: { type: 'id', value: s } };
  if (/^(PL|UU|FL|OL|RD|LL)[A-Za-z0-9_-]{8,}$/.test(s)) return { kind: 'playlist', id: s };
  if (/^[A-Za-z0-9_-]{12,}$/.test(s)) return { kind: 'playlist', id: s };
  return null;
}
const input = parseInput(inputArg);
if (!input) { console.error(`Could not read a playlist or channel from "${inputArg}". Pass a playlist URL/id or a channel URL/@handle.`); process.exit(1); }

async function resolveChannel(ref) {
  let qs;
  if (ref.type === 'id') qs = 'id=' + encodeURIComponent(ref.value);
  else if (ref.type === 'handle') qs = 'forHandle=' + encodeURIComponent(ref.value);
  else if (ref.type === 'user') qs = 'forUsername=' + encodeURIComponent(ref.value);
  else { // custom /c/NAME has no direct lookup; resolve by search (costs more quota)
    const sr = await ytGet('search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(ref.value));
    const cid = sr.items && sr.items[0] && sr.items[0].id && sr.items[0].id.channelId;
    if (!cid) throw new Error('could not resolve channel "' + ref.value + '"');
    qs = 'id=' + encodeURIComponent(cid);
  }
  const j = await ytGet('channels?part=snippet,contentDetails&' + qs);
  const it = j.items && j.items[0];
  if (!it) throw new Error('channel not found');
  const uploads = it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads;
  if (!uploads) throw new Error('channel has no uploads playlist');
  return { uploads, title: (it.snippet && it.snippet.title) || null };
}
async function playlistChannel(plId) {
  const j = await ytGet('playlists?part=snippet&id=' + encodeURIComponent(plId));
  const s = j.items && j.items[0] && j.items[0].snippet;
  return s ? (s.channelTitle || s.title || null) : null;
}

let PL, channelTitle = null, fromChannel = false;
try {
  if (input.kind === 'playlist') { PL = input.id; if (YT_KEY && !name) channelTitle = await playlistChannel(PL); }
  else { fromChannel = true; const c = await resolveChannel(input.ref); PL = c.uploads; channelTitle = c.title; }
} catch (e) { console.error('YouTube lookup failed: ' + e.message); process.exit(1); }

name = (name || channelTitle || '').trim();
if (!name) { console.error('Could not read the channel name. Pass --name "Broadcaster Name" (or set keys/youtube.txt).'); process.exit(1); }
if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
if (!id) { console.error('Could not derive a key from the name; pass --id.'); process.exit(1); }

// ---- brand colour: read from the logo filename images/broadcasters/<slug>-<hex>.(png|svg) ----
const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const nameSlug = slug(name);
const broadcastersDir = join(ROOT, 'images', 'broadcasters');
function findLogo() {
  if (!existsSync(broadcastersDir)) return null;
  let files;
  try { files = readdirSync(broadcastersDir); } catch { return null; }
  if (logoFlag) { const want = logoFlag.replace(/^.*\//, ''); const f = files.find(x => x === want); if (f) return f; }
  const re = new RegExp('^' + nameSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-([0-9a-fA-F]{6})\\.(png|svg)$', 'i');
  return files.find(x => re.test(x)) || null;
}
if (!tint) {
  const f = findLogo();
  if (f) { const m = /-([0-9a-fA-F]{6})\.(png|svg)$/i.exec(f); tint = m[1].toLowerCase(); if (!ext) ext = m[2].toLowerCase(); }
}
if (!ext) ext = 'png';
if (!tint || !/^[0-9a-f]{6}$/.test(tint)) {
  console.error(`No brand colour found. Drop the logo at images/broadcasters/${nameSlug}-<hex>.${ext} (the colour is read from the part after the dash), or pass --tint RRGGBB.`);
  process.exit(1);
}
const logo = `./images/broadcasters/${nameSlug}-${tint}.${ext}`;

console.log(`${name}  (key "${id}")  ·  #${tint}  ·  ${fromChannel ? 'channel uploads ' : 'playlist '}${PL}`);

// ===== 1) data/wc-fixtures.json — register the playlist =====
let fixturesTxt = readFileSync(fixturesPath, 'utf8');
try { JSON.parse(fixturesTxt); } catch (e) { console.error('wc-fixtures.json is not valid JSON: ' + e.message); process.exit(1); }
const existingPl = (JSON.parse(fixturesTxt).playlists || {})[id];
let didFixtures = false;
if (existingPl && !force) {
  console.log(`playlists["${id}"] already present (${existingPl}); left as is (use --force to overwrite).`);
} else {
  if (existingPl) fixturesTxt = fixturesTxt.replace(new RegExp('("' + id + '"\\s*:\\s*)"[^"]*"'), '$1"' + PL + '"');
  else            fixturesTxt = fixturesTxt.replace(/("playlists"\s*:\s*\{)/, `$1\n    "${id}": "${PL}",`);
  writeFileSync(fixturesPath, fixturesTxt); didFixtures = true;
}

// ===== 2) build-data.mjs — register the FEEDS entry =====
let buildTxt = readFileSync(buildPath, 'utf8');
let didFeeds = false;
if (new RegExp(`pl:\\s*'${id}'`).test(buildTxt)) { console.log(`FEEDS already has pl:'${id}'.`); }
else { buildTxt = buildTxt.replace(/(const FEEDS = \[[\s\S]*?)\n\];/, `$1\n  { pl: '${id}', src: '${id}' },\n];`); writeFileSync(buildPath, buildTxt); didFeeds = true; }

// ===== 3) run the build, deep-crawling only this feed =====
let built = false;
if (!noBuild) {
  console.log(`\nBuilding (deep crawl on "${id}", regular crawl on the rest)...\n`);
  const res = spawnSync('node', [buildPath], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, DEEP_ONLY: id } });
  built = res.status === 0;
  if (!built) console.error(`\nbuild-data exited with status ${res.status}; continuing with whatever it wrote.`);
} else {
  console.log('\n--no-build: skipping the rebuild. Run "node scripts/build-data.mjs" yourself, then re-run this to detect embedding / region / language.');
}

// ===== 4) inspect the first real highlight: embeddable? regions? language? =====
let linkOut = linkoutFlag !== undefined ? linkoutFlag : false;
let regions = regionsFlag, blocked = blockedFlag, warnStyle = 'none';
let detected = false;
function myVideoIds() {
  const out = [];
  if (!dataPath || !existsSync(dataPath)) return out;
  let data; try { data = JSON.parse(readFileSync(dataPath, 'utf8')); } catch { return out; }
  const vids = data.videos || {};
  for (const mk of Object.keys(vids)) { const o = vids[mk]; if (o && o[id]) for (const tp of Object.keys(o[id])) { const v = o[id][tp]; if (/^[A-Za-z0-9_-]{11}$/.test(v) && !out.includes(v)) out.push(v); } }
  return out;
}
const ids = myVideoIds();
const regionName = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
if (ids.length && YT_KEY) {
  try {
    const s = await videoStatus(ids[0], YT_KEY);
    detected = true;
    console.log(`\nFirst highlight: ${s.title}`);
    console.log(`  embeddable: ${s.embeddable ? 'yes' : 'no'}`);
    if (s.allowed.length) console.log(`  viewable only in: ${s.allowed.map(c => c + ' ' + regionName(c)).join(', ')}`);
    else if (s.blocked.length) console.log(`  blocked in: ${s.blocked.map(c => c + ' ' + regionName(c)).join(', ')} (viewable elsewhere)`);
    else console.log('  viewable worldwide');
    if (linkoutFlag === undefined) linkOut = !s.embeddable;
    if (!regions && !blocked) { if (s.allowed.length) regions = s.allowed.slice(); else if (s.blocked.length) blocked = s.blocked.slice(); }
    if (!lang) {
      let lg = s.language;
      for (let i = 1; i < ids.length && i < 6 && !lg; i++) { try { lg = (await videoStatus(ids[i], YT_KEY)).language; } catch {} }
      if (lg) lang = lg;
    }
  } catch (e) { console.error('\nCould not inspect the first highlight: ' + e.message); }
} else {
  console.log(`\nNo highlights fetched for "${id}" yet${YT_KEY ? '' : ' (and no YouTube key)'} — using flags/defaults; re-run once clips exist to detect embedding / region / language.`);
}
if (!lang) lang = 'en';

// ===== 5) if it cannot be embedded, decide the warning style from the real titles =====
async function titlesRevealScores(titles) {
  const prompt =
    'Below are video titles from a football match highlights channel. Decide whether the titles, as a group, reveal match results: a final score (for example "2-1"), who won, or words like "win", "beat", "thrash". ' +
    'Answer with ONLY a JSON object: {"revealsScores": true} or {"revealsScores": false}.\n\n' +
    titles.slice(0, 40).map((t, i) => (i + 1) + '. ' + t).join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } };
  for (let attempt = 0; ; attempt++) {
    let res = null, err = null;
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { err = e; }
    if (res && res.ok) {
      const data = await res.json();
      const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('').trim();
      try { return !!JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')).revealsScores; } catch { throw new Error('could not parse Gemini reply: ' + text.slice(0, 120)); }
    }
    const is429 = !!(res && res.status === 429);
    if (!(err || is429 || (res && res.status === 503)) || attempt >= 3) throw new Error(err ? err.message : (res.status + ' ' + (await res.text()).slice(0, 120)));
    const wait = Math.min(30000, (is429 ? 10000 : 1500) * Math.pow(2, attempt)) + Math.floor(Math.random() * 600);
    console.log(`  ${err ? 'network' : res.status} from Gemini; waiting ${Math.round(wait / 1000)}s then retrying...`);
    await sleep(wait);
  }
}
async function fetchTitles(vidIds) {
  const out = [];
  for (let i = 0; i < vidIds.length; i += 50) {
    try { const j = await ytGet('videos?part=snippet&id=' + vidIds.slice(i, i + 50).join(',')); for (const it of (j.items || [])) out.push((it.snippet && it.snippet.title) || ''); } catch {}
  }
  return out.filter(Boolean);
}
if (linkOut) {
  if (['rds', 'fifa'].includes(warnFlag)) { warnStyle = warnFlag; }
  else if (!noAi && GEMINI_KEY && ids.length && YT_KEY) {
    try {
      const titles = await fetchTitles(ids.slice(0, 40));
      if (titles.length) {
        console.log(`\nAsking ${model} whether ${titles.length} of "${name}"'s titles reveal scores...`);
        const reveals = await titlesRevealScores(titles);
        warnStyle = reveals ? 'fifa' : 'rds';
        console.log(`  titles ${reveals ? 'DO' : 'do not'} reveal scores -> ${warnStyle} warning`);
      } else warnStyle = 'fifa';
    } catch (e) { console.error('  title check failed (' + e.message + '); defaulting to fifa'); warnStyle = 'fifa'; }
  } else { warnStyle = 'fifa'; }  // cannot check -> safer spoiler warning
}

// ===== 6) index.html — SOURCES card, optional WARN_KEYS, COUNTRY_CODES top-up =====
let indexTxt = readFileSync(indexPath, 'utf8');
let didSources = false, didWarnKeys = false, didCC = false;
const ccArr = arr => '[' + arr.map(c => `'${c}'`).join(',') + ']';
if (new RegExp(`\\n\\s*${id}:\\{`).test(indexTxt)) {
  console.log(`\nSOURCES already has ${id}; not duplicating (delete it first to refresh).`);
} else {
  const regionField = regions && regions.length ? `regions:${ccArr(regions)}, ` : (blocked && blocked.length ? `blocked:${ccArr(blocked)}, ` : '');
  const entry = `  ${id}:{ name:'${name.replace(/'/g, "\\'")}', tint:'#${tint}', ${regionField}lang:'${lang}', ${linkOut ? 'linkOut:true, ' : ''}logo:'${logo}' },`;
  if (!/\n[ \t]*fifa:\{ name:'FIFA'/.test(indexTxt)) { console.error('Could not find the SOURCES fifa entry in index.html.'); process.exit(1); }
  indexTxt = indexTxt.replace(/(\n[ \t]*fifa:\{ name:'FIFA')/, `\n${entry}$1`);
  didSources = true;
}
if (linkOut) {
  const warnBlock = (indexTxt.match(/var WARN_KEYS=\{[\s\S]*?\};/) || [''])[0];
  if (new RegExp(`\\b${id}:\\{`).test(warnBlock)) { console.log(`WARN_KEYS already has ${id}.`); }
  else {
    const ANCHOR = /(var WARN_KEYS=\{[\s\S]*?)(\s\};)(\nfunction openFifaWarn)/;
    if (!ANCHOR.test(indexTxt)) { console.error('Could not find WARN_KEYS closing in index.html.'); process.exit(1); }
    const style = warnStyle === 'rds' ? 'rds' : 'fifa';
    const warnEntry = `\n                ${id}:{h:'${style}_h',b:'${style}_b',q:'${style}_q',no:'${style}_no',noSub:'${style}_no_sub',go:'${style}_go',goSub:'${style}_go_sub'}`;
    indexTxt = indexTxt.replace(ANCHOR, `$1,${warnEntry} };$3`);
    didWarnKeys = true;
  }
}
// make sure every whitelisted country is selectable in the region picker
if (regions && regions.length) {
  const ccm = indexTxt.match(/var COUNTRY_CODES=\[([^\]]*)\];/);
  if (ccm) {
    const have = new Set((ccm[1].match(/"[A-Z]{2}"/g) || []).map(s => s.replace(/"/g, '')));
    const add = regions.filter(c => !have.has(c));
    if (add.length) { const merged = [...have, ...add].sort(); indexTxt = indexTxt.replace(/var COUNTRY_CODES=\[[^\]]*\];/, 'var COUNTRY_CODES=[' + merged.map(c => `"${c}"`).join(',') + '];'); didCC = true; }
  }
}
if (didSources || didWarnKeys || didCC) writeFileSync(indexPath, indexTxt);

// ===== summary =====
const updated = [didFixtures && 'data/wc-fixtures.json', didFeeds && 'build-data.mjs', (didSources || didWarnKeys || didCC) && 'index.html'].filter(Boolean);
console.log('\n' + '-'.repeat(56));
console.log(name + '  (key "' + id + '")');
const reach = regions && regions.length ? ('only ' + regions.join('/')) : (blocked && blocked.length ? ('all but ' + blocked.join('/')) : 'worldwide');
console.log('  ' + reach + ' · ' + lang + ' · #' + tint + (linkOut ? ('  · opens on YouTube [' + warnStyle + ' popup]') : '  · embeds inline'));
console.log('  logo ' + logo + (existsSync(join(ROOT, logo.replace('./', ''))) ? '' : '  (MISSING — drop the file here)'));
console.log('Files updated: ' + (updated.length ? updated.join(', ') : '(none; entries already present)'));
if (!detected && !noBuild) console.log('\nNote: no clips matched yet, so embedding / region / language were not detected. Re-run after the broadcaster has highlights for played matches.');
console.log('\nServe over http://localhost:8000 and hard-refresh (Cmd+Shift+R). A "' + name + '" card appears on any match it has clips for.');
