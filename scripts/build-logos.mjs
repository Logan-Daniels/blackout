#!/usr/bin/env node
/*
 * build-logos.mjs  ·  BLACKOUT logo enrichment
 * ---------------------------------------------------------------------------
 * Fills in club crests and league logos in clubs.json.
 *
 * Strategy (default SOURCE = "gapfill"):
 *   1. Keep every logo already in clubs.json. Those came from Wikidata P154,
 *      matched by exact QID, so they are never the wrong crest and are often
 *      crisp SVGs for the big clubs and leagues.
 *   2. For anything still missing a logo, look it up on TheSportsDB (free).
 *      TheSportsDB badges are uniform transparent PNGs with very broad club
 *      and league coverage, which is exactly what a grid of small logos wants.
 *   3. Whatever still has no logo keeps null; the page renders initials there.
 *
 * Name matching is scored and thresholded so a weak match is rejected rather
 * than risk pinning the wrong badge on a club. Club country is used as a
 * tie-breaker. League lookups use the league's own country, so they are tight.
 *
 * If you would rather have ONE perfectly uniform badge style everywhere
 * (all PNG, all from TheSportsDB), set SOURCE = "thesportsdb" below: it will
 * overwrite the Wikidata logos with TheSportsDB badges wherever a confident
 * match exists, and fall back to the existing logo otherwise.
 *
 * This must run on your machine: the sandbox cannot reach TheSportsDB.
 *   node scripts/build-logos.mjs
 * Then re-upload clubs.json. The page reads clubs.json directly, so no code
 * change is needed. Re-runs are cheap: responses are cached under .logo-cache/.
 * ---------------------------------------------------------------------------
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/* ----------------------------- configuration ----------------------------- */
const SOURCE       = process.env.LOGO_SOURCE || 'gapfill'; // 'gapfill' | 'thesportsdb'
const CLUBS_PATH   = process.env.CLUBS_PATH  || './data/clubs.json';
const CACHE_DIR    = process.env.CACHE_DIR   || './.logo-cache';
const TSDB_KEY     = process.env.TSDB_KEY    || '3';       // '3' is the free public test key
const RATE_MS      = Number(process.env.RATE_MS || 350);   // delay between live requests
const CLUB_MIN     = Number(process.env.CLUB_MIN || 68);   // min score to accept a club badge
const LEAGUE_MIN   = Number(process.env.LEAGUE_MIN || 70); // min score to accept a league badge
const TSDB = `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}`;

/* country code -> the country name TheSportsDB uses */
const TSDB_COUNTRY = {
  ae:'United Arab Emirates', ar:'Argentina', at:'Austria', au:'Australia',
  ba:'Bosnia and Herzegovina', be:'Belgium', bg:'Bulgaria', br:'Brazil',
  ca:'Canada', ch:'Switzerland', ci:'Ivory Coast', cl:'Chile', cn:'China',
  co:'Colombia', cr:'Costa Rica', cy:'Cyprus', cz:'Czech Republic',
  de:'Germany', dk:'Denmark', dz:'Algeria', ec:'Ecuador', eg:'Egypt',
  es:'Spain', fr:'France', 'gb-eng':'England', 'gb-nir':'Northern Ireland',
  'gb-sct':'Scotland', 'gb-wls':'Wales', gh:'Ghana', gr:'Greece',
  hr:'Croatia', hu:'Hungary', ie:'Ireland', il:'Israel', iq:'Iraq',
  ir:'Iran', it:'Italy', jo:'Jordan', jp:'Japan', kr:'South Korea',
  kw:'Kuwait', kz:'Kazakhstan', lb:'Lebanon', ma:'Morocco', md:'Moldova',
  mx:'Mexico', my:'Malaysia', ng:'Nigeria', nl:'Netherlands', no:'Norway',
  nz:'New Zealand', om:'Oman', pa:'Panama', pe:'Peru', pl:'Poland',
  pt:'Portugal', py:'Paraguay', qa:'Qatar', ro:'Romania', rs:'Serbia',
  ru:'Russia', sa:'Saudi Arabia', sd:'Sudan', se:'Sweden', si:'Slovenia',
  sk:'Slovakia', sn:'Senegal', th:'Thailand', tn:'Tunisia', tr:'Turkey',
  ua:'Ukraine', us:'USA', uy:'Uruguay', uz:'Uzbekistan', ve:'Venezuela',
  vn:'Vietnam', za:'South Africa'
};

/* Explicit logo overrides by Wikidata QID (club or league). Wins over both the
 * existing logo and TheSportsDB. Use this for any logo that is wrong, sponsored,
 * or ugly. Ligue 1's Wikidata logo bakes in the McDonald's sponsor, so we point
 * it at the clean league mark instead. */
const LOGO_OVERRIDE = {
  'Q13394': { logo: 'https://assets.football-logos.cc/logos/france/1500x1500/ligue-1.0cc44ebd.png', logoFmt: 'png' } // Ligue 1 (clean, no sponsor)
};

/* FORCE_TSDB: clubs whose Wikidata logo is present but wrong (a wordmark, a plain
 * text mark, etc). For these we overwrite with the TheSportsDB badge even in
 * gap-fill mode. Inter Miami's Wikidata logo is the "Inter Miami CF" wordmark, so
 * we force its proper heron crest. (LOGO_OVERRIDE still wins if a QID is in both.) */
const FORCE_TSDB = new Set([
  'Q16844931' // Inter Miami CF
]);

/* ------------------------------- utilities ------------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s){
  return (s||'').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/&/g,' and ')
    .replace(/[._'’]/g,'')
    .replace(/[^a-z0-9 ]/g,' ')
    .replace(/\s+/g,' ').trim();
}
// drop noise tokens that hurt matching (club-type words, sponsors, generic terms)
const STOP = new Set(['fc','cf','afc','sc','ac','as','rc','ssc','ass','assoc','association',
  'football','soccer','club','calcio','futbol','futebol','sportif','sporting','de','do',
  'da','of','the','el','la','los','las','i','ii','1','men','mens','women','womens',
  'professional','league','liga','ligue','division','primera','serie','super','premier']);
function tokens(s){ return norm(s).split(' ').filter(t => t && !STOP.has(t)); }

function nameScore(target, candidate){
  const a = norm(target), b = norm(candidate);
  if(!a || !b) return 0;
  if(a === b) return 100;
  if(a.startsWith(b) || b.startsWith(a)) return 86;
  if(a.includes(b) || b.includes(a)) return 74;
  const ta = tokens(target), tb = new Set(tokens(candidate));
  if(!ta.length || !tb.size) return 0;
  let hit = 0; for(const t of ta) if(tb.has(t)) hit++;
  const cover = hit / Math.max(ta.length, tb.size);
  return Math.round(cover * 64); // up to 64 for token overlap
}

/* ------------------------- cached, polite fetching ------------------------ */
let liveCalls = 0;
function cacheFile(url){ return path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json'); }
async function getJSON(url){
  const cf = cacheFile(url);
  if(existsSync(cf)){
    try { return JSON.parse(await readFile(cf, 'utf8')); } catch { /* fall through */ }
  }
  if(liveCalls > 0) await sleep(RATE_MS);
  liveCalls++;
  let data = null;
  for(let attempt = 0; attempt < 3; attempt++){
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'blackout-logos/1.0' } });
      if(res.status === 429){ await sleep(1500 * (attempt + 1)); continue; }
      if(!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      break;
    } catch (e){
      if(attempt === 2){ console.warn('  ! fetch failed', url, String(e.message || e)); data = null; }
      else await sleep(700 * (attempt + 1));
    }
  }
  try { await writeFile(cf, JSON.stringify(data)); } catch { /* cache best-effort */ }
  return data;
}

/* --------------------- logo brightness (light/dark bg) -------------------- */
// Per logo, decide if the ARTWORK is light (so the chip behind it should be
// dark) or dark/colourful (so the chip should be light). We rasterise SVGs via
// Wikimedia's PNG thumbnailer and read pixels with a tiny zero-dependency PNG
// decoder. Only the boolean verdict is cached and stored; image bytes are
// fetched transiently and thrown away (no crests stored locally).
function decodePngLuma(buf){
  if(!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w = 0, h = 0, bit = 0, ct = 0, inter = 0, idat = [], plte = null, trns = null;
  while(pos + 8 <= buf.length){
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), d = buf.slice(pos + 8, pos + 8 + len);
    if(type === 'IHDR'){ w = d.readUInt32BE(0); h = d.readUInt32BE(4); bit = d[8]; ct = d[9]; inter = d[12]; }
    else if(type === 'PLTE') plte = d;
    else if(type === 'tRNS') trns = d;
    else if(type === 'IDAT') idat.push(d);
    else if(type === 'IEND') break;
    pos += 12 + len;
  }
  if(inter !== 0 || bit !== 8) return null; // skip interlaced / 16-bit; caller defaults to light chip
  const chn = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : ct === 3 ? 1 : 0;
  if(!chn) return null;
  let rawb; try { rawb = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * chn, out = Buffer.alloc(h * stride); let prev = Buffer.alloc(stride), ip = 0;
  for(let y = 0; y < h; y++){
    const ft = rawb[ip++], cur = out.slice(y * stride, (y + 1) * stride);
    for(let x = 0; x < stride; x++){
      const a = x >= chn ? cur[x - chn] : 0, b = prev[x], c = x >= chn ? prev[x - chn] : 0; let v = rawb[ip++];
      if(ft === 1) v = (v + a) & 255; else if(ft === 2) v = (v + b) & 255; else if(ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if(ft === 4){ const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      cur[x] = v;
    }
    prev = cur;
  }
  let sum = 0, light = 0, op = 0, tot = w * h;
  for(let i = 0; i < tot; i++){
    const o = i * chn; let r, g, b, al = 255;
    if(ct === 6){ r = out[o]; g = out[o + 1]; b = out[o + 2]; al = out[o + 3]; }
    else if(ct === 2){ r = out[o]; g = out[o + 1]; b = out[o + 2]; }
    else if(ct === 0){ r = g = b = out[o]; }
    else if(ct === 4){ r = g = b = out[o]; al = out[o + 1]; }
    else if(ct === 3){ const idx = out[o]; if(!plte) return null; r = plte[idx*3]; g = plte[idx*3+1]; b = plte[idx*3+2]; al = (trns && idx < trns.length) ? trns[idx] : 255; }
    if(al < 32) continue;
    op++; const lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255; sum += lum; if(lum > 0.8) light++;
  }
  return op ? { meanLum: sum/op, lightFrac: light/op, opaqueFrac: op/tot } : { meanLum: 0, lightFrac: 0, opaqueFrac: 0 };
}
async function getBytes(url){
  if(liveCalls > 0) await sleep(RATE_MS);
  liveCalls++;
  for(let a = 0; a < 3; a++){
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'blackout-logos/1.0' } });
      if(res.status === 429){ await sleep(1500 * (a + 1)); continue; }
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch { if(a === 2) return null; await sleep(500 * (a + 1)); }
  }
  return null;
}
// SVG/large Wikimedia files: rasterise to a 120px PNG via the thumbnailer.
function wmThumbUrl(url){
  const m = url.match(/Special:FilePath\/([^?]+)/i);
  if(!m) return url; // TheSportsDB PNG etc.: use as-is
  const fname = decodeURIComponent(m[1]).replace(/ /g, '_');
  const md5 = crypto.createHash('md5').update(fname).digest('hex');
  const enc = encodeURIComponent(fname);
  const isSvg = /\.svg$/i.test(fname);
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${md5[0]}/${md5.slice(0,2)}/${enc}/120px-${enc}${isSvg ? '.png' : ''}`;
}
let _bg = {}; // url -> 'L' | 'D' | 'x'
const BG_CACHE = path.join(CACHE_DIR, 'bg.json');
async function logoIsLight(url){
  if(!url) return false;
  if(!(url in _bg)){
    const px = await getBytes(wmThumbUrl(url));
    const r = px && decodePngLuma(px);
    _bg[url] = r ? ((r.meanLum > 0.62 || r.lightFrac > 0.5) ? 'L' : 'D') : 'x';
  }
  return _bg[url] === 'L';
}

/* ------------------------------ TheSportsDB ------------------------------- */
const FEM = /\b(women|woman|ladies|femenin\w*|femin\w*|feminin\w*|frauen|femminile|feminino|dames|damen|\(w\))\b|damallsvenskan|feminine/i;
const DEV = /\b(u\s?-?\s?1[5-9]|u\s?-?\s?2[0-3]|under\s?-?\s?\d+|youth|academy|development|reserves?|junior\w*|juvenil\w*|sub\s?-?\s?\d+)\b/i;
async function tsdbClubBadge(name, cc){
  const wantCountry = TSDB_COUNTRY[cc] || null;
  const targetFem = FEM.test(name), targetDev = DEV.test(name);
  const variants = [], seenV = {};
  const addV = (s) => { s = (s||'').replace(/\s+/g,' ').trim(); const k = norm(s); if(s && k.length >= 3 && !seenV[k]){ seenV[k] = 1; variants.push(s); } };
  addV(name);
  const cleaned = name
    .replace(/\b(F\.?C\.?|C\.?F\.?|A\.?F\.?C\.?|S\.?C\.?|A\.?C\.?|A\.?S\.?|R\.?C\.?|S\.?S\.?C\.?|U\.?S\.?|C\.?D\.?|S\.?D\.?|U\.?D\.?|S\.?V\.?|F\.?K\.?|N\.?K\.?|G\.?N\.?K\.?|VfB|VfL|BSC)\b/gi, ' ')
    .replace(/\b(club de f[u\u00fa]tbol|f[u\u00fa]tbol club|football club|associazione calcio|calcio|sporting clube?|sport club|sociedade?|associa[c\u00e7][a\u00e3]o(?: do)?)\b/gi, ' ')
    .replace(/\s+/g,' ').trim();
  addV(cleaned);
  const ctoks = cleaned.split(' ').filter(Boolean);
  if(ctoks.length >= 2) addV(ctoks.slice(0,2).join(' '));
  const tries = variants;

  let best = null;
  for(const q of tries){
    const data = await getJSON(`${TSDB}/searchteams.php?t=${encodeURIComponent(q)}`);
    const teams = (data && data.teams) || [];
    for(const t of teams){
      if(t.strSport && t.strSport !== 'Soccer') continue;
      if(!t.strBadge) continue;
      if((t.strGender || '').toLowerCase() === 'female' && !targetFem) continue;       // men's WC: skip women's sides
      const nm = t.strTeam || '';
      if((FEM.test(nm) || FEM.test(t.strAlternate || '')) && !targetFem) continue;       // name-based women's guard
      const cands = [t.strTeam, ...String(t.strAlternate || '').split(',')];
      let s = 0; for(const c of cands) s = Math.max(s, nameScore(name, c));
      if(wantCountry && t.strCountry){
        if(norm(t.strCountry) === norm(wantCountry)) s += 16;
        else s -= 12; // wrong country is a real signal it is the wrong club
      }
      if(DEV.test(nm) && !targetDev) s -= 25;                                            // prefer the senior side over youth/reserve
      const len = norm(nm).length;
      if(!best || s > best.score || (s === best.score && len < best.len)) best = { score:s, badge:t.strBadge, team:t.strTeam, country:t.strCountry, len };
    }
    if(best && best.score >= 116) break; // exact senior + country match, stop early
  }
  return (best && best.score >= CLUB_MIN) ? best : null;
}

const _leagueCache = {}; // ccName -> [{name,badge}]
async function tsdbLeaguesForCountry(cc){
  const country = TSDB_COUNTRY[cc];
  if(!country) return [];
  if(_leagueCache[country]) return _leagueCache[country];
  const data = await getJSON(`${TSDB}/search_all_leagues.php?c=${encodeURIComponent(country)}&s=Soccer`);
  const rows = (data && (data.countrys || data.countries || data.leagues)) || [];
  const out = rows.map(l => ({ name: l.strLeague, badge: l.strBadge || l.strLogo || null }))
                  .filter(l => l.name && l.badge);
  _leagueCache[country] = out;
  return out;
}
async function tsdbLeagueBadge(leagueName, cc){
  const list = await tsdbLeaguesForCountry(cc);
  const targetFem = FEM.test(leagueName);
  let best = null;
  for(const l of list){
    let s = nameScore(leagueName, l.name);
    if(FEM.test(l.name) && !targetFem) s -= 40; // e.g. Allsvenskan must beat Damallsvenskan
    const len = norm(l.name).length;
    if(!best || s > best.score || (s === best.score && len < best.len)) best = { score:s, badge:l.badge, name:l.name, len };
  }
  return (best && best.score >= LEAGUE_MIN) ? best : null;
}

/* --------------------------------- main ---------------------------------- */
async function main(){
  if(!existsSync(CLUBS_PATH)){
    console.error(`clubs.json not found at ${CLUBS_PATH}. Run this from your project root (where clubs.json lives), or set CLUBS_PATH.`);
    process.exit(1);
  }
  await mkdir(CACHE_DIR, { recursive: true });
  const raw = await readFile(CLUBS_PATH, 'utf8');
  const indent = /\{\n /.test(raw) ? 1 : 0;
  const doc = JSON.parse(raw);
  const clubs = doc.clubs || {};
  const leagues = doc.leagues || {};
  const overwrite = SOURCE === 'thesportsdb';

  const isNat = c => /national/i.test(c.name || '') && /team/i.test(c.name || '');
  const before = { club: 0, clubTot: 0, league: 0, leagueTot: 0 };

  console.log(`build-logos · source=${SOURCE} · key=${TSDB_KEY}`);
  console.log('Reading', CLUBS_PATH);

  // explicit overrides win over everything; apply before gap-fill + propagation
  for(const [qid, ov] of Object.entries(LOGO_OVERRIDE)){
    if(clubs[qid]){ clubs[qid].logo = ov.logo; clubs[qid].logoFmt = ov.logoFmt || clubs[qid].logoFmt; clubs[qid].logoSrc = 'override'; }
    if(leagues[qid]){ leagues[qid].logo = ov.logo; leagues[qid].logoFmt = ov.logoFmt || leagues[qid].logoFmt; leagues[qid].logoSrc = 'override'; }
  }
  try { _bg = JSON.parse(await readFile(BG_CACHE, 'utf8')); } catch { _bg = {}; }

  /* ---- leagues first, so we can propagate to each club's currentLeague ---- */
  const leagueKeys = Object.keys(leagues);
  before.leagueTot = leagueKeys.length;
  let lFilled = 0;
  for(let i = 0; i < leagueKeys.length; i++){
    const lq = leagueKeys[i];
    const L = leagues[lq];
    if(L.logo) before.league++;
    const need = overwrite || !L.logo;
    if(need && L.name && L.country){
      const hit = await tsdbLeagueBadge(L.name, L.country);
      if(hit && (overwrite || !L.logo)){
        L.logo = hit.badge; L.logoFmt = 'png'; L.logoSrc = 'thesportsdb';
        lFilled++;
        if(lFilled <= 12) console.log(`  league  ${L.name}  ->  ${hit.name} (${hit.score})`);
      }
    }
    if((i + 1) % 25 === 0) process.stdout.write(`  ...leagues ${i + 1}/${leagueKeys.length}\r`);
  }
  console.log(`\n  league logos added: ${lFilled}`);

  /* ---- clubs ---- */
  const clubKeys = Object.keys(clubs).filter(q => !isNat(clubs[q]));
  before.clubTot = clubKeys.length;
  let cFilled = 0;
  for(let i = 0; i < clubKeys.length; i++){
    const q = clubKeys[i];
    const c = clubs[q];
    if(c.logo) before.club++;
    const forceT = FORCE_TSDB.has(q) && !LOGO_OVERRIDE[q];
    const need = overwrite || !c.logo || forceT;
    if(need && c.name){
      const hit = await tsdbClubBadge(c.name, c.flag || c.clubCountry);
      if(hit && (overwrite || !c.logo || forceT)){
        c.logo = hit.badge; c.logoFmt = 'png'; c.logoSrc = 'thesportsdb';
        cFilled++;
        if(cFilled <= 14) console.log(`  club    ${c.name}  ->  ${hit.team} [${hit.country||'?'}] (${hit.score})`);
      }
    }
    if((i + 1) % 25 === 0) process.stdout.write(`  ...clubs ${i + 1}/${clubKeys.length}\r`);
  }
  console.log(`\n  club logos added: ${cFilled}`);

  /* ---- propagate canonical league logos onto each club's currentLeague ---- */
  let propagated = 0;
  for(const q of clubKeys){
    const c = clubs[q], cl = c.currentLeague;
    if(!cl || !cl.leagueQid) continue;
    const L = leagues[cl.leagueQid];
    if(L && L.logo && (overwrite || !cl.logo)){
      cl.logo = L.logo; cl.logoFmt = L.logoFmt || 'png'; cl.logoSrc = L.logoSrc || cl.logoSrc;
      propagated++;
    }
  }

  /* ---- per-logo background: light artwork -> dark chip, else light chip ---- */
  // only analyse logos the app actually shows: leagues + rostered clubs
  let rostered = null;
  try { const pc = (JSON.parse(await readFile('./data/players-clubs.json', 'utf8')).teams) || {}; rostered = new Set(); for(const tm in pc) for(const pn in pc[tm]){ const q = pc[tm][pn].club; if(q) rostered.add(q); } } catch { rostered = null; }
  const bgTargets = [];
  for(const lq of leagueKeys) if(leagues[lq].logo) bgTargets.push(leagues[lq]);
  for(const q of clubKeys) if(clubs[q].logo && (!rostered || rostered.has(q))) bgTargets.push(clubs[q]);
  let lightN = 0, darkN = 0, doneN = 0;
  for(const rec of bgTargets){
    rec.logoLight = await logoIsLight(rec.logo);
    rec.logoLight ? lightN++ : darkN++;
    if(++doneN % 25 === 0){ process.stdout.write(`  ...brightness ${doneN}/${bgTargets.length}\r`); try { await writeFile(BG_CACHE, JSON.stringify(_bg)); } catch {} }
  }
  try { await writeFile(BG_CACHE, JSON.stringify(_bg)); } catch {}
  // carry each league's verdict onto every club's currentLeague block
  for(const q of clubKeys){ const cl = clubs[q].currentLeague; if(cl && cl.leagueQid && leagues[cl.leagueQid]) cl.logoLight = !!leagues[cl.leagueQid].logoLight; }
  console.log(`\n  brightness: ${lightN} light-art (dark chip) \u00b7 ${darkN} dark/colour (light chip)`);

  /* ---- write back + report ---- */
  doc.logosBuiltAt = new Date().toISOString();
  await writeFile(CLUBS_PATH, JSON.stringify(doc, null, indent));

  const after = { club: 0, league: 0 };
  for(const q of clubKeys) if(clubs[q].logo) after.club++;
  for(const lq of leagueKeys) if(leagues[lq].logo) after.league++;

  const pct = (n, d) => d ? Math.round(100 * n / d) + '%' : 'n/a';
  console.log('\n----------------------------------------');
  console.log(`Clubs   : ${before.club}/${before.clubTot} (${pct(before.club, before.clubTot)})  ->  ${after.club}/${before.clubTot} (${pct(after.club, before.clubTot)})`);
  console.log(`Leagues : ${before.league}/${before.leagueTot} (${pct(before.league, before.leagueTot)})  ->  ${after.league}/${before.leagueTot} (${pct(after.league, before.leagueTot)})`);
  console.log(`Club currentLeague logos propagated: ${propagated}`);
  console.log(`Live TheSportsDB requests this run: ${liveCalls} (rest served from ${CACHE_DIR})`);
  console.log(`Wrote ${CLUBS_PATH}. Re-upload it to refresh the logos in the app.`);
}

main().catch(e => { console.error(e); process.exit(1); });
