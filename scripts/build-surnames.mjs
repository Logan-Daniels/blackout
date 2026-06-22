#!/usr/bin/env node
// build-surnames.mjs
// Reads surnames-to-fill.csv and writes the DISP_SURNAME block in index.html.
// Usage:  node build-surnames.mjs [path/to/index.html] [path/to/surnames-to-fill.csv]
// Defaults: ./index.html  and  ./surnames-to-fill.csv
//
// Only rows whose `surname` column is filled become overrides. Existing entries
// already in index.html are kept (so the seeded ones survive a blank cell); a
// filled cell adds or overrides. To delete an override, clear it in index.html.

import fs from 'node:fs';

const htmlPath = process.argv[2] || './index.html';
const csvPath  = process.argv[3] || './surnames-to-fill.csv';

const nrm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const esc = s => String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");

// --- tiny CSV parser (handles quotes, commas, newlines in fields) ---
function parseCSV(text){
  const rows=[]; let row=[], field='', i=0, q=false;
  text = text.replace(/\r\n?/g,'\n');
  while(i<text.length){
    const c=text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){ field+='"'; i+=2; continue; } q=false; i++; continue; }
      field+=c; i++; continue;
    }
    if(c==='"'){ q=true; i++; continue; }
    if(c===','){ row.push(field); field=''; i++; continue; }
    if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; i++; continue; }
    field+=c; i++;
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  return rows;
}

const html = fs.readFileSync(htmlPath,'utf8');

// start from existing entries between the markers so seeds survive a blank cell
const START='/*DISP_SURNAME_START*/', END='/*DISP_SURNAME_END*/';
const si=html.indexOf(START), ei=html.indexOf(END);
if(si<0 || ei<0 || ei<si){ console.error('Could not find DISP_SURNAME markers in '+htmlPath); process.exit(1); }
const map={};
const existing=html.slice(si+START.length, ei);
const re=/'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g; let m;
while((m=re.exec(existing))){ map[m[1].replace(/\\(.)/g,'$1')] = m[2].replace(/\\(.)/g,'$1'); }

// overlay CSV rows that have a surname filled
const rows = parseCSV(fs.readFileSync(csvPath,'utf8'));
const head = rows.shift().map(h=>h.trim().toLowerCase());
const ci = { full: head.indexOf('full_name'), sur: head.indexOf('surname') };
if(ci.full<0 || ci.sur<0){ console.error('CSV needs full_name and surname columns'); process.exit(1); }
let added=0;
for(const r of rows){
  const full=(r[ci.full]||'').trim(), sur=(r[ci.sur]||'').trim();
  if(!full || !sur) continue;
  map[nrm(full)] = sur; added++;
}

// emit, sorted by key
const keys=Object.keys(map).sort();
const body = keys.map(k=>"'"+esc(k)+"':'"+esc(map[k])+"'").join(',');
const block = START+'\nvar DISP_SURNAME={'+body+'};\n'+END;
const out = html.slice(0,si)+block+html.slice(ei+END.length);
fs.writeFileSync(htmlPath, out);
console.log('Wrote '+keys.length+' surname override(s) to '+htmlPath+' ('+added+' from CSV).');
