#!/usr/bin/env node
// should-build.mjs - decide whether the live match-data build should run now.
//
// Rule: poll from 110 minutes after a scheduled kickoff until that match has BOTH
// its detail (result/lineups) AND its highlight links in data.json. Highlights are
// published by broadcasters well after the final whistle, so polling that stops the
// moment a result lands (the old behaviour) never collects the YouTube links. We now
// keep a match "pending" until its videos entry is populated too, capped so a match
// that simply never gets highlights does not poll forever.
//   - Group stage: exact per-fixture kickoff times (wc-fixtures.json). A match is
//     pollable from kickoff+110min until it has detail AND >=1 highlight link, or the
//     hard cap (GROUP_CAP_MIN) elapses.
//   - Knockout stage: per-match kickoff times are not in the repo, so each round is
//     gated by koRoundStart[round]; it polls from round-start+110min until every match
//     in that round has a final score AND (where the match number is known) highlights,
//     or the next round begins / the tail window elapses.
//
// Emits `build=true|false` to $GITHUB_OUTPUT and prints a one-line decision.
// Accepts --now=<ISO> for testing. Always exits 0.
import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';

const OFFSET_MIN = 110;        // start polling this long after kickoff
const GROUP_CAP_MIN = 1440;    // keep polling a single group match up to 24h after kickoff
                               // (covers late highlight uploads; was 360 = 6h, which cut highlights off)
const KO_TAIL_HOURS = 60;      // how long the last rounds (3P/F) stay pollable for late highlights

const nowArg = (process.argv.slice(2).find(a => a.startsWith('--now=')) || '').split('=')[1];
const NOW = nowArg ? new Date(nowArg) : new Date();

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const fx = readJSON('wc-fixtures.json', {});
const data = readJSON('data.json', {});
const detail = data.detail || {};
const videos = data.videos || {};
const ofMatches = data.ofMatches || [];
const minsSince = iso => (NOW - new Date(iso)) / 60000;
const reasons = [];

// A match "has highlights" once its videos entry holds at least one broadcaster link.
const hasHL = key => {
  const v = key != null ? videos[key] : null;
  return !!(v && Object.values(v).some(src => src && Object.keys(src).length > 0));
};

// group stage
for (const f of (fx.fixtures || [])) {
  const [id, home, away, ko] = f;
  if (!ko) continue;
  const m = minsSince(ko);
  if (m < OFFSET_MIN || m > GROUP_CAP_MIN) continue;
  const noDetail = !detail[id];
  const noHL = !hasHL(id);
  if (noDetail || noHL) {
    reasons.push(`${id} ${home} v ${away} (+${Math.round(m)} min, ${noDetail ? 'no detail yet' : 'awaiting highlights'})`);
  }
}

// knockout stage
const ROUND_KEY = { 'Round of 32':'R32', 'Round of 16':'R16', 'Quarter-final':'QF', 'Semi-final':'SF', 'Match for third place':'3P', 'Final':'F' };
const koStart = fx.koRoundStart || {};
const byRound = {};
for (const m of ofMatches) { const k = ROUND_KEY[m.round]; if (k) (byRound[k] = byRound[k] || []).push(m); }
const ORDER = ['R32','R16','QF','SF','3P','F'];
for (let i = 0; i < ORDER.length; i++) {
  const key = ORDER[i], startIso = koStart[key], list = byRound[key];
  if (!startIso || !list || !list.length) continue;
  const start = new Date(startIso);
  let end = null;
  for (let j = i + 1; j < ORDER.length; j++) { if (koStart[ORDER[j]]) { end = new Date(koStart[ORDER[j]]); break; } }
  if (!end) end = new Date(start.getTime() + KO_TAIL_HOURS * 3600e3);
  const open = NOW >= new Date(start.getTime() + OFFSET_MIN * 60000) && NOW <= end;
  if (!open) continue;
  // A knockout match is still pending if it has no final score, or (when we can map it
  // to a video key via its openfootball match number) it has no highlights yet.
  const pending = list.filter(m => {
    const noResult = !(m.score && m.score.ft);
    const vk = (m.num != null) ? String(m.num) : null;
    const noHL = vk ? !hasHL(vk) : false;
    return noResult || noHL;
  });
  if (pending.length) {
    const noRes = pending.filter(m => !(m.score && m.score.ft)).length;
    reasons.push(`${key}: ${noRes} result(s) missing, ${pending.length - noRes} awaiting highlights (of ${list.length})`);
  }
}

const build = reasons.length > 0;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
console.log(`[should-build] now=${NOW.toISOString()} -> ${build ? 'BUILD' : 'SKIP'}`);
reasons.slice(0, 12).forEach(r => console.log('   - ' + r));
process.exit(0);
