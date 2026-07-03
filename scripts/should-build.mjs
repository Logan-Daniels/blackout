#!/usr/bin/env node
// should-build.mjs - decide whether the live match-data build should run now.
//
// Highlights are published well after the final whistle, and FIFA's own recap lands
// more than 24h later. A guard that stops the moment a result (or the first broadcaster
// clip) appears never collects them. So each match is polled in two phases, throttled
// off data.json's `generatedAt` so the every-5-min cron does not rebuild on every tick
// (the workflow commits data.json on each build, so generatedAt advances reliably):
//
//   Phase 1  (kickoff+110min .. kickoff+22h):  ~every 2h, until the match has its detail
//            (result/lineups) AND at least one broadcaster highlight. This is the window
//            where ESPN data and the TSN/Fox/ITV/beIN/RDS clips show up.
//   Phase 2  (kickoff+22h .. kickoff+48h):     ~every 10min, until the match has a FIFA
//            highlight (videos[key].fifa). FIFA posts its recap 24h+ after kickoff, so
//            this is the fine-grained chase. It also still grabs detail/broadcaster clips
//            in the rare case they never arrived in phase 1.
//   After 48h: give up on that match.
//
// The cadence is enforced globally via the last build's generatedAt: the guard returns
// build=true only when enough time has passed for the most urgent pending match. A
// phase-2 match forces the 10-min cadence; if only phase-1 matches are pending the build
// waits ~2h. The build is monolithic, so a 10-min run refreshes every match at once. The
// cron only runs 15:00-06:59 UTC, so a FIFA upload during the 07:00-14:59 gap is picked
// up when the cron resumes.
//
// Knockout matches have no per-match kickoff in the repo, so each round is gated by
// koRoundStart[round] and the cadence is chosen by what is still missing (coarse while a
// result or broadcaster clip is outstanding, fine once only FIFA is left).
//
// Emits `build=true|false` to $GITHUB_OUTPUT and prints a one-line decision.
// Accepts --now=<ISO> for testing. Always exits 0.
import { readFileSync, appendFileSync } from 'node:fs';
import process from 'node:process';

const OFFSET_MIN     = 110;        // start polling this long after kickoff
const PHASE2_MIN     = 22 * 60;    // 1320: switch from coarse polling to the FIFA chase
const GIVEUP_MIN     = 48 * 60;    // 2880: stop polling a group match entirely
const COARSE_GATE    = 115;        // phase 1: roughly every 2h on a 5-min cron
const FINE_GATE      = 9;          // phase 2: roughly every 10min on a 5-min cron

const nowArg = (process.argv.slice(2).find(a => a.startsWith('--now=')) || '').split('=')[1];
const NOW = nowArg ? new Date(nowArg) : new Date();

const readJSON = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const fx = readJSON('data/wc-fixtures.json', {});
const data = readJSON('data/data.json', {});
const detail = data.detail || {};
const videos = data.videos || {};
const ofMatches = data.ofMatches || [];
const minsSince = iso => (NOW - new Date(iso)) / 60000;

// Minutes since the last build committed its data.json. Absent -> treat as "due".
const sinceBuild = data.generatedAt ? (NOW - new Date(data.generatedAt)) / 60000 : Infinity;

// "Has broadcaster highlights" once any non-FIFA source holds a link.
const hasBroadcastHL = key => {
  const v = key != null ? videos[key] : null;
  if (!v) return false;
  return Object.keys(v).some(s => s !== 'fifa' && v[s] && Object.keys(v[s]).length > 0);
};
// "Has FIFA highlights" once the FIFA recap link is present.
const hasFifaHL = key => {
  const v = key != null ? videos[key] : null;
  return !!(v && v.fifa && Object.keys(v.fifa).length > 0);
};

const reasons = [];
let gate = Infinity;                       // finest cadence any pending match demands
const demand = g => { if (g < gate) gate = g; };

// GROUP STAGE -- exact per-fixture kickoffs, so phases are chosen by the clock.
for (const f of (fx.fixtures || [])) {
  const [id, home, away, ko] = f;
  if (!ko) continue;
  const m = minsSince(ko);
  if (m < OFFSET_MIN || m > GIVEUP_MIN) continue;
  const hasDetail = !!detail[id], hasBc = hasBroadcastHL(id), hasFifa = hasFifaHL(id);
  if (m < PHASE2_MIN) {
    if (!hasDetail || !hasBc) {
      reasons.push(`${id} ${home} v ${away}: ${!hasDetail ? 'no detail yet' : 'awaiting broadcaster highlights'} (+${Math.round(m)}min, ~2h)`);
      demand(COARSE_GATE);
    }
  } else {
    if (!hasDetail || !hasBc || !hasFifa) {
      const what = !hasDetail ? 'no detail yet' : !hasBc ? 'awaiting broadcaster highlights' : 'awaiting FIFA highlights';
      reasons.push(`${id} ${home} v ${away}: ${what} (+${Math.round(m)}min, ~10min)`);
      demand(!hasDetail || !hasBc ? COARSE_GATE : FINE_GATE);
    }
  }
}

// KNOCKOUT STAGE -- window each match off its own kickoff, exactly like the group stage.
// openfootball carries per-match knockout dates, so a whole round is no longer gated off a
// single round-start proxy. The Round of 32 alone spans ~6 days (16 matches, Jun 28 to Jul 3),
// so the old fixed 96h round-start give-up cut its later matches off more than two days early.
const ROUND_KEY = { 'Round of 32':'R32', 'Round of 16':'R16', 'Quarter-final':'QF', 'Semi-final':'SF', 'Match for third place':'3P', 'Final':'F' };
for (const mm of ofMatches) {
  const rk = ROUND_KEY[mm.round];
  if (!rk || !mm.date) continue;                          // knockout matches only (group rounds are "Matchday N")
  const mins = minsSince(mm.date);
  if (mins < OFFSET_MIN || mins > GIVEUP_MIN) continue;   // same per-match window as the group stage
  const vk = (mm.num != null) ? String(mm.num) : null;
  const hasDetail = !!(mm.score && mm.score.ft);
  // unmappable match (no video key) -> treat highlights as satisfied so it is not held pending forever.
  const hasBc = vk ? hasBroadcastHL(vk) : true;
  const hasFifa = vk ? hasFifaHL(vk) : true;
  if (hasDetail && hasBc && hasFifa) continue;
  const num = (mm.num != null) ? mm.num : '?';
  if (mins < PHASE2_MIN) {
    if (!hasDetail || !hasBc) {
      reasons.push(`${rk} #${num}: ${!hasDetail ? 'no result yet' : 'awaiting broadcaster highlights'} (+${Math.round(mins)}min, ~2h)`);
      demand(COARSE_GATE);
    }
  } else {
    if (!hasDetail || !hasBc || !hasFifa) {
      const what = !hasDetail ? 'no result yet' : !hasBc ? 'awaiting broadcaster highlights' : 'awaiting FIFA highlights';
      reasons.push(`${rk} #${num}: ${what} (+${Math.round(mins)}min, ~10min)`);
      demand(!hasDetail || !hasBc ? COARSE_GATE : FINE_GATE);
    }
  }
}

// Build only if something is pending AND enough time has passed for the finest cadence.
const build = reasons.length > 0 && sinceBuild >= gate;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
console.log(`[should-build] now=${NOW.toISOString()} sinceBuild=${sinceBuild === Infinity ? 'n/a' : Math.round(sinceBuild) + 'min'} gate=${gate === Infinity ? 'n/a' : gate + 'min'} -> ${build ? 'BUILD' : 'SKIP'}`);
reasons.slice(0, 12).forEach(r => console.log('   - ' + r));
if (reasons.length && !build) console.log(`   (pending, but throttled: waiting for the ~${gate === COARSE_GATE ? '2h' : '10min'} cadence)`);
process.exit(0);
