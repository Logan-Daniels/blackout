#!/usr/bin/env node
// translate-i18n.mjs - create and translate i18n/<lang>.json locale files from i18n/en.json via DeepL,
// and, in the same run, add that language's team-name spellings to wc-fixtures.json so a broadcaster in
// that language matches the right fixture, then rebuild the language picker in index.html.
//
// en.json is the single source of truth for the interface strings. Pass one or more language codes;
// for each, this creates the locale file if it does not exist, translates the strings that are missing
// (or every string with --force) in one DeepL request, and writes a complete i18n/<lang>.json in
// en.json's key order. HTML tags such as <b>...</b> are preserved and placeholders like {g} are never
// translated. It then, for any language it newly creates (or --force), folds that language's team
// names into wc-fixtures.json: the canonical localized name from Intl.DisplayNames plus DeepL's own
// translation of each name, added only and never removed. Finally it rebuilds the LANGS array in
// index.html so the picker lists exactly the languages that have a locale file.
//
// DeepL notes: a FREE key ends in ":fx" and automatically uses api-free.deepl.com. DeepL supports
// about thirty target languages; for a code it does not support, this falls back to MyMemory (no key
// needed; set MYMEMORY_EMAIL for a higher allowance) and then to an English copy, so the language is
// still created and selectable rather than silently dropped. A 456 means the monthly character quota is
// spent. Set DEEPL_API_URL only if you need to point at a proxy.
//
// Usage (run locally; the DeepL endpoint is not on the CI allowlist):
//   DEEPL_API_KEY=xxxxxxxx:fx node scripts/translate-i18n.mjs de
//   node scripts/translate-i18n.mjs pt it nl --key=xxxxxxxx:fx
//   node scripts/translate-i18n.mjs de --force          # retranslate every string and redo de aliases
//   node scripts/translate-i18n.mjs de --no-aliases     # UI strings only, leave wc-fixtures.json alone
//   node scripts/translate-i18n.mjs de --no-index       # leave the index.html picker alone
//
// Codes are ISO 639-1 (two letters): de German, pt Portuguese, it Italian, nl Dutch, and so on.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const args = process.argv.slice(2);
const langs = args.filter(a => !a.startsWith('-'));
const force = args.includes('--force');
const noIndex = args.includes('--no-index');
const noAliases = args.includes('--no-aliases');
const keyArg = (args.find(a => a.startsWith('--key=')) || '').split('=')[1];
const delayMs = parseInt((args.find(a => a.startsWith('--delay=')) || '').split('=')[1] || '1200', 10);
const keyFile = (name) => { try { const h = dirname(fileURLToPath(import.meta.url)); const r = existsSync(join(h, '..', 'i18n')) ? join(h, '..') : process.cwd(); const f = join(r, 'keys', name + '.txt'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; } };
const API_KEY = keyArg || process.env.DEEPL_API_KEY || process.env.DEEPL_AUTH_KEY || keyFile('deepl');

if (!langs.length) { console.error('Usage: node scripts/translate-i18n.mjs <lang> [<lang> ...] [--force] [--no-aliases] [--no-index] [--delay=ms] [--key=...]'); process.exit(1); }
if (!API_KEY) { console.error('No DeepL key. Set DEEPL_API_KEY (a free key ends in ":fx") or pass --key=...'); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, '..', 'i18n')) ? join(here, '..') : process.cwd();
const i18nDir = join(root, 'i18n');
const indexPath = join(root, 'index.html');
const fixturesPath = [join(root, 'data', 'wc-fixtures.json'), join(root, 'wc-fixtures.json')].find(existsSync) || join(root, 'data', 'wc-fixtures.json');
const enPath = join(i18nDir, 'en.json');
if (!existsSync(enPath)) { console.error('Cannot find ' + enPath); process.exit(1); }
const en = JSON.parse(readFileSync(enPath, 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const englishName = code => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; } };
const endonym = code => { let n = code; try { n = new Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch {} return n.charAt(0).toUpperCase() + n.slice(1); };

// Our ISO-639-1 code -> DeepL target code. DeepL only does these ~30 languages.
const DEEPL = { ar: 'AR', bg: 'BG', cs: 'CS', da: 'DA', de: 'DE', el: 'EL', en: 'EN-US', es: 'ES', et: 'ET', fi: 'FI', fr: 'FR', hu: 'HU', id: 'ID', it: 'IT', ja: 'JA', ko: 'KO', lt: 'LT', lv: 'LV', nb: 'NB', no: 'NB', nl: 'NL', pl: 'PL', pt: 'PT-PT', ro: 'RO', ru: 'RU', sk: 'SK', sl: 'SL', sv: 'SV', tr: 'TR', uk: 'UK', zh: 'ZH' };
const supportedList = () => [...new Set(Object.keys(DEEPL).filter(c => c !== 'en'))].sort().join(', ');
const apiBase = (process.env.DEEPL_API_URL || (API_KEY.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com')).replace(/\/$/, '');

// POST to DeepL with retries: persist through transient 429 (rate-limit) and 5xx; a 456 (quota spent)
// is fatal for this run and reported plainly.
async function deeplPost(payload, label) {
  const opts = { method: 'POST', headers: { Authorization: 'DeepL-Auth-Key ' + API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  let attempt = 0;
  for (;;) {
    let res = null, netErr = null;
    try { res = await fetch(apiBase + '/v2/translate', opts); } catch (e) { netErr = e; }
    if (res && res.ok) return { ok: true, data: await res.json() };
    if (res && res.status === 456) return { ok: false, status: 456, detail: 'DeepL character quota is spent for this billing period.' };
    const transient = !!netErr || (res && (res.status === 429 || res.status >= 500));
    const status = netErr ? 'network error' : res.status;
    if (!transient || attempt >= 4) { const detail = netErr ? netErr.message : (res.status + ' ' + (await res.text()).slice(0, 160)); return { ok: false, status, detail }; }
    const wait = Math.min(60000, 2000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 1000);
    console.log('  ' + status + ' on ' + label + '; waiting ' + Math.round(wait / 1000) + 's then retrying (' + (attempt + 1) + '/4)...');
    await sleep(wait); attempt++;
  }
}

// Placeholders such as {g} must not be translated: wrap them in an <x> tag DeepL is told to ignore,
// then strip the wrapper afterwards. Real markup like <b>...</b> is handled by tag_handling=html.
const PH = /\{[^}]+\}/g;
const protect = s => s.replace(PH, m => '<x>' + m + '</x>');
const unprotect = s => s.replace(/<\/?x>/g, '');
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ');

// Translate an array of texts into `target`, batching to stay within DeepL's per-request limits.
async function deeplTranslate(texts, target, { html = false, sourceLang = 'EN' } = {}, label = '') {
  const out = []; const BATCH = 45;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const payload = { text: html ? slice.map(protect) : slice, target_lang: target };
    if (sourceLang) payload.source_lang = sourceLang;
    if (html) { payload.tag_handling = 'html'; payload.ignore_tags = ['x']; }
    const r = await deeplPost(payload, label + (texts.length > BATCH ? ' [' + (i / BATCH + 1) + ']' : ''));
    if (!r.ok) return { ok: false, status: r.status, detail: r.detail };
    const arr = (r.data && r.data.translations) || [];
    for (let j = 0; j < slice.length; j++) { let t = (arr[j] && arr[j].text) || ''; if (html) t = unprotect(t); out.push(decode(t)); }
    if (i + BATCH < texts.length) await sleep(300);
  }
  return { ok: true, texts: out };
}

// Team name -> ISO 3166-1 alpha-2, so Intl.DisplayNames can give the canonical localized country name.
// England and Scotland have no country code, so they rely on DeepL's translation alone.
const ISO = { 'Mexico': 'MX', 'South Africa': 'ZA', 'South Korea': 'KR', 'Czechia': 'CZ', 'Canada': 'CA', 'Bosnia and Herzegovina': 'BA', 'Qatar': 'QA', 'Switzerland': 'CH', 'Brazil': 'BR', 'Morocco': 'MA', 'Haiti': 'HT', 'Scotland': null, 'United States': 'US', 'Paraguay': 'PY', 'Australia': 'AU', 'Türkiye': 'TR', 'Germany': 'DE', 'Curaçao': 'CW', "Côte d'Ivoire": 'CI', 'Ecuador': 'EC', 'Netherlands': 'NL', 'Japan': 'JP', 'Sweden': 'SE', 'Tunisia': 'TN', 'Belgium': 'BE', 'Egypt': 'EG', 'Iran': 'IR', 'New Zealand': 'NZ', 'Spain': 'ES', 'Cabo Verde': 'CV', 'Saudi Arabia': 'SA', 'Uruguay': 'UY', 'France': 'FR', 'Senegal': 'SN', 'Iraq': 'IQ', 'Norway': 'NO', 'Argentina': 'AR', 'Algeria': 'DZ', 'Austria': 'AT', 'Jordan': 'JO', 'Portugal': 'PT', 'DR Congo': 'CD', 'Uzbekistan': 'UZ', 'Colombia': 'CO', 'England': null, 'Croatia': 'HR', 'Ghana': 'GH', 'Panama': 'PA' };
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Add `lang`'s team-name spellings to wc-fixtures.json (the CLDR localized name from Intl.DisplayNames
// plus DeepL's translation of each team name), adding only and never removing or touching other fields.
async function addAliases(lang, target) {
  if (!existsSync(fixturesPath)) { console.log('  No wc-fixtures.json found next to the repo; skipping aliases.'); return; }
  const cfg = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  cfg.aliases = cfg.aliases || {};
  const teams = Object.keys(cfg.aliases);
  if (!teams.length) { console.log('  wc-fixtures.json has no aliases block; skipping.'); return; }
  let region = null; try { region = new Intl.DisplayNames([lang], { type: 'region' }); } catch {}
  const r = await deeplTranslate(teams, target, { sourceLang: null }, lang + ' team-names');
  if (!r.ok) { console.error('  Could not translate team names for ' + lang + ' (' + r.status + ' ' + r.detail + '); aliases left unchanged.'); return; }
  let added = 0;
  teams.forEach((team, i) => {
    const have = new Set(cfg.aliases[team].map(norm));
    const cands = [];
    const iso = ISO[team];
    if (iso && region) { try { const c = region.of(iso); if (c) cands.push(c); } catch {} }
    if (r.texts[i]) cands.push(r.texts[i]);
    for (const c of cands) { const k = norm(c); if (k && !have.has(k)) { cfg.aliases[team].push(String(c).toLowerCase()); have.add(k); added++; } }
  });
  writeFileSync(fixturesPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('  Added ' + added + ' ' + lang + ' team-name alias(es) to wc-fixtures.json.');
}

// Translate one language's UI strings. Returns whether it called DeepL and whether the call failed.
async function translateOne(lang, target) {
  const outPath = join(i18nDir, lang + '.json');
  const created = !existsSync(outPath);
  const existing = created ? {} : JSON.parse(readFileSync(outPath, 'utf8'));
  const keys = Object.keys(en);
  const todo = keys.filter(k => force || !(k in existing));
  if (!todo.length) { console.log(lang + '.json already complete (' + keys.length + ' keys). Use --force to retranslate.'); return { called: false }; }
  console.log((created ? 'Creating' : 'Updating') + ' ' + lang + '.json - translating ' + todo.length + ' string(s) into ' + englishName(lang) + ' via DeepL...');
  const r = await deeplTranslate(todo.map(k => en[k]), target, { html: true }, lang + ' ui');
  if (!r.ok) { console.error('  DeepL error for ' + lang + ': ' + r.status + ' ' + r.detail + '. Skipping; re-run later to resume.'); return { called: true, failed: true }; }
  const map = {}; todo.forEach((k, i) => { map[k] = r.texts[i]; });
  const out = {}; let filled = 0;
  for (const k of keys) {
    if (typeof map[k] === 'string' && map[k].trim()) { out[k] = map[k]; filled++; }
    else if (k in existing) out[k] = existing[k];
    else out[k] = en[k];
  }
  if (!existsSync(i18nDir)) mkdirSync(i18nDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  const sameAsEn = keys.filter(k => out[k] === en[k]).length;
  console.log('  Wrote ' + outPath + ' (' + filled + ' translated this run, ' + keys.length + ' keys total' + (sameAsEn ? ', ' + sameAsEn + ' identical to English' : '') + ').');
  return { called: true };
}

// Best-effort fallback translator for languages DeepL cannot do. MyMemory (api.mymemory.translated.net)
// needs no key for modest volumes, which the UI strings fit. It translates one short string per request,
// so to avoid corrupting them it leaves any string containing a {placeholder} or <markup> in English;
// likewise any per-string failure, rate-limit, or timeout falls back to English. Set MYMEMORY_EMAIL for
// a higher daily allowance. Returns texts aligned with the input plus a count actually translated.
async function myMemoryTranslate(texts, lang) {
  const out = []; let okCount = 0;
  const email = process.env.MYMEMORY_EMAIL || '';
  for (const t of texts) {
    if (!t || /[{<]/.test(t)) { out.push(t); continue; }           // keep placeholders/markup as English
    let translated = t;
    try {
      const u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(t) +
                '&langpair=' + encodeURIComponent('en|' + lang) + (email ? '&de=' + encodeURIComponent(email) : '');
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        const cand = j && j.responseData && j.responseData.translatedText;
        const bad = !cand || (j.responseStatus && j.responseStatus !== 200) || /MYMEMORY WARNING|QUOTA|INVALID/i.test(cand + ' ' + (j.responseDetails || ''));
        if (!bad && cand.toLowerCase() !== t.toLowerCase()) { translated = decode(cand); okCount++; }
      }
    } catch {}
    out.push(translated);
    await sleep(250);
  }
  return { texts: out, okCount };
}

// When DeepL cannot do a language, still create i18n/<lang>.json so the language is selectable and the
// picker rebuild below includes it. Try MyMemory first, then fall back to English for anything it could
// not translate. Respects an existing file and --force exactly like translateOne.
async function fallbackCreate(lang) {
  const outPath = join(i18nDir, lang + '.json');
  const created = !existsSync(outPath);
  const existing = created ? {} : JSON.parse(readFileSync(outPath, 'utf8'));
  const keys = Object.keys(en);
  const todo = keys.filter(k => force || !(k in existing));
  if (!todo.length) { console.log('  ' + lang + '.json already complete (' + keys.length + ' keys).'); return { created: false }; }
  console.log('  Falling back to MyMemory for ' + englishName(lang) + ' (' + todo.length + ' string(s); strings with placeholders or markup stay English)...');
  let texts;
  try { const r = await myMemoryTranslate(todo.map(k => en[k]), lang); texts = r.texts; console.log('    MyMemory translated ' + r.okCount + ' of ' + todo.length + '; the rest stay English.'); }
  catch { texts = todo.map(k => en[k]); console.log('    MyMemory unavailable; using English for all strings.'); }
  const map = {}; todo.forEach((k, i) => { map[k] = texts[i]; });
  const out = {};
  for (const k of keys) out[k] = (typeof map[k] === 'string' && map[k].trim()) ? map[k] : (k in existing ? existing[k] : en[k]);
  if (!existsSync(i18nDir)) mkdirSync(i18nDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log('  Wrote ' + outPath + ' (fallback). The language is now selectable; untranslated strings show in English.');
  return { created };
}

// England and Scotland are GB subdivisions with no ISO country code, so Intl cannot localise them;
// their names are translated as text from this curated table (lower-case). Safe to extend: a wrong or
// missing entry only causes a miss, never a false match.
const SUBNATIONAL = {
  "England":  { es:"inglaterra", fr:"angleterre", pt:"inglaterra", de:"england", it:"inghilterra", nl:"engeland", ja:"イングランド", ko:"잉글랜드", zh:"英格兰", id:"inggris", tr:"ingiltere", pl:"anglia", ru:"англия", uk:"англія", sv:"england", da:"england", nb:"england", no:"england", fi:"englanti", cs:"anglie", sk:"anglicko", el:"αγγλία", ro:"anglia", hu:"anglia", bg:"англия", ar:"إنجلترا" },
  "Scotland": { es:"escocia", fr:"écosse", pt:"escócia", de:"schottland", it:"scozia", nl:"schotland", ja:"スコットランド", ko:"스코틀랜드", zh:"苏格兰", id:"skotlandia", tr:"iskoçya", pl:"szkocja", ru:"шотландия", uk:"шотландія", sv:"skottland", da:"skotland", nb:"skottland", no:"skottland", fi:"skotlanti", cs:"skotsko", sk:"škótsko", el:"σκωτία", ro:"scoția", hu:"skócia", bg:"шотландия", ar:"اسكتلندا" }
};
// For a DeepL-unsupported language, fold the CLDR localized country names from Intl.DisplayNames plus
// the curated England/Scotland names into wc-fixtures.json (DeepL's half of addAliases is unavailable).
// Adds only, never removes.
function foldIntlAliases(lang) {
  if (noAliases || !existsSync(fixturesPath)) return;
  let region; try { region = new Intl.DisplayNames([lang], { type: 'region' }); } catch { return; }
  const cfg = JSON.parse(readFileSync(fixturesPath, 'utf8')); cfg.aliases = cfg.aliases || {};
  let added = 0;
  for (const team of Object.keys(cfg.aliases)) {
    let cand = null;
    const iso = ISO[team];
    if (iso) { try { cand = region.of(iso); } catch {} }
    else if (SUBNATIONAL[team]) cand = SUBNATIONAL[team][lang];   // England / Scotland: translated as text
    if (!cand) continue;
    const have = new Set(cfg.aliases[team].map(norm));
    if (!have.has(norm(cand))) { cfg.aliases[team].push(String(cand).toLowerCase()); have.add(norm(cand)); added++; }
  }
  if (added) { writeFileSync(fixturesPath, JSON.stringify(cfg, null, 2) + '\n'); console.log('  Added ' + added + ' ' + lang + ' team-name alias(es) to wc-fixtures.json from Intl/table.'); }
}

// --- run ---
for (let i = 0; i < langs.length; i++) {
  const lang = langs[i];
  if (lang === 'en') { console.log('Skipping en (it is the source language).'); continue; }
  const target = DEEPL[lang];
  if (!target) {
    console.error('DeepL does not support "' + lang + '" (supported: ' + supportedList() + ').');
    const fb = await fallbackCreate(lang);
    if (!noAliases && (fb.created || force)) foldIntlAliases(lang);
    if (i < langs.length - 1) await sleep(delayMs);
    continue;
  }
  const created = !existsSync(join(i18nDir, lang + '.json'));
  const res = await translateOne(lang, target);
  if (res.failed) {
    console.log('  DeepL did not complete for "' + lang + '"; trying the fallback chain instead.');
    const fb = await fallbackCreate(lang);
    if (!noAliases && (fb.created || force)) foldIntlAliases(lang);
  } else if (!noAliases && (created || force)) {
    await addAliases(lang, target);
  }
  if (i < langs.length - 1) await sleep(delayMs);
}

// Rebuild the language picker (LANGS) in index.html from the locale files that exist: list every
// language with a file under its own name, drop any without one, so the picker never offers a
// language whose translation was not created (for example one skipped by a quota error).
if (!noIndex && existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  const m = html.match(/var LANGS=\[([\s\S]*?)\];/);
  if (m) {
    const hasFile = code => code === 'en' || existsSync(join(i18nDir, code + '.json'));
    const pairs = [...m[1].matchAll(/\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\]/g)].map(x => [x[1], x[2]]).filter(p => hasFile(p[0]));
    const present = new Set(pairs.map(p => p[0]));
    for (const code of langs) { if (code !== 'en' && hasFile(code) && !present.has(code)) { pairs.push([code, endonym(code)]); present.add(code); } }
    const q = s => "'" + String(s).replace(/'/g, "\\'") + "'";
    const literal = 'var LANGS=[' + pairs.map(p => '[' + q(p[0]) + ',' + q(p[1]) + ']').join(',') + '];';
    if (literal !== m[0]) { writeFileSync(indexPath, html.replace(m[0], literal)); console.log('Language picker now lists: ' + pairs.map(p => p[0]).join(', ')); }
    else { console.log('Language picker unchanged; lists: ' + pairs.map(p => p[0]).join(', ')); }
  } else { console.log('Could not find the LANGS picker in index.html; add the languages there manually.'); }
} else if (noIndex) { console.log('--no-index set; left index.html untouched.'); }
