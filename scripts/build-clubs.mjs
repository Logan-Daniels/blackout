/*
 * build-clubs.mjs  ·  Wikidata -> clubs.json + players-clubs.json   (v2: league timeline)
 *
 * Resolves every squad player in players.json to a Wikidata QID, then pulls club facts
 * from structured data (no AI invents any of it): DOB + age, current club, full club
 * history with dates, shirt-number spells per club, and national-team number history.
 *
 * LEAGUE OVER TIME. A club is NOT in one league forever (promotion/relegation), so each
 * club stores:
 *     currentLeague : { league, leagueQid, tier }     <- the site shows this now
 *     leagueHistory : [ { season, league, leagueQid, tier, from, to, source } ]
 * leagueHistory is built from Wikidata P118 statements (sparse) PLUS a "recorded" entry
 * for the current season on every run. Because the script reads the existing clubs.json
 * and preserves prior leagueHistory, re-running each season accumulates a real
 * season-by-season record going forward. (Deep pre-2026 backfill needs a season-level
 * source; the schema is ready for it.)
 *
 * SHARED LEAGUES (US/Canada, England/Wales) - one rule:
 *   tier  = always bucketed by the LEAGUE's system (the pyramid the club competes in)
 *   flag  = the club's OWN country when Wikidata gives a specific nation, else the
 *           league's country. Home-nation league systems are forced by name so English
 *           clubs (Wikidata country = "United Kingdom") resolve to England, etc.
 *
 * Outputs clubs.json (master) + players-clubs.json (per-player overlay merged at runtime,
 * so build-players.mjs photo re-runs never clobber club data).
 *
 * CANNOT run in the sandbox (no Wikidata egress). Run locally. Caches to ./cache (resumable).
 *   Offline logic check:  node build-clubs.mjs --selftest
 *   Smoke test (network):  node build-clubs.mjs --teams "Canada,France"
 * then send me the unmappedLeagues list + one clubs.json entry + one players-clubs entry.
 *
 * Node 20+. No external deps.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { LEAGUE_TIERS } from './league-tiers.mjs';

/* ---- config ---- */
const UA = 'BLACKOUT-wc-app/1.0 (contact: l.b.daniels@lse.ac.uk)';
const REQ_DELAY = 320;
const SEARCH_LIMIT = 7;
const TODAY = new Date();
const CACHE = 'cache', ENT_DIR = `${CACHE}/entities`, RESOLVE_FILE = `${CACHE}/wd-resolve.json`;

/* ---- Wikidata ids (load-bearing ones flagged where unverified) ---- */
const P = {
  dob: 'P569', occupation: 'P106', citizenship: 'P27', memberTeam: 'P54',
  start: 'P580', end: 'P582',
  number: 'P1618',   // SMOKE TEST: confirm P1618 carries the shirt number as a P54 qualifier
  instanceOf: 'P31', country: 'P17', league: 'P118', logo: 'P154',
  sport: 'P641',     // used to drop a multi-sport club's basketball/volleyball league memberships
  fbref: 'P5750',    // SMOKE TEST: confirm P5750 is the FBref club/squad id (fallback to name search either way)
};
const Q_FOOTBALLER = 'Q937857';
const Q_FOOTBALL = 'Q2736';           // association football (sport), to keep only football leagues
const Q_NATIONAL_TEAM = 'Q6979593';   // SMOKE TEST: national association football team

/* ---- country label -> flagcdn code (matches app flag(), incl. home nations) ---- */
const ISO = {
  england: 'gb-eng', scotland: 'gb-sct', wales: 'gb-wls', 'northern ireland': 'gb-nir', 'united kingdom': 'gb',
  spain: 'es', italy: 'it', germany: 'de', france: 'fr', netherlands: 'nl', portugal: 'pt', belgium: 'be',
  switzerland: 'ch', austria: 'at', greece: 'gr', turkey: 'tr', turkiye: 'tr', croatia: 'hr',
  czechia: 'cz', 'czech republic': 'cz', denmark: 'dk', norway: 'no', sweden: 'se', poland: 'pl',
  ukraine: 'ua', russia: 'ru', serbia: 'rs', romania: 'ro', hungary: 'hu', bulgaria: 'bg', slovakia: 'sk',
  slovenia: 'si', cyprus: 'cy', 'bosnia and herzegovina': 'ba', ireland: 'ie', 'republic of ireland': 'ie',
  iceland: 'is', finland: 'fi',
  'united states': 'us', 'united states of america': 'us', canada: 'ca', mexico: 'mx', 'costa rica': 'cr',
  panama: 'pa', honduras: 'hn', jamaica: 'jm', haiti: 'ht',
  brazil: 'br', argentina: 'ar', colombia: 'co', uruguay: 'uy', paraguay: 'py', ecuador: 'ec',
  chile: 'cl', peru: 'pe', bolivia: 'bo',
  'saudi arabia': 'sa', qatar: 'qa', 'united arab emirates': 'ae', iran: 'ir', iraq: 'iq', japan: 'jp',
  'south korea': 'kr', australia: 'au', uzbekistan: 'uz', jordan: 'jo', china: 'cn',
  "people's republic of china": 'cn', thailand: 'th', india: 'in',
  lebanon: 'lb', malaysia: 'my', bahrain: 'bh', kuwait: 'kw', oman: 'om',
  sudan: 'sd', angola: 'ao', moldova: 'md', myanmar: 'mm', vietnam: 'vn', israel: 'il', kazakhstan: 'kz',
  egypt: 'eg', morocco: 'ma', tunisia: 'tn', algeria: 'dz', 'south africa': 'za', ghana: 'gh',
  senegal: 'sn', "cote d'ivoire": 'ci', 'ivory coast': 'ci', 'dr congo': 'cd',
  'democratic republic of the congo': 'cd', nigeria: 'ng', 'cape verde': 'cv', 'cabo verde': 'cv',
  'new zealand': 'nz',
};

/* force home-nation league systems by league name (Wikidata calls English clubs "UK") */
const LEAGUE_COUNTRY_OVERRIDE = {};
for (const lg of ['premier league', 'efl championship', 'championship', 'efl league one', 'league one',
  'efl league two', 'league two', 'national league', 'national league north', 'national league south',
  'northern premier league', 'northern premier league premier division', 'southern football league',
  'isthmian league', 'united counties league']) LEAGUE_COUNTRY_OVERRIDE[lg] = 'England';
for (const lg of ['scottish premiership', 'premiership', 'scottish championship', 'scottish league one',
  'scottish premier league', 'scottish football league', 'scottish professional football league',
  'scottish football league first division', 'scottish football league second division',
  'scottish football league third division', 'lowland football league', 'highland football league'])
  LEAGUE_COUNTRY_OVERRIDE[lg] = 'Scotland';
LEAGUE_COUNTRY_OVERRIDE['cymru premier'] = 'Wales';

/* country-label variants Wikidata uses that must map to the canonical bucket name */
const COUNTRY_ALIAS = {};
for (const [k, v] of Object.entries({ "people's republic of china": 'China', 'german reich': 'Germany',
  'west germany': 'Germany', 'second polish republic': 'Poland', 'czech republic': 'Czechia',
  'ivory coast': "Cote d'Ivoire" }))
  COUNTRY_ALIAS[k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] = v;

/* leagues played on a calendar year rather than cross-year (season label only; adjustable) */
const CALENDAR_YEAR = new Set(['brazil', 'united states', 'canada', 'sweden', 'norway', 'finland',
  'iceland', 'japan', 'south korea', 'ireland', 'republic of ireland', 'china']);
// NOTE: MLS (US/Canada) is calendar-year through 2026 and shifts cross-year from 2027; revisit then.

/* ---- pure helpers (covered by --selftest) ---- */
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function seasonLabel(d, countryNorm) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  const Y = dt.getFullYear(), M = dt.getMonth() + 1;
  if (CALENDAR_YEAR.has(countryNorm)) return String(Y);
  const start = M >= 8 ? Y : Y - 1;            // Aug+ starts new cross-year season; off-season -> just-ended
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
const ISO_N = {}; for (const [k, v] of Object.entries(ISO)) ISO_N[norm(k)] = v;   // normalized keys, so apostrophes/accents match
const flagCode = lbl => ISO_N[norm(lbl)] || null;
const specificFlag = lbl => { const c = flagCode(lbl); return c && c !== 'gb' ? c : null; };  // generic UK is not specific
const flagFor = (clubLbl, leagueLbl) => specificFlag(clubLbl) || flagCode(leagueLbl) || null;
const canonCountry = lbl => lbl == null ? null : (COUNTRY_ALIAS[norm(lbl)] || lbl);

// "2005-06 Serie C1" / "2023 Major League Soccer" -> drop the leading season token before lookup
const stripSeason = s => String(s || '').replace(/^\s*\d{4}\s*[–-]\s*\d{2,4}\s+/, '').replace(/^\s*\d{4}\s+/, '').trim();

// competitions that are not a domestic league tier: skip them entirely (cups, continental, women's, youth).
const NON_LEAGUE_EXACT = new Set(['scottish football alliance', 'scottish football federation',
  'central football league', 'midland football league in scotland', 'liga f'].map(norm));
const NON_LEAGUE_KW = ['copa', 'coppa', 'cup', 'taca', 'champions', 'libertadores', 'sudamericana', 'recopa',
  'supercopa', 'women', 'womens', 'femenin', 'feminin', 'frauen', 'juvenil', 'primavera', 'youth',
  'beloften', 'development', 'basket', 'basquet', 'voleibol', 'volleyball', 'voley', 'futsal'];
function isNonLeague(name) { const n = norm(name); return NON_LEAGUE_EXACT.has(n) || NON_LEAGUE_KW.some(k => n.includes(k)); }

function mergeLeagueHistory(existing, incoming) {
  const key = e => e.season || `${e.leagueQid || '?'}@${e.from || ''}`;
  const map = new Map();
  for (const e of (existing || [])) map.set(key(e), e);
  for (const e of (incoming || [])) map.set(key(e), { ...(map.get(key(e)) || {}), ...e });  // fresher wins
  return [...map.values()].sort((a, b) => String(a.season || a.from || '').localeCompare(String(b.season || b.from || '')));
}

/* ---- selftest: verify the non-network logic offline ---- */
if (process.argv.includes('--selftest')) {
  let ok = 0, fail = 0;
  const eq = (got, want, msg) => { const p = JSON.stringify(got) === JSON.stringify(want); console.log(`${p ? 'ok  ' : 'FAIL'} ${msg}${p ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); p ? ok++ : fail++; };
  eq(seasonLabel(new Date('2026-06-17'), 'england'), '2025-26', 'June 2026 (cross-year) -> 2025-26');
  eq(seasonLabel(new Date('2025-09-01'), 'england'), '2025-26', 'Sep 2025 -> 2025-26');
  eq(seasonLabel(new Date('2026-03-01'), 'england'), '2025-26', 'Mar 2026 -> 2025-26');
  eq(seasonLabel(new Date('2026-06-17'), 'brazil'), '2026', 'June 2026 (calendar) -> 2026');
  eq(flagFor('Canada', 'United States'), 'ca', 'Canadian club in MLS -> Canada flag');
  eq(flagFor('United States', 'United States'), 'us', 'US club in MLS -> US flag');
  eq(flagFor('Wales', 'England'), 'gb-wls', 'Welsh club in English system -> Wales flag');
  eq(flagFor('United Kingdom', 'England'), 'gb-eng', 'UK-generic club, league England -> gb-eng');
  eq(flagFor('Germany', 'Germany'), 'de', 'German club -> Germany flag');
  const merged = mergeLeagueHistory(
    [{ season: '2023-24', league: 'EFL Championship', tier: 2 }, { season: '2024-25', league: 'Premier League', tier: 1 }],
    [{ season: '2024-25', league: 'Premier League', tier: 1, source: 'recorded' }, { season: '2025-26', league: 'Premier League', tier: 1, source: 'recorded' }]);
  eq(merged.map(e => e.season), ['2023-24', '2024-25', '2025-26'], 'leagueHistory preserves past + upserts current');
  eq(merged.find(e => e.season === '2024-25').source, 'recorded', 'same-season entry updated, not duplicated');
  eq(stripSeason('2005–06 Serie C1'), 'Serie C1', 'strip cross-year season prefix');
  eq(stripSeason('2023 Major League Soccer'), 'Major League Soccer', 'strip calendar-year season prefix');
  eq(isNonLeague('Copa Libertadores'), true, 'continental cup is non-league');
  eq(isNonLeague('CONCACAF Champions Cup'), true, 'champions cup is non-league');
  eq(isNonLeague('Liga F'), true, "women's Liga F is non-league");
  eq(isNonLeague('Campionato Primavera 1'), true, 'youth league is non-league');
  eq(isNonLeague('Liga MX'), false, 'a real league is not flagged non-league');
  eq(canonCountry("People's Republic of China"), 'China', 'canonicalise China label');
  eq(canonCountry('German Reich'), 'Germany', 'canonicalise German Reich label');
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

/* ---- io ---- */
const delay = ms => new Promise(r => setTimeout(r, ms));
const loadJSON = (p, d) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d;
const saveJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
if (!existsSync(CACHE)) mkdirSync(CACHE);
if (!existsSync(ENT_DIR)) mkdirSync(ENT_DIR);

/* normalized tier lookup: { normCountry: { normLeague: tier } } */
const TIERS = {};
for (const [country, leagues] of Object.entries(LEAGUE_TIERS)) {
  const nc = norm(country); TIERS[nc] = TIERS[nc] || {};
  for (const [lg, tier] of Object.entries(leagues)) TIERS[nc][norm(lg)] = tier;
}

/* ---- network (cached) ---- */
let netCalls = 0;
async function wd(url) {
  netCalls++; await delay(REQ_DELAY);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429) { console.log('  throttled, backing off 5s'); await delay(5000); return wd(url); }
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
async function search(name) {
  const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}`
    + `&language=en&uselang=en&format=json&type=item&limit=${SEARCH_LIMIT}`;
  return (await wd(u)).search || [];
}
async function entity(qid) {
  const f = `${ENT_DIR}/${qid}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const data = await wd(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const e = data.entities?.[qid] || null;
  if (e) writeFileSync(f, JSON.stringify(e));
  return e;
}

/* ---- claim readers ---- */
const claims = e => (e && e.claims) || {};
const labelOf = e => e?.labels?.en?.value || null;
const mainIds = (e, prop) => (claims(e)[prop] || []).map(s => s.mainsnak?.datavalue?.value?.id).filter(Boolean);
function wdTime(snak) {
  const t = snak?.datavalue?.value?.time; if (!t) return null;
  const m = /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(t); if (!m) return null;
  let [, y, mo, d] = m; if (mo === '00') mo = '01'; if (d === '00') d = '01';
  return `${y}-${mo}-${d}`;
}
const qualOne = (stmt, prop) => (stmt.qualifiers?.[prop] || [])[0] || null;
function qualNumber(stmt) {
  const v = qualOne(stmt, P.number)?.datavalue?.value; if (v == null) return null;
  if (typeof v === 'object') return String(v.amount != null ? Math.round(+v.amount) : (v.id || '')).replace('+', '');
  return String(v);
}
function ageFrom(dob) {
  if (!dob) return null; const b = new Date(dob); if (isNaN(b)) return null;
  let a = TODAY.getFullYear() - b.getFullYear(); const m = TODAY.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && TODAY.getDate() < b.getDate())) a--; return a;
}
const dateMax = arr => arr.reduce((x, y) => (!x ? y : (!y ? x : (x > y ? x : y))), null);

// logos: among P154 values prefer an SVG (vector, usually transparent, scales cleanly),
// and record the format so the UI can treat raster logos (which may carry a baked
// background, JPG always does) differently from safe vector ones.
function logoFileOf(e) {
  const vals = (claims(e)[P.logo] || []).map(s => s.mainsnak?.datavalue?.value).filter(Boolean);
  return vals.find(f => /\.svg$/i.test(f)) || vals[0] || null;
}
function commonsLogo(file) {
  if (!file) return null;
  const fmt = (file.split('.').pop() || '').toLowerCase();
  return { url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=120`, fmt };
}

/* ---- AI fallback seam (off by default). Wikidata-first; this is only for misses. ---- */
// Return a club QID string or null. If/when enabled, wire to the Anthropic API with the
// web_search tool to find the player's CURRENT club, then map the answer back to a QID via
// search(). Tag any result as source:'ai' so it is visibly lower-confidence than Wikidata.
async function aiFallback(/* name, teamName, aliasSet */) { return null; }

/* ---- resolve a player name to a footballer QID of the right nationality ---- */
const resolveCache = loadJSON(RESOLVE_FILE, {});
async function resolvePlayer(name, teamAliasSet) {
  const key = norm(name);
  if (key in resolveCache) return resolveCache[key] === 'MISS' ? null : resolveCache[key];
  const scored = [];
  for (const c of await search(name)) {
    const desc = norm(c.description || '');
    const looksFoot = /footballer|soccer|football player/.test(desc);
    const e = await entity(c.id); if (!e) continue;
    if (!(mainIds(e, P.occupation).includes(Q_FOOTBALLER) || looksFoot)) continue;
    let natOk = false;
    for (const cQid of mainIds(e, P.citizenship)) {
      if (teamAliasSet.has(norm(labelOf(await entity(cQid))))) { natOk = true; break; }
    }
    scored.push({ qid: c.id, natOk, nP54: (claims(e)[P.memberTeam] || []).length });
  }
  scored.sort((a, b) => (Number(b.natOk) - Number(a.natOk)) || (b.nP54 - a.nP54));
  const best = scored[0];
  const qid = (best && best.natOk) ? best.qid : (best ? best.qid : null);
  resolveCache[key] = qid || 'MISS';
  return qid;
}

/* ---- player facts (DOB, age, club history with number spells, national numbers) ---- */
async function playerFacts(qid, teamAliasSet) {
  const e = await entity(qid); if (!e) return null;
  const born = wdTime((claims(e)[P.dob] || [])[0]?.mainsnak), age = ageFrom(born);
  const clubSpells = {}, natNumbers = [];
  for (const st of (claims(e)[P.memberTeam] || [])) {
    const teamQid = st.mainsnak?.datavalue?.value?.id; if (!teamQid) continue;
    const from = wdTime(qualOne(st, P.start)), to = wdTime(qualOne(st, P.end)), num = qualNumber(st);
    const te = await entity(teamQid);
    const isNat = mainIds(te, P.instanceOf).includes(Q_NATIONAL_TEAM) || teamAliasSet.has(norm(labelOf(te)));
    if (isNat) { if (num != null) natNumbers.push({ num, from, to }); continue; }
    (clubSpells[teamQid] = clubSpells[teamQid] || []).push({ from, to, num });
  }
  const clubHistory = Object.entries(clubSpells).map(([club, spells]) => {
    spells.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    const ongoing = spells.some(s => !s.to);
    return { club, from: spells[0]?.from || null, to: ongoing ? null : dateMax(spells.map(s => s.to)),
      numbers: spells.filter(s => s.num != null).map(s => ({ num: s.num, from: s.from, to: s.to })) };
  });
  const current = clubHistory.find(c => c.to === null)
    || clubHistory.slice().sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')))[0] || null;
  return { qid, born, age, club: current ? current.club : null, clubHistory, natNumbers, _clubQids: Object.keys(clubSpells) };
}

/* ---- resolve one league statement -> {name, leagueQid, country (own), bucket, tier, logo} ---- */
async function leagueInfo(leagueQid, clubCountryLbl) {
  const le = await entity(leagueQid);
  let name = labelOf(le);
  if (!name) return { name: null, leagueQid };
  name = stripSeason(name);
  const sport = mainIds(le, P.sport)[0];
  if (sport && sport !== Q_FOOTBALL) return { name, leagueQid, nonFootball: true };  // basketball/volleyball on a multi-sport club
  if (isNonLeague(name)) return { name, leagueQid, nonLeague: true };                // cups, continental, women's, youth
  const rawCountry = mainIds(le, P.country)[0] ? labelOf(await entity(mainIds(le, P.country)[0])) : null;
  const country = LEAGUE_COUNTRY_OVERRIDE[norm(name)] || canonCountry(rawCountry);   // league's own country (drives the flag)
  const bucket = country || canonCountry(clubCountryLbl);                            // fall back to the club's country for the tier
  let tier;
  const nc = norm(bucket), nl = norm(name);
  if (TIERS[nc] && nl in TIERS[nc]) tier = TIERS[nc][nl];
  const lg = commonsLogo(logoFileOf(le));
  return { name, leagueQid, country, bucket, tier: tier === undefined ? null : tier,
    logo: lg?.url || null, logoFmt: lg?.fmt || null, unmapped: tier === undefined };
}

/* ---- club details (identity + league timeline), merged with existing clubs.json ---- */
const clubsOut = {};
const leaguesOut = {};
const unmapped = {};
let prevClubs = {};
async function clubDetails(qid, sampleName) {
  if (clubsOut[qid]) return;
  const e = await entity(qid);
  if (!e) { clubsOut[qid] = { name: qid, clubCountry: null, flag: null, leagueCountry: null, fbref: null, logo: null, currentLeague: null, leagueHistory: prevClubs[qid]?.leagueHistory || [] }; return; }
  const name = labelOf(e) || qid;
  const clubCountryLbl = mainIds(e, P.country)[0] ? labelOf(await entity(mainIds(e, P.country)[0])) : null;

  // walk P118 statements -> historical league entries
  const stmts = claims(e)[P.league] || [];
  const wdHistory = [];
  let currentStmt = null, currentInfo = null;
  for (const st of stmts) {
    const lQid = st.mainsnak?.datavalue?.value?.id; if (!lQid) continue;
    const from = wdTime(qualOne(st, P.start)), to = wdTime(qualOne(st, P.end));
    const info = await leagueInfo(lQid, clubCountryLbl);
    if (info.nonFootball || info.nonLeague) continue;   // drop non-football and non-league (cups/women's/youth) memberships
    if (info.unmapped) {
      const k = `${info.bucket || '?'}::${info.name}`;
      if (!unmapped[k]) unmapped[k] = { league: info.name, country: info.bucket, clubExample: sampleName || name };
    }
    if (info.leagueQid) leaguesOut[info.leagueQid] = { name: info.name, country: flagCode(info.bucket), tier: info.tier, logo: info.logo, logoFmt: info.logoFmt };
    wdHistory.push({ season: seasonLabel(from, norm(info.bucket)), league: info.name, leagueQid: info.leagueQid,
      tier: info.tier, from, to, source: 'wikidata-p118' });
    if (!to && !currentStmt) { currentStmt = st; currentInfo = info; }  // ongoing football statement = current league
  }
  if (!currentInfo && stmts.length) {                                   // fallback: latest-starting football statement
    let bestFrom = '', best = null;
    for (const st of stmts) {
      const q = st.mainsnak?.datavalue?.value?.id; if (!q) continue;
      const info = await leagueInfo(q, clubCountryLbl); if (info.nonFootball || info.nonLeague) continue;
      const f = wdTime(qualOne(st, P.start)) || '';
      if (f >= bestFrom) { bestFrom = f; best = info; }
    }
    currentInfo = best;
  }

  const leagueCountryLbl = currentInfo?.bucket || null;
  const currentLeague = currentInfo ? { league: currentInfo.name, leagueQid: currentInfo.leagueQid, tier: currentInfo.tier, logo: currentInfo.logo, logoFmt: currentInfo.logoFmt } : null;

  // record the current season from THIS run, then merge over prior history (accumulates each season)
  const recorded = currentInfo ? [{ season: seasonLabel(TODAY, norm(leagueCountryLbl)), league: currentInfo.name,
    leagueQid: currentInfo.leagueQid, tier: currentInfo.tier, from: null, to: null, source: 'recorded' }] : [];
  const leagueHistory = mergeLeagueHistory(prevClubs[qid]?.leagueHistory, [...wdHistory, ...recorded]);

  const fbrefId = (claims(e)[P.fbref] || [])[0]?.mainsnak?.datavalue?.value || null;
  const fbref = fbrefId ? `https://fbref.com/en/squads/${fbrefId}/`               // SMOKE TEST: confirm URL shape
    : `https://fbref.com/search/search.fcgi?search=${encodeURIComponent(name)}`;
  const clubLogo = commonsLogo(logoFileOf(e));

  clubsOut[qid] = {
    name,
    clubCountry: flagCode(clubCountryLbl),
    flag: flagFor(clubCountryLbl, leagueCountryLbl),   // club nation if specific, else league country
    leagueCountry: flagCode(leagueCountryLbl),
    fbref, logo: clubLogo?.url || null, logoFmt: clubLogo?.fmt || null, currentLeague, leagueHistory,
  };
}

/* ---- main ---- */
const players = loadJSON('data/players.json', { teams: {} });
const aliases = loadJSON('data/wc-fixtures.json', { aliases: {} }).aliases || {};
prevClubs = loadJSON('data/clubs.json', {}).clubs || {};   // preserve prior league history across runs

const arg = process.argv.indexOf('--teams');
const only = arg > -1 ? process.argv[arg + 1].split(',').map(s => s.trim()) : null;
const teamNames = Object.keys(players.teams).filter(t => !only || only.includes(t));
console.log(`build-clubs v2: ${teamNames.length} team(s)${only ? ' (smoke test)' : ''}, ~${REQ_DELAY}ms/request\n`);

const overlay = { v: 2, generatedAt: new Date().toISOString(), teams: {} };
let resolved = 0, missed = 0;
for (const team of teamNames) {
  const aliasSet = new Set([norm(team), ...(aliases[team] || []).map(norm)]);
  overlay.teams[team] = {};
  process.stdout.write(`${team}: `);
  for (const p of (players.teams[team].players || [])) {
    let facts = null;
    try {
      let qid = await resolvePlayer(p.name, aliasSet);
      if (!qid) qid = await aiFallback(p.name, team, aliasSet);   // off by default
      if (qid) facts = await playerFacts(qid, aliasSet);
    } catch (err) { console.log(`\n  ! ${p.name}: ${err.message}`); }
    if (facts && facts.qid) {
      resolved++; process.stdout.write('.');
      for (const cq of facts._clubQids) await clubDetails(cq, facts.club === cq ? `${p.name} (${team})` : null);
      delete facts._clubQids;
      overlay.teams[team][p.name] = facts;
    } else { missed++; process.stdout.write('x'); }
    saveJSON(RESOLVE_FILE, resolveCache);
  }
  process.stdout.write('\n');
}

saveJSON('data/clubs.json', {
  v: 2, generatedAt: new Date().toISOString(), clubs: clubsOut, leagues: leaguesOut,
  unmappedLeagues: Object.values(unmapped).sort((a, b) => String(a.country).localeCompare(String(b.country))),
});
saveJSON('data/players-clubs.json', overlay);

console.log(`\nresolved ${resolved}, missed ${missed}, clubs ${Object.keys(clubsOut).length}, network calls ${netCalls}`);
const um = Object.values(unmapped);
if (um.length) { console.log(`\nUNMAPPED LEAGUES (${um.length}) - send me these to classify:`); for (const u of um) console.log(`  ${u.country || '?'}  |  ${u.league}   e.g. ${u.clubExample}`); }
else console.log('\nno unmapped leagues.');
console.log('\nwrote clubs.json + players-clubs.json. Paste me one clubs.json entry + one players-clubs entry to confirm shapes.');
