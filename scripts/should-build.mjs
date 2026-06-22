#!/usr/bin/env node
// should-build.mjs - decide whether the live match-data build should run now.
//
// Rule (from the brief): poll from 110 minutes after a scheduled kickoff until
// that match's data is present in data.json.
//   - Group stage: exact per-fixture kickoff times (wc-fixtures.json). A match
//     stops being polled the moment its id appears in data.json `detail`.
//   - Knockout stage: per-match kickoff times are NOT in the repo, so each round
//     is gated by koRoundStart[round]; it polls from round-start + 110 min until
//     every match in that round has a final score (or the next round begins).
//
// Emits `build=true|false` to $GITHUB_OUTPUT and prints a one-line decision.
// Accepts --now=<ISO> for testing. Always exits 0.
import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';

const OFFSET_MIN = 110;       // start polling this long after kickoff
const GROUP_CAP_MIN = 360;    // safety: stop polling a single group match after 6h
const KO_TAIL_HOURS = 48;     // how long the last rounds (3P/F) stay pollable

const nowArg = (process.argv.slice(2).find(a => a.startsWith('--now=')) || '').split('=')[1];
const NOW = nowArg ? new Date(nowArg) : new Date();

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const fx = readJSON('wc-fixtures.json', {});
const data = readJSON('data.json', {});
const detail = data.detail || {};
const ofMatches = data.ofMatches || [];
const minsSince = iso => (NOW - new Date(iso)) / 60000;
const reasons = [];

// group stage
for (const f of (fx.fixtures || [])) {
  const [id, home, away, ko] = f;
  if (!ko) continue;
  const m = minsSince(ko);
  if (m >= OFFSET_MIN && m <= GROUP_CAP_MIN && !detail[id]) {
    reasons.push(`${id} ${home} v ${away} (+${Math.round(m)} min, no detail yet)`);
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
  const pending = list.filter(m => !(m.score && m.score.ft));
  if (pending.length) reasons.push(`${key}: ${pending.length}/${list.length} results still missing`);
}

const build = reasons.length > 0;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
console.log(`[should-build] now=${NOW.toISOString()} -> ${build ? 'BUILD' : 'SKIP'}`);
reasons.slice(0, 12).forEach(r => console.log('   - ' + r));
process.exit(0);
