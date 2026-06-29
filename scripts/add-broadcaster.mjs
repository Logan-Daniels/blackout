#!/usr/bin/env node
// add-broadcaster.mjs — register a new broadcaster from a YouTube highlights
// playlist OR a channel, detecting almost everything automatically.
//
// Give it a playlist URL/id or a channel URL/@handle/id. It then:
//   1. reads the broadcaster name from the channel (no --name needed),
//   2. reads the brand colour from the logo file you have dropped in
//      images/broadcasters/<slug>-<hex>.png|svg (no --tint needed),
//   3. wires the feed into data/wc-fixtures.json and build-data.mjs,
//   3b. folds the broadcast language's country names (from Intl.DisplayNames,
//      via an embedded English->ISO-code table) into the wc-fixtures aliases, so
//      titles like "Alemanha" or "Hiszpania" match without hand-curated aliases,
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

// Language-code hygiene. People (and YouTube metadata) often hand us a COUNTRY code where a
// language code is meant — jp for Japanese (should be ja), gr for Greek (el), and so on. Those are
// well-formed tags so Intl does not throw; it just silently yields English, which means zero aliases
// and a missed broadcaster (this is exactly what happened to DAZN Japan with `jp`). fixLang maps the
// common slips, and langHasData catches anything still without real locale data so we can warn loudly
// instead of failing in silence.
const LANG_FIX = { jp:'ja', gr:'el', cz:'cs', kr:'ko', cn:'zh', ua:'uk', ee:'et', si:'sl', dk:'da', gb:'en', us:'en', br:'pt', cl:'es', mx:'es', ar:'es' };
const fixLang = c => { if (!c) return c; const lc = String(c).trim().toLowerCase(); const f = LANG_FIX[lc]; if (f && f !== lc) console.log(`Note: interpreting --lang "${lc}" as "${f}" (that looks like a country code; "${f}" is the matching language code).`); return f || lc; };
const _EN_REGION = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const langHasData = lang => {
  if (lang === 'en') return true;
  let DN; try { DN = new Intl.DisplayNames([lang], { type: 'region' }); } catch { return false; }
  if (!_EN_REGION) return true;
  return ['DE', 'JP', 'NL', 'CN', 'BR'].some(c => { try { return DN.of(c) !== _EN_REGION.of(c); } catch { return false; } });
};

let name = opt('name'), id = opt('id'), lang = fixLang(opt('lang')), tint = opt('tint');
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
if (!tint || !ext) {                       // scan the folder to learn colour and/or extension from the real file
  const f = findLogo();                    // matches <slug>-<hex>.png OR .svg (or whatever --logo points at)
  if (f) { const m = /-([0-9a-fA-F]{6})\.(png|svg)$/i.exec(f); if (!tint) tint = m[1].toLowerCase(); if (!ext) ext = m[2].toLowerCase(); }
}
if (!ext) ext = 'png';                      // last resort when only --tint was given and no matching file exists
if (!tint || !/^[0-9a-f]{6}$/.test(tint)) {
  console.error(`No brand colour found. Drop the logo at images/broadcasters/${nameSlug}-<hex>.${ext} (the colour is read from the part after the dash), or pass --tint RRGGBB.`);
  process.exit(1);
}
const logo = `./images/broadcasters/${nameSlug}-${tint}.${ext}`;

// ===== resolve every playlist for this one source, and label each playlist's highlight type =====
// One source (one logo) can be fed by several playlists, each a different KIND of highlight. With a
// single input we keep the classic behaviour and let build-data's per-video classifier decide the
// type. With several inputs we label each playlist once (Gemini on its titles, duration/keyword
// fallback) and force that type for the whole playlist, so all of them show under the one logo.
async function playlistTitles(plId, want) {
  const out = []; let pageToken = '';
  do {
    const j = await ytGet('playlistItems?part=snippet&maxResults=50&playlistId=' + encodeURIComponent(plId) + (pageToken ? '&pageToken=' + pageToken : ''));
    for (const it of (j.items || [])) { const tt = it.snippet && it.snippet.title; if (tt && !/^(Private|Deleted) video$/i.test(tt)) out.push(tt); }
    pageToken = j.nextPageToken || '';
  } while (pageToken && out.length < want);
  return out.slice(0, want);
}
const CANON_TYPES = { r: 'Highlights', x: 'Extended highlights', g: 'Game in 30' };
function heuristicType(titles) {
  const j = (' ' + titles.join(' \n ') + ' ').toLowerCase();
  if (/game in 30|\bin ?30\b/.test(j)) return { key: 'g', label: CANON_TYPES.g };
  if (/condensed|compacto|condensado|kompakt/.test(j)) return { key: 'g', label: CANON_TYPES.g };
  if (/full match|jogo completo|partido completo|match complet|ganzes spiel/.test(j)) return { key: 'full', label: 'Full match' };
  if (/\bgoals?\b|\bgols?\b|\bgoles\b|\bbuts\b|\btore\b/.test(j) && !/highlight|melhores momentos|r[eé]sum|samenvatting/.test(j)) return { key: 'goals', label: 'Goals' };
  if (/extended|estendid|prolongad|ausf[uü]hrlich/.test(j)) return { key: 'x', label: CANON_TYPES.x };
  return { key: 'r', label: CANON_TYPES.r };
}
const TYPE_MINS_DEFAULT = { r: 10, x: 20, g: 30, goals: 3, full: 95, playerh: 5 };
const minsFor = key => (TYPE_MINS_DEFAULT[key] != null ? TYPE_MINS_DEFAULT[key] : 15);

// Look at one playlist's titles and decide whether its match highlights come in a single format or
// several formats of the SAME matches (e.g. a short recap AND a longer highlights+goals per game).
// Returns an array of kinds: length 1 = one format; length >= 2 = a split, each kind carrying keywords.
async function analyzePlaylist(titles) {
  const fb = heuristicType(titles);
  const single = [{ key: fb.key, label: fb.label, mins: minsFor(fb.key) }];
  if (noAi || !GEMINI_KEY || titles.length < 6) return single;
  const prompt =
    "These are video titles from ONE playlist on a football broadcaster's YouTube channel. " +
    "Some are match highlights; others may be previews, interviews or studio shows — ignore those. " +
    "Decide whether the match highlights come in MULTIPLE distinct FORMATS of the SAME matches " +
    "(for example a short ~3 min recap AND a longer ~5 min highlights-and-goals for each game), or just ONE format. " +
    "Tell formats apart by the same matchups appearing under different wordings. " +
    "Return ONLY a JSON array: one element for a single format, one per format if several:\n" +
    '[{"key":"<short lowercase id, max 8 letters>","label":"<short English label>","mins":<approx whole minutes>,"kw":["<lowercase word/phrase appearing in that format\'s titles that tells it apart>"]}]\n' +
    "Use 'r' for a generic ~10 min recap, 'x' extended, 'g' game-in-30 when they fit. Each kw must actually appear in that format's titles. For a single format kw may be omitted.\n\n" +
    titles.slice(0, 60).map((t, i) => (i + 1) + '. ' + t).join('\n');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }) });
    if (!res.ok) return single;
    const data = await res.json();
    const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('').trim();
    let arr = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    if (!Array.isArray(arr)) arr = [arr];
    const nrm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nt = titles.map(nrm);
    const kinds = [], seen = {};
    for (const o of arr) {
      let key = String((o && o.key) || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      if (!key) continue;
      while (seen[key]) key += '2';
      seen[key] = 1;
      const label = CANON_TYPES[key] || String((o && o.label) || '').trim().slice(0, 28) || key;
      const mins = (o && Number.isFinite(+o.mins) && +o.mins > 0) ? Math.round(+o.mins) : minsFor(key);
      const kw = Array.isArray(o && o.kw) ? o.kw.map(k => String(k).toLowerCase().trim()).filter(Boolean) : [];
      kinds.push({ key, label, mins, kw });
    }
    if (kinds.length <= 1) return single;
    const ok = kinds.filter(k => k.kw.length && k.kw.some(w => nt.filter(t => t.includes(nrm(w))).length >= 2));   // a split is only believable if each format's keywords really occur in the titles
    return ok.length >= 2 ? ok : single;
  } catch { return single; }
}

const extraInputs = positional.slice(1).map(parseInput);
const feeds = [];
const allInputs = [input, ...extraInputs.filter(Boolean)];
{
  const seenKey = {};
  const uniq = k => { while (seenKey[k]) k += '2'; seenKey[k] = 1; return k; };
  for (let i = 0; i < allInputs.length; i++) {
    const inp = allInputs[i];
    let plId;
    if (i === 0) plId = PL;
    else { try { plId = inp.kind === 'playlist' ? inp.id : (await resolveChannel(inp.ref)).uploads; } catch (e) { console.error(`  input ${i + 1}: ${e.message}; skipped`); continue; } }
    let titles = []; try { titles = await playlistTitles(plId, 60); } catch {}
    const kinds = await analyzePlaylist(titles);
    if (kinds.length >= 2) {                                   // one playlist, several formats -> a split feed
      for (const k of kinds) k.key = uniq(k.key);
      feeds.push({ plKey: (allInputs.length === 1 ? id : id + '_' + i), plId, split: kinds.map(k => ({ kw: k.kw, type: k.key })), kinds, titles });
      console.log(`\nplaylist ${i + 1} ${plId} -> ${kinds.length} formats: ` + kinds.map(k => `${k.key} "${k.label}" ~${k.mins}m [${k.kw.join('|')}]`).join(', '));
    } else if (allInputs.length === 1) {                       // single playlist, single format -> let the classifier decide per video (classic)
      feeds.push({ plKey: id, plId, type: null, label: null, titles });
    } else {                                                   // one of several playlists, single format -> typed feed
      const k = kinds[0]; const uk = uniq(k.key);
      feeds.push({ plKey: id + '_' + uk, plId, type: uk, label: k.label, mins: k.mins, titles });
      console.log(`  playlist ${i + 1} ${plId} -> ${uk} (${k.label})`);
    }
  }
  if (!feeds.length) { console.error('No playlists resolved.'); process.exit(1); }
}

console.log(`\n${name}  (key "${id}")  ·  #${tint}  ·  ${feeds.length} playlist${feeds.length > 1 ? 's' : ''}`);

// ===== 1) data/wc-fixtures.json — register the playlist =====
let fixturesTxt = readFileSync(fixturesPath, 'utf8');
try { JSON.parse(fixturesTxt); } catch (e) { console.error('wc-fixtures.json is not valid JSON: ' + e.message); process.exit(1); }
let didFixtures = false;
{
  const existing = JSON.parse(fixturesTxt).playlists || {};
  const toAdd = [], toUpd = [];
  for (const f of feeds) {
    if (existing[f.plKey]) { if (force && existing[f.plKey] !== f.plId) toUpd.push(f); else console.log(`playlists["${f.plKey}"] already present; left as is (use --force).`); }
    else toAdd.push(f);
  }
  for (const f of toUpd) fixturesTxt = fixturesTxt.replace(new RegExp('("' + f.plKey + '"\\s*:\\s*)"[^"]*"'), '$1"' + f.plId + '"');
  if (toAdd.length) fixturesTxt = fixturesTxt.replace(/("playlists"\s*:\s*\{)/, `$1\n` + toAdd.map(f => `    "${f.plKey}": "${f.plId}",`).join('\n'));
  if (toAdd.length || toUpd.length) { writeFileSync(fixturesPath, fixturesTxt); didFixtures = true; }
}

// ===== 2) build-data.mjs — register the FEEDS entry =====
let buildTxt = readFileSync(buildPath, 'utf8');
let didFeeds = false;
{
  const lines = [];
  for (const f of feeds) {
    if (new RegExp(`pl:\\s*'${f.plKey}'`).test(buildTxt)) { console.log(`FEEDS already has pl:'${f.plKey}'.`); continue; }
    lines.push(`  { pl: '${f.plKey}', src: '${id}'${f.split ? `, split: [${f.split.map(r => `{ kw: [${r.kw.map(k => `'${String(k).replace(/'/g, "\\'")}'`).join(', ')}], type: '${r.type}' }`).join(', ')}] ` : f.type ? `, type: '${f.type}'` : ''} },`);
  }
  if (lines.length) { buildTxt = buildTxt.replace(/(const FEEDS = \[[\s\S]*?)\n\];/, `$1\n` + lines.join('\n') + `\n];`); writeFileSync(buildPath, buildTxt); didFeeds = true; }
}

// ===== 3b) fold a flagged language's country names into the aliases BEFORE the build, so the
// crawl below already matches titles in that language (e.g. --lang pt makes "Alemanha" match now).
// An inferred-only language (no --lang) is handled by the idempotent pass after the build. =====
// English-name -> ISO-code table for the 48 teams, used by foldLangAliases (defined further down).
const TEAM_CC = {
  "Mexico":"mx", "South Africa":"za", "South Korea":"kr", "Czechia":"cz", "Canada":"ca", "Bosnia and Herzegovina":"ba",
  "Qatar":"qa", "Switzerland":"ch", "Brazil":"br", "Morocco":"ma", "Haiti":"ht", "Scotland":"gb-sct",
  "United States":"us", "Paraguay":"py", "Australia":"au", "Türkiye":"tr", "Germany":"de", "Curaçao":"cw",
  "Côte d'Ivoire":"ci", "Ecuador":"ec", "Netherlands":"nl", "Japan":"jp", "Sweden":"se", "Tunisia":"tn",
  "Belgium":"be", "Egypt":"eg", "Iran":"ir", "New Zealand":"nz", "Spain":"es", "Cabo Verde":"cv",
  "Saudi Arabia":"sa", "Uruguay":"uy", "France":"fr", "Senegal":"sn", "Iraq":"iq", "Norway":"no",
  "Argentina":"ar", "Algeria":"dz", "Austria":"at", "Jordan":"jo", "Portugal":"pt", "DR Congo":"cd",
  "Uzbekistan":"uz", "Colombia":"co", "England":"gb-eng", "Croatia":"hr", "Ghana":"gh", "Panama":"pa"
};
// England and Scotland are GB subdivisions with no ISO country code, so Intl.DisplayNames cannot
// localise them. Their names are translated as text instead, from this curated table (lower-case, as
// stored). A missing or wrong entry can only cause a miss, never a false match, so it is safe to extend.
// DeepL (via translate-i18n) also translates these two, so this mainly serves the first-build match and
// the no-DeepL languages.
const SUBNATIONAL = {
  "England":  { es:"inglaterra", fr:"angleterre", pt:"inglaterra", de:"england", it:"inghilterra", nl:"engeland", ja:"イングランド", ko:"잉글랜드", zh:"英格兰", id:"inggris", tr:"ingiltere", pl:"anglia", ru:"англия", uk:"англія", sv:"england", da:"england", nb:"england", no:"england", fi:"englanti", cs:"anglie", sk:"anglicko", el:"αγγλία", ro:"anglia", hu:"anglia", bg:"англия", ar:"إنجلترا" },
  "Scotland": { es:"escocia", fr:"écosse", pt:"escócia", de:"schottland", it:"scozia", nl:"schotland", ja:"スコットランド", ko:"스코틀랜드", zh:"苏格兰", id:"skotlandia", tr:"iskoçya", pl:"szkocja", ru:"шотландия", uk:"шотландія", sv:"skottland", da:"skotland", nb:"skottland", no:"skottland", fi:"skotlanti", cs:"skotsko", sk:"škótsko", el:"σκωτία", ro:"scoția", hu:"skócia", bg:"шотландия", ar:"اسكتلندا" }
};
if (lang && lang !== 'en' && !langHasData(lang)) {
  console.log(`\n⚠  "${lang}" has no locale data, so no team-name aliases can be generated for it and titles in that language will not match. This usually means the code is a country code rather than a language code. The feed will still be added; re-run with the correct language code to fold its aliases.`);
}
foldLangAliases(lang);

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
let ids = myVideoIds();
// Auto-type rescue. A single-playlist feed that matched zero clips on its first crawl is almost
// always a non-Latin broadcaster (Korean, Polish, Turkish, …): the alias matcher DID find both
// teams, but classify() then dropped every clip because the feed has no declared type and the title's
// highlight wording is not in build-data's HL_RX recap heuristic (which only covers Latin-script
// languages, and cannot be extended to e.g. Korean because HL_RX is tested against the NFD-normalised
// title). Declaring type:'r' makes classify short-circuit and attach each matched clip as a recap
// regardless of title language. We only do this when zero clips matched, so a working feed whose titles
// HL_RX already understands (and where it distinguishes recap vs extended) is never touched.
if (built && !noBuild && ids.length === 0 && feeds.length === 1 && !feeds[0].split && !feeds[0].type) {
  const fk = feeds[0].plKey;
  let bt = readFileSync(buildPath, 'utf8');
  const bare = new RegExp(`\\{\\s*pl:\\s*'${fk}',\\s*src:\\s*'${id}'\\s*\\}`);
  const alreadyTyped = new RegExp(`pl:\\s*'${fk}'[^}]*\\btype:`);
  if (bare.test(bt) && !alreadyTyped.test(bt)) {
    bt = bt.replace(bare, `{ pl: '${fk}', src: '${id}', type: 'r' }`);
    writeFileSync(buildPath, bt);
    feeds[0].type = 'r';
    didFeeds = true;
    console.log(`\n↻ "${id}" matched zero clips on the first crawl. Its titles' highlight wording is not in build-data's recap heuristic, so the clips were found and then dropped for lack of a feed type. Declaring type:'r' and rebuilding...\n`);
    const res2 = spawnSync('node', [buildPath], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, DEEP_ONLY: id } });
    if (res2.status === 0) { ids = myVideoIds(); console.log(`\n"${id}" now matches ${ids.length} clip(s).`); }
    else console.error(`\nRebuild after declaring type:'r' exited with status ${res2.status}; the type is written, so just run  DEEP_ONLY=${id} node scripts/build-data.mjs  yourself.`);
  }
}
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
      if (lg) lang = fixLang(lg);
    }
  } catch (e) { console.error('\nCould not inspect the first highlight: ' + e.message); }
} else {
  console.log(`\nNo highlights fetched for "${id}" yet${YT_KEY ? '' : ' (and no YouTube key)'} — using flags/defaults; re-run once clips exist to detect embedding / region / language.`);
}
if (!lang) lang = 'en';

// ===== 4b) auto-fold this language's country names into the matcher's aliases =====
// So highlight titles written in `lang` (e.g. "Alemanha", "Países Baixos", "Coreia do Sul") match
// straight away, with no hand-curated aliases and no DeepL. Localised names come from Intl.DisplayNames;
// the English-name -> ISO-code table below is embedded so this needs no external file. It is idempotent
// (skips names already present) and runs every time, so existing languages are simply re-confirmed.
// England and Scotland are GB subdivisions Intl cannot render, so they keep whatever aliases are curated.
// (The TEAM_CC table is declared higher up, before this function is first called.)
function foldLangAliases(lng) {
  if (!lng) return 0;
  let DN; try { DN = new Intl.DisplayNames([lng], { type: 'region' }); }
  catch { console.log(`\nNo Intl locale data for "${lng}"; skipping automatic team-name aliases.`); return 0; }
  let cfg; try { cfg = JSON.parse(readFileSync(fixturesPath, 'utf8')); } catch { return 0; }
  const aliases = cfg.aliases || {};
  const nrm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let added = 0; const log = [];
  for (const team of Object.keys(aliases)) {
    const code = TEAM_CC[team]; if (!code || code.includes('-')) continue;        // unknown team, or a GB subdivision Intl can't localise
    let nm; try { nm = DN.of(code.toUpperCase()); } catch { continue; }
    if (!nm || nm.toUpperCase() === code.toUpperCase()) continue;                  // no localisation for this code
    nm = nm.toLowerCase();
    const have = new Set(aliases[team].map(nrm));
    if (!have.has(nrm(nm))) { aliases[team].push(nm); have.add(nrm(nm)); added++; log.push(`${team} → ${nm}`); }
  }
  for (const team of ['England', 'Scotland']) {                                   // the two GB subdivisions Intl can't do, via the curated table
    if (!aliases[team]) continue;
    const nm = (SUBNATIONAL[team] || {})[lng]; if (!nm) continue;
    const have = new Set(aliases[team].map(nrm));
    if (!have.has(nrm(nm))) { aliases[team].push(nm.toLowerCase()); added++; log.push(`${team} → ${nm}`); }
  }
  if (!added) return 0;
  cfg.aliases = aliases;
  writeFileSync(fixturesPath, JSON.stringify(cfg, null, 1));
  didFixtures = true;
  console.log(`\nAdded ${added} "${lng}" team-name alias(es) to wc-fixtures.json so this feed's titles match: ${log.slice(0, 8).join(', ')}${log.length > 8 ? ', …' : ''}`);
  return added;
}
const _lateAliases = foldLangAliases(lang);   // catches a language that was inferred (not flagged) after the build ran
if (_lateAliases && !noBuild) console.log(`↻ Re-run the build so the "${lang}" titles match:  DEEP_ONLY=${id} node scripts/build-data.mjs`);

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
  for (const f of feeds) {
    if (['rds', 'fifa'].includes(warnFlag)) { f.warnStyle = warnFlag; continue; }
    let titles = (f.titles && f.titles.length) ? f.titles : [];
    if (!noAi && GEMINI_KEY && !titles.length) { try { titles = await playlistTitles(f.plId, 40); } catch {} }
    if (!noAi && GEMINI_KEY && titles.length) {
      try {
        console.log(`\nAsking ${model} whether ${f.plKey} titles reveal scores...`);
        f.warnStyle = (await titlesRevealScores(titles)) ? 'fifa' : 'rds';
        console.log(`  ${f.plKey}: ${f.warnStyle === 'fifa' ? 'reveals scores' : 'clean'} -> ${f.warnStyle} popup`);
      } catch (e) { console.error('  title check failed (' + e.message + '); defaulting to fifa'); f.warnStyle = 'fifa'; }
    } else f.warnStyle = 'fifa';   // cannot check -> safer spoiler warning
  }
  warnStyle = feeds[0].warnStyle;
}

// ===== 5c) new interface language — register it on the site via translate-i18n =====
// A broadcaster in a language the interface does not have yet (NOS in Dutch was the first) should make
// that language selectable. translate-i18n creates i18n/<lang>.json (via DeepL), folds the language's
// team-name spellings into wc-fixtures.json, and rebuilds the LANGS picker. Right-to-left languages are
// flagged rather than auto-added: the layout is left-to-right only, so they need manual mirroring work.
if (lang && lang !== 'en') {
  const RTL = ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi'];
  const uiExists = existsSync(join(ROOT, 'i18n', lang + '.json'));
  if (RTL.includes(lang)) {
    console.log(`\nNote: ${name} is in ${lang}, a right-to-left language; the interface is left-to-right only, so it was not auto-added. Adding ${lang} needs manual RTL layout work.`);
  } else if (uiExists) {
    console.log(`\nInterface language "${lang}" is already present; leaving it as is.`);
  } else {
    const ti = findIn('translate-i18n.mjs', [here, join(ROOT, 'scripts'), ROOT, process.cwd()]);
    const deeplKey = process.env.DEEPL_API_KEY || process.env.DEEPL_AUTH_KEY || keyFile('deepl');
    if (ti && deeplKey) {
      console.log(`\nNew interface language "${lang}" — adding it to the site via translate-i18n (DeepL)...`);
      const r = spawnSync('node', [ti, lang], { stdio: 'inherit', cwd: ROOT, env: process.env });
      if (r.status !== 0) console.error(`  translate-i18n exited ${r.status}; add ${lang} later with:  node scripts/translate-i18n.mjs ${lang}`);
      else console.log(`  re-run the build to pick up the new ${lang} team-name spellings:  DEEP=1 node scripts/build-data.mjs`);
    } else {
      console.log(`\nNote: ${name} broadcasts in "${lang}", which the interface does not support yet. Add it with:\n  node scripts/translate-i18n.mjs ${lang}    (needs a DeepL key in keys/deepl.txt or DEEPL_API_KEY; a free key ends in ":fx")`);
    }
  }
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
  const entries = [];
  for (const f of feeds) {
    const wkey = f.split ? id : ((feeds.length === 1) ? id : (id + ':' + f.type));
    const kq = /[^A-Za-z0-9_$]/.test(wkey) ? `'${wkey}'` : wkey;          // keys with ':' must be quoted
    if (new RegExp(`(^|[,{\\s])'?${wkey.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')}'?\\s*:\\s*\\{`).test(warnBlock)) { console.log(`WARN_KEYS already has ${wkey}.`); continue; }
    const style = (f.warnStyle === 'rds') ? 'rds' : 'fifa';
    entries.push(`\n                ${kq}:{h:'${style}_h',b:'${style}_b',q:'${style}_q',no:'${style}_no',noSub:'${style}_no_sub',go:'${style}_go',goSub:'${style}_go_sub'}`);
  }
  if (entries.length) {
    const ANCHOR = /(var WARN_KEYS=\{[\s\S]*?)(\s\};)(\nfunction openFifaWarn)/;
    if (!ANCHOR.test(indexTxt)) { console.error('Could not find WARN_KEYS closing in index.html.'); process.exit(1); }
    indexTxt = indexTxt.replace(ANCHOR, `$1,${entries.join(',')} };$3`);
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
{
  const allKinds = [];
  for (const f of feeds) { if (f.kinds) for (const k of f.kinds) allKinds.push(k); else if (f.type) allKinds.push({ key: f.type, label: f.label || f.type, mins: f.mins }); }
  const vm = indexTxt.match(/var VTYPES=\[([\s\S]*?)\];/);
  if (vm) {
    const present = new Set([...vm[1].matchAll(/k\s*:\s*'([^']+)'/g)].map(x => x[1]));
    const extra = [];
    for (const k of allKinds) { if (['r', 'x', 'g'].includes(k.key) || present.has(k.key)) continue; present.add(k.key); const d = k.mins ? `~${k.mins} min` : ''; extra.push(`{k:'${k.key}',label:'${String(k.label || k.key).replace(/'/g, "\\'")}'${d ? `,desc:'${d}'` : ''}}`); }
    if (extra.length) { indexTxt = indexTxt.replace(/(var VTYPES=\[[\s\S]*?)\];/, `$1,` + extra.join(',') + `];`); didSources = true; }
  }
  const tm = indexTxt.match(/var TYPE_MINS=\{([\s\S]*?)\};/);   // keep the ordering durations in step with new kinds
  if (tm) {
    const have = new Set([...tm[1].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map(x => x[1]));
    const adds = [];
    for (const k of allKinds) { if (k.mins && !have.has(k.key)) { have.add(k.key); adds.push(`${k.key}:${k.mins}`); } }
    if (adds.length) { indexTxt = indexTxt.replace(/(var TYPE_MINS=\{[\s\S]*?)\};/, `$1,` + adds.join(',') + `};`); didSources = true; }
  }
}
if (didSources || didWarnKeys || didCC) writeFileSync(indexPath, indexTxt);

// ===== summary =====
const updated = [didFixtures && 'data/wc-fixtures.json', didFeeds && 'build-data.mjs', (didSources || didWarnKeys || didCC) && 'index.html'].filter(Boolean);
console.log('\n' + '-'.repeat(56));
console.log(name + '  (key "' + id + '")');
{ const fmts = feeds.flatMap(f => f.split ? f.kinds.map(k => k.key + (linkOut ? '/' + (f.warnStyle || 'fifa') : '')) : (f.type ? [f.type + (linkOut ? '/' + (f.warnStyle || 'fifa') : '')] : [])); if (fmts.length > 1 || feeds.some(f => f.split)) console.log('  formats: ' + fmts.join(', ')); }
const reach = regions && regions.length ? ('only ' + regions.join('/')) : (blocked && blocked.length ? ('all but ' + blocked.join('/')) : 'worldwide');
console.log('  ' + reach + ' · ' + lang + ' · #' + tint + (linkOut ? ('  · opens on YouTube [' + warnStyle + ' popup]') : '  · embeds inline'));
console.log('  logo ' + logo + (existsSync(join(ROOT, logo.replace('./', ''))) ? '' : '  (MISSING — drop the file here)'));
console.log('Files updated: ' + (updated.length ? updated.join(', ') : '(none; entries already present)'));
if (!detected && !noBuild) console.log('\nNote: no clips matched yet, so embedding / region / language were not detected. Re-run after the broadcaster has highlights for played matches.');
console.log('\nServe over http://localhost:8000 and hard-refresh (Cmd+Shift+R). A "' + name + '" card appears on any match it has clips for.');
