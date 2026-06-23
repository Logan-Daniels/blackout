#!/usr/bin/env node
// playlist-dump.mjs — list every video's title + duration in one or more YouTube
// playlists, so you can see the contents of playlists you can't open (e.g. a
// region-locked beIN feed). No repo files are touched; read-only.
//
// Usage:
//   YT_API_KEY=YOUR_KEY node scripts/playlist-dump.mjs                 # dumps the defaults below
//   YT_API_KEY=YOUR_KEY node scripts/playlist-dump.mjs PLxxxx PLyyyy   # dumps the playlists you name
//
// Output per playlist is paste-friendly: "  <seconds>s  PT..  <title>"  (sorted newest first),
// plus a total count. Paste it back into the chat so highlight classification + the French
// team aliases can be tuned to the real titles.

import process from 'node:process';

const KEY = process.env.YT_API_KEY || '';
if (!KEY) { console.error('Set YT_API_KEY (the same key the GitHub Action uses).'); process.exit(1); }

// Defaults: beIN Sport (FR) and RDS (CA-FR) playlists from the hand-off.
const DEFAULTS = {
  'beIN Sport (France)': 'PLQLPXA3TgtrAAeKwxuzbIDwvfhHw3BymM',
  'RDS (Canada, French)': 'PLZksgcDwQNGLDRj2OqvyV8TnosW5HVVj8',
};

const args = process.argv.slice(2);
const playlists = args.length
  ? Object.fromEntries(args.map((id, i) => [`playlist ${i + 1}`, id]))
  : DEFAULTS;

const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) { let d = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error?.message) d = j.error.message; } catch {} throw new Error(d); }
  return r.json();
};
const parseDur = iso => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const fmt = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0'); };

async function dump(label, playlistId) {
  console.log(`\n===== ${label}  (${playlistId}) =====`);
  const items = [];
  let pageToken = '';
  try {
    do {
      const pl = await getJSON('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' + playlistId + '&key=' + encodeURIComponent(KEY) + (pageToken ? '&pageToken=' + pageToken : ''));
      for (const it of (pl.items || [])) {
        items.push({
          id: it.contentDetails?.videoId,
          title: (it.snippet?.title || '').trim(),
          published: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || '',
        });
      }
      pageToken = pl.nextPageToken || '';
    } while (pageToken);
  } catch (e) { console.error('  fetch failed:', e.message); return; }

  // durations come from the videos endpoint, in batches of 50
  const durById = {};
  for (let i = 0; i < items.length; i += 50) {
    const ids = items.slice(i, i + 50).map(x => x.id).filter(Boolean).join(',');
    if (!ids) continue;
    try {
      const vj = await getJSON('https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=' + ids + '&key=' + encodeURIComponent(KEY));
      for (const v of (vj.items || [])) durById[v.id] = v.contentDetails?.duration || '';
    } catch (e) { console.error('  duration fetch failed:', e.message); }
  }

  items.sort((a, b) => Date.parse(b.published || 0) - Date.parse(a.published || 0));
  for (const it of items) {
    const iso = durById[it.id] || '';
    const secs = parseDur(iso);
    console.log(`  ${String(secs).padStart(5)}s  ${fmt(secs).padStart(7)}  ${it.title}`);
  }
  console.log(`  -- ${items.length} video(s) --`);
}

for (const [label, id] of Object.entries(playlists)) await dump(label, id);
