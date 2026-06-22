#!/usr/bin/env node
/* Does your API-Football key reach the 2026 World Cup with lineups?
 * Run:  API_FOOTBALL_KEY=your_key node scripts/check-apifootball.mjs
 */
const KEY = process.env.API_FOOTBALL_KEY || '';
const HOST = process.env.API_FOOTBALL_HOST || 'https://v3.football.api-sports.io';
const RAPID = process.env.API_FOOTBALL_RAPIDAPI;
if (!KEY) { console.error('Set API_FOOTBALL_KEY first:  API_FOOTBALL_KEY=your_key node scripts/check-apifootball.mjs'); process.exit(1); }
const headers = RAPID ? { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST.replace(/^https?:\/\//, '') } : { 'x-apisports-key': KEY };
const get = async p => { const r = await fetch(HOST + p, { headers }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const hasErr = e => e && (Array.isArray(e) ? e.length : Object.keys(e).length);
const LG = process.env.AF_LEAGUE_ID || '1', SS = process.env.AF_SEASON || '2026';
(async () => {
  const st = await get('/status');
  const sub = st.j.response && st.j.response.subscription, req = st.j.response && st.j.response.requests;
  console.log('1) Account:', sub ? (sub.plan + ' plan, active=' + sub.active + (sub.end ? ', ends ' + sub.end : '')) : ('PROBLEM ' + JSON.stringify(st.j.errors || st.j)));
  if (req) console.log('   Requests today:', req.current + '/' + req.limit_day);
  const fx = await get('/fixtures?league=' + LG + '&season=' + SS);
  console.log('2) World Cup ' + SS + ' fixtures:', (fx.j.results != null ? fx.j.results + ' returned' : '(none)'), hasErr(fx.j.errors) ? ('-> ERRORS: ' + JSON.stringify(fx.j.errors)) : '');
  if (fx.j.results) {
    const fin = (fx.j.response || []).find(f => /FT|AET|PEN/.test(f.fixture.status.short)) || fx.j.response[0];
    console.log('   sample:', fin.teams.home.name, 'vs', fin.teams.away.name, '(' + fin.fixture.status.short + '), id', fin.fixture.id);
    const lu = await get('/fixtures/lineups?fixture=' + fin.fixture.id);
    const got = lu.j.response && lu.j.response.length;
    console.log('3) Lineups for that match:', got ? (got + ' team(s); formation ' + (lu.j.response[0].formation || '?') + '; ' + ((lu.j.response[0].startXI || []).length) + ' starters') : ('none' + (hasErr(lu.j.errors) ? ' -> ERRORS ' + JSON.stringify(lu.j.errors) : '')));
  }
  console.log('\nVerdict:');
  console.log('  - If (2) shows fixtures and (3) shows ~11 starters -> API-Football WORKS. Delete data.json and rebuild.');
  console.log('  - If you see ERRORS mentioning plan/subscription/season -> the FREE tier does not cover ' + SS + ' for you.');
})();
