#!/usr/bin/env node
// yt-check.mjs — for a single YouTube video, report whether it can be embedded
// on other websites and which countries it is (or is not) blocked in.
//
// It reads the YouTube Data API v3 key from keys/youtube.txt, from --key=, or
// from the YT_API_KEY environment variable. The same two helpers it exports
// (extractVideoId, videoStatus) are reused by add-broadcaster.mjs so the two
// stay in step.
//
// Usage:
//   node scripts/yt-check.mjs "https://www.youtube.com/watch?v=Fc_7RQ_CsF4"
//   node scripts/yt-check.mjs Fc_7RQ_CsF4 --key=AIza...
//   YT_API_KEY=AIza... node scripts/yt-check.mjs https://youtu.be/Fc_7RQ_CsF4
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));

// keys/ may sit next to this script, one level up (the repo root when this lives
// in scripts/), or under the current working directory.
function keyFile(name) {
  for (const d of [join(here, '..', 'keys'), join(here, 'keys'), join(process.cwd(), 'keys')]) {
    try { const f = join(d, name + '.txt'); if (existsSync(f)) return readFileSync(f, 'utf8').trim(); } catch {}
  }
  return '';
}

// Pull the 11-character video id out of any of the common URL shapes, or accept
// a bare id. Returns null when nothing that looks like an id is present.
export function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}

// Ask the Data API about one video. Resolves to a small plain object, or throws
// with a readable message (missing video, bad key, quota, network).
//   { id, title, embeddable, allowed:[CC...], blocked:[CC...], language }
// allowed/blocked mirror YouTube's regionRestriction: at most one is non-empty.
// language is the primary subtag of the declared audio (or default) language.
export async function videoStatus(videoId, key) {
  if (!videoId) throw new Error('no video id');
  if (!key) throw new Error('no YouTube API key');
  const url = 'https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status,snippet&id='
    + encodeURIComponent(videoId) + '&key=' + encodeURIComponent(key);
  const r = await fetch(url);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
    throw new Error(msg);
  }
  const j = await r.json();
  const it = j.items && j.items[0];
  if (!it) throw new Error('video not found (it may be private, deleted, or the id is wrong)');
  const cd = it.contentDetails || {}, st = it.status || {}, sn = it.snippet || {};
  const rr = cd.regionRestriction || {};
  const language = (sn.defaultAudioLanguage || sn.defaultLanguage || '').split('-')[0].toLowerCase();
  return {
    id: videoId,
    title: sn.title || '',
    channel: sn.channelTitle || '',
    channelId: sn.channelId || '',
    // The API returns this boolean on every video; treat a missing value as
    // embeddable rather than guessing it is blocked.
    embeddable: st.embeddable !== false,
    allowed: Array.isArray(rr.allowed) ? rr.allowed.slice() : [],
    blocked: Array.isArray(rr.blocked) ? rr.blocked.slice() : [],
    language,
  };
}

// ---- CLI (only when run directly, not when imported) ----
let isMain = false;
try { isMain = (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href); } catch {}
if (isMain) {
  const argv = process.argv.slice(2);
  let key = '';
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--key=')) key = a.slice(6);
    else if (!a.startsWith('--')) positional.push(a);
  }
  key = key || process.env.YT_API_KEY || keyFile('youtube');
  const id = extractVideoId(positional[0]);
  if (!id) { console.error('Usage: node scripts/yt-check.mjs <youtube-url-or-id> [--key=...]'); process.exit(1); }
  if (!key) { console.error('No YouTube API key found. Put it in keys/youtube.txt, pass --key=, or set YT_API_KEY.'); process.exit(1); }
  const regionName = cc => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch { return cc; } };
  try {
    const s = await videoStatus(id, key);
    console.log('\n' + (s.title || '(untitled)') + '  (' + s.id + ')');
    console.log('-'.repeat(48));
    if (s.channel) console.log('Channel: ' + s.channel);
    console.log('Embeddable on other sites: ' + (s.embeddable ? 'yes' : 'no'));
    if (s.language) console.log('Audio language (from YouTube): ' + s.language);
    console.log('');
    if (s.allowed.length) {
      console.log('Viewable in ONLY these ' + s.allowed.length + ' country/countries (blocked everywhere else):');
      console.log('  ' + s.allowed.map(c => c + ' ' + regionName(c)).join(', '));
    } else if (s.blocked.length) {
      console.log('Blocked in these ' + s.blocked.length + ' country/countries (viewable everywhere else):');
      console.log('  ' + s.blocked.map(c => c + ' ' + regionName(c)).join(', '));
    } else {
      console.log('Viewable worldwide (no country restriction).');
    }
    console.log('');
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}
