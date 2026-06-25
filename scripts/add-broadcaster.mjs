#!/usr/bin/env node
// add-broadcaster.mjs — register a new broadcaster from its YouTube highlights playlist.
//
// Edits three files in place so the broadcaster is wired end to end:
//   - wc-fixtures.json : adds the playlist id under "playlists"
//   - build-data.mjs   : adds a FEEDS entry so the build fetches that playlist
//   - index.html       : adds the SOURCES card, wires the link-out popup style into WARN_KEYS
//
// You add the logo image yourself; the script prints the exact path to drop it at.
//
// It makes ONE small Gemini request to infer: a short key, the home country, the main language,
// the brand colour, whether the broadcaster blocks YouTube embedding (linkOut), and if so which
// popup style to use (warnStyle: "rds" for gentle / "fifa" for spoiler warning).
// Any of those can be supplied as flags to skip or override the guess; --no-ai turns the model
// off entirely (then supply them all). The Gemini key is read from keys/gemini.txt (or --gemini-key=, or the GEMINI_API_KEY env var).
//
// Usage:
//   node scripts/add-broadcaster.mjs "https://www.youtube.com/playlist?list=PL..." --name "DAZN"   # Gemini key read from keys/gemini.txt
//   node scripts/add-broadcaster.mjs PL... --name "SBS Sport" --country AU --lang en --tint 1a7f3c --linkout --warn rds
//   node scripts/add-broadcaster.mjs PL...           # read the name from the playlist's channel (YouTube key from keys/youtube.txt)
//   node scripts/add-broadcaster.mjs PL... --no-ai --name "X" --id x --country GB --lang en --tint 112233
//
// Flags: --name, --id, --country (ISO 3166-1 alpha-2), --lang (ISO 639-1), --tint (6-digit hex, no #),
//        --linkout / --no-linkout, --warn rds|fifa, --ext png|svg, --no-ai, --gemini-key=, --model=, --force.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const argv = process.argv.slice(2);
const BOOL = new Set(['linkout', 'no-linkout', 'no-ai', 'force']);
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
const playlistArg = positional[0];

let name = opt('name'), id = opt('id'), country = opt('country'), lang = opt('lang'), tint = opt('tint');
let ext = (opt('ext') || 'png').replace(/^\./, '');
const noAi = flag('no-ai'), force = flag('force');
const linkoutFlag = flag('linkout') ? true : (flag('no-linkout') ? false : undefined);
// --warn rds  => gentle "embedding blocked, no spoilers in titles" popup
// --warn fifa => hard   "⚠️ SPOILERS WARNING ⚠️" popup
// omit        => AI decides (ignored when linkOut is false)
const warnFlag = opt('warn');
const model = opt('model') || 'gemini-2.5-flash';
const keyFile = (name) => { try { const h = dirname(fileURLToPath(import.meta.url)); for (const d of [join(h, '..', 'keys'), join(h, 'keys'), join(process.cwd(), 'keys')]) { const f = join(d, name + '.txt'); if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } } catch {} return ''; };
const GEMINI_KEY = opt('gemini-key') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keyFile('gemini');
const YT_KEY = process.env.YT_API_KEY || keyFile('youtube');

if (!playlistArg) {
  console.error('Usage: node scripts/add-broadcaster.mjs <playlist-url-or-id> --name "Name" [--country CC --lang ll --tint hex --linkout --warn rds|fifa]');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const findIn = (name, dirs) => { for (const d of dirs) { const p = join(d, name); if (existsSync(p)) return p; } return null; };
// index.html marks the repo root; it is normally the script's parent (scripts/..), but allow cwd too
const indexPath = findIn('index.html', [join(here, '..'), here, process.cwd()]);
if (!indexPath) { console.error('Cannot find index.html. Run this from inside the repo (or its scripts/ folder).'); process.exit(1); }
const ROOT = dirname(indexPath);
// build-data.mjs lives alongside this script (scripts/); wc-fixtures.json sits in data/
const buildPath = findIn('build-data.mjs', [here, ROOT, join(ROOT, 'scripts'), process.cwd()]);
const fixturesPath = findIn('wc-fixtures.json', [join(ROOT, 'data'), ROOT, here, join(ROOT, 'scripts'), process.cwd()]);
for (const [p, n] of [[fixturesPath, 'wc-fixtures.json'], [buildPath, 'build-data.mjs']]) {
  if (!p) { console.error(`Cannot find ${n} (looked next to index.html at ${ROOT} and in scripts/). Run this from inside the repo.`); process.exit(1); }
}

function playlistId(s) {
  const m = /[?&]list=([A-Za-z0-9_-]+)/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{12,}$/.test(s.trim())) return s.trim();
  return null;
}
const PL = playlistId(playlistArg);
if (!PL) { console.error(`Could not find a playlist id in "${playlistArg}". Pass the full URL or the bare playlist id.`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPlaylistName() {
  if (!YT_KEY) return null;
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=' + PL + '&key=' + encodeURIComponent(YT_KEY));
    if (!r.ok) return null;
    const j = await r.json(); const s = j.items && j.items[0] && j.items[0].snippet;
    return s ? (s.channelTitle || s.title || null) : null;
  } catch { return null; }
}

async function geminiInfer(broadcasterName) {
  const prompt = [
    `You are configuring a broadcaster entry for a World Cup highlights website.`,
    `The broadcaster is: "${broadcasterName}". It runs a YouTube highlights channel.`,
    `Return ONLY a JSON object, no commentary, with exactly these fields:`,
    `  "key": a short lowercase identifier, letters and digits only, no spaces (e.g. "dazn", "sbs", "skysports").`,
    `  "name": the clean display name (e.g. "Sky Sports").`,
    `  "country": ISO 3166-1 alpha-2 code of its primary home market (e.g. "GB"); use "" only for a truly global brand with no single home market.`,
    `  "lang": ISO 639-1 code of its main broadcast language (e.g. "en").`,
    `  "tint": the brand's primary colour as a 6-digit hex WITHOUT the # (e.g. "1a7f3c").`,
    `  "linkOut": true if it typically disables embedding of its YouTube videos (so they must open on YouTube), else false; if unsure, false.`,
    `  "warnStyle": only matters when linkOut is true. Use "rds" if the broadcaster's video titles do NOT reveal the match result (so a gentle "embedding blocked" notice is enough). Use "fifa" if the broadcaster's video titles DO reveal the score or result (so a spoiler warning is required). If linkOut is false, use "none".`,
  ].join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } };
  let attempt = 0;
  for (;;) {
    let res = null, err = null;
    try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { err = e; }
    if (res && res.ok) {
      const data = await res.json();
      const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('').trim();
      try { return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')); } catch { throw new Error('could not parse Gemini JSON: ' + text.slice(0, 120)); }
    }
    const is429 = !!(res && res.status === 429);
    const retryable = !!err || is429 || (res && res.status === 503);
    if (!retryable || attempt >= 3) throw new Error(err ? err.message : (res.status + ' ' + (await res.text()).slice(0, 120)));
    const wait = Math.min(30000, (is429 ? 10000 : 1500) * Math.pow(2, attempt)) + Math.floor(Math.random() * 600);
    console.log(`  ${err ? 'network' : res.status} from Gemini; waiting ${Math.round(wait / 1000)}s then retrying...`);
    await sleep(wait); attempt++;
  }
}

if (!name) name = await fetchPlaylistName();
let ai = {};
// warnStyle only matters when linkOut ends up true; skip asking the model if linkOut will be off
const linkOutKnown = linkoutFlag !== undefined;
const willLinkOut = linkoutFlag === true;  // conservative: if flag absent, AI might set it true
const needAi = !noAi && (!name || !id || country === undefined || !lang || !tint
    || linkoutFlag === undefined || (!linkOutKnown && !warnFlag) || (willLinkOut && !warnFlag));
if (needAi) {
  if (!GEMINI_KEY) { console.error('Need a Gemini key to infer fields. Set GEMINI_API_KEY (or --gemini-key=), or supply all of --no-ai --name --id --country --lang --tint.'); process.exit(1); }
  if (!name) { console.error('Provide --name "Broadcaster Name" (or set YT_API_KEY so the name can be read from the playlist).'); process.exit(1); }
  console.log(`Asking ${model} to infer the configuration for "${name}"...`);
  try { ai = await geminiInfer(name); } catch (e) { console.error('Gemini inference failed: ' + e.message); process.exit(1); }
}

name    = (name    || ai.name    || '').trim();
id      = (id      || ai.key     || '').toLowerCase().replace(/[^a-z0-9]/g, '');
country = (country !== undefined ? country : (ai.country || '')).toUpperCase().replace(/[^A-Z]/g, '');
lang    = (lang    || ai.lang    || 'en').toLowerCase().replace(/[^a-z]/g, '');
tint    = (tint    || ai.tint    || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
const linkOut  = linkoutFlag !== undefined ? linkoutFlag : !!ai.linkOut;
// warnStyle: flag wins, else AI, else 'fifa' (safer default)
const warnStyle = linkOut
  ? (['rds', 'fifa'].includes(warnFlag) ? warnFlag : (['rds', 'fifa'].includes(ai.warnStyle) ? ai.warnStyle : 'fifa'))
  : 'none';

if (!name) { console.error('No name resolved; pass --name.'); process.exit(1); }
if (!id)   id = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12);
if (!/^[0-9a-f]{6}$/.test(tint)) { console.error(`Tint "${tint}" is not a 6-digit hex; pass --tint RRGGBB.`); process.exit(1); }

const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const regionName = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
const folder   = country ? slug(regionName(country)) : 'world';
const nameSlug = slug(name);
const logo = `./images/broadcasters/${folder}/${nameSlug}-${tint}.${ext}`;

// 1) wc-fixtures.json
let fixturesTxt = readFileSync(fixturesPath, 'utf8');
let fixturesJson; try { fixturesJson = JSON.parse(fixturesTxt); } catch (e) { console.error('wc-fixtures.json is not valid JSON: ' + e.message); process.exit(1); }
const existingPl = (fixturesJson.playlists || {})[id];
let didFixtures = false;
if (existingPl && !force) {
  console.log(`playlists["${id}"] already in wc-fixtures.json (${existingPl}); left as is (use --force to overwrite).`);
} else {
  if (existingPl) fixturesTxt = fixturesTxt.replace(new RegExp('("' + id + '"\\s*:\\s*)"[^"]*"'), '$1"' + PL + '"');
  else            fixturesTxt = fixturesTxt.replace(/("playlists"\s*:\s*\{)/, `$1\n  "${id}": "${PL}",`);
  writeFileSync(fixturesPath, fixturesTxt); didFixtures = true;
}

// 2) build-data.mjs FEEDS
let buildTxt = readFileSync(buildPath, 'utf8');
let didFeeds = false;
if (new RegExp(`pl:\\s*'${id}'`).test(buildTxt)) { console.log(`FEEDS already has pl:'${id}' in build-data.mjs; not duplicating.`); }
else { buildTxt = buildTxt.replace(/(const FEEDS = \[[\s\S]*?)\n\];/, `$1\n  { pl: '${id}', src: '${id}' },\n];`); writeFileSync(buildPath, buildTxt); didFeeds = true; }

// 3) index.html — SOURCES card + optional WARN_KEYS entry
let indexTxt = readFileSync(indexPath, 'utf8');
let didSources = false, didWarnKeys = false;

// SOURCES card (inserted just before the fifa fallback so fifa stays last)
if (new RegExp(`\\n\\s*${id}:\\{`).test(indexTxt)) {
  console.log(`SOURCES already has ${id} in index.html; not duplicating.`);
} else {
  const entry = `  ${id}:{ name:'${name.replace(/'/g, "\\'")}', tint:'#${tint}', ${country ? `country:'${country}', ` : ''}lang:'${lang}', ${linkOut ? 'linkOut:true, ' : ''}logo:'${logo}' },`;
  if (!/\n[ \t]*fifa:\{ name:'FIFA'/.test(indexTxt)) { console.error('Could not find the SOURCES fifa entry in index.html to anchor the insert.'); process.exit(1); }
  indexTxt = indexTxt.replace(/(\n[ \t]*fifa:\{ name:'FIFA')/, `\n${entry}$1`);
  didSources = true;
}

// WARN_KEYS entry — only when linkOut is true AND the key is not already registered
// (rds and fifa are built in; new broadcasters get aliased to whichever style the AI chose)
if (linkOut) {
  // Extract just the WARN_KEYS block so the duplicate check cannot match SOURCES or I18N
  const warnBlock = (indexTxt.match(/var WARN_KEYS=\{[\s\S]*?\};/) || [''])[0];
  const warnKeyRe = new RegExp(`\\b${id}:\\{`);
  if (warnKeyRe.test(warnBlock)) {
    console.log(`WARN_KEYS already has ${id} in index.html; not duplicating.`);
  } else {
    // Anchor: the closing  };  of WARN_KEYS is always followed immediately by  \nfunction openFifaWarn
    const ANCHOR = /(var WARN_KEYS=\{[\s\S]*?)(\s\};)(\nfunction openFifaWarn)/;
    if (!ANCHOR.test(indexTxt)) { console.error('Could not find WARN_KEYS closing in index.html.'); process.exit(1); }
    // Point this key at the shared i18n strings of the chosen style (rds_ or fifa_ prefix)
    const warnEntry = `\n                ${id}:{h:'${warnStyle}_h',b:'${warnStyle}_b',q:'${warnStyle}_q',no:'${warnStyle}_no',noSub:'${warnStyle}_no_sub',go:'${warnStyle}_go',goSub:'${warnStyle}_go_sub'}`;
    indexTxt = indexTxt.replace(ANCHOR, `$1,${warnEntry} };$3`);
    didWarnKeys = true;
  }
}

if (didSources || didWarnKeys) writeFileSync(indexPath, indexTxt);

const updated = [didFixtures && 'wc-fixtures.json', didFeeds && 'build-data.mjs', (didSources || didWarnKeys) && 'index.html'].filter(Boolean);
console.log('\n' + name + '  (key "' + id + '")');
console.log('  ' + (country || 'global') + ' · ' + lang + ' · #' + tint
  + (linkOut ? (' · opens on YouTube  [' + warnStyle + ' popup]') : '  · embeds inline'));
console.log('  playlist ' + PL);
console.log('Files updated: ' + (updated.length ? updated.join(', ') : '(none; all entries already present)'));
console.log('\nNext:');
console.log('  1. Drop the logo here (transparent PNG recommended; the card tint shows behind it):');
console.log('     ' + join(ROOT, logo.replace('./', '')));
console.log('  2. Rebuild to fetch highlights:  node scripts/build-data.mjs   (reads keys/youtube.txt)');
console.log('  3. Serve over http://localhost:8000 + Cmd+Shift+R. A ' + name + ' card appears on any match it has clips for.');
