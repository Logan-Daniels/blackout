#!/usr/bin/env node
// apply-gemini-fallback.mjs — one-time, idempotent migration.
//
// Rewrites the optional AI fallback in build-data.mjs (the step that resolves
// leftover recap titles the rules could not place) to call Gemini instead of
// Anthropic, so it uses your existing keys/gemini.txt (or GEMINI_API_KEY). It
// only touches that one block; everything else, including any broadcasters you
// have added, is left alone. Safe to run twice. Delete it afterwards if you like.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const findIn = (n, dirs) => { for (const d of dirs) { const p = join(d, n); if (existsSync(p)) return p; } return null; };
const ROOT = dirname(findIn('index.html', [join(here, '..'), here, process.cwd()]) || join(here, '..'));
const buildPath = findIn('build-data.mjs', [here, ROOT, join(ROOT, 'scripts'), process.cwd()]);
if (!buildPath) { console.error('Could not find build-data.mjs. Run from inside the repo.'); process.exit(1); }

let s = readFileSync(buildPath, 'utf8');
if (!s.includes('api.anthropic.com') && !s.includes('ANTHROPIC_API_KEY')) {
  console.log('build-data.mjs: AI fallback is already on Gemini, nothing to do.');
  process.exit(0);
}

const edits = [
  [' * Optional: ANTHROPIC_API_KEY lets a model resolve recap titles the rules miss.',
   ' * Optional: GEMINI_API_KEY lets a model resolve recap titles the rules miss.'],

  ["const AI_KEY = process.env.ANTHROPIC_API_KEY || keyFile('anthropic');\nconst AI_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';",
   "const AI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || keyFile('gemini');\nconst AI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';"],

  [`    const resp = await getJSON('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 1800, messages: [{ role: 'user', content: prompt }] })
    });
    const text = (resp.content || []).map(c => c.text || '').join('').replace(/\`\`\`json|\`\`\`/g, '').trim();`,
   `    const resp = await getJSON(\`https://generativelanguage.googleapis.com/v1beta/models/\${AI_MODEL}:generateContent?key=\${encodeURIComponent(AI_KEY)}\`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
    });
    const text = ((resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || []).map(p => p.text || '').join('').replace(/\`\`\`json|\`\`\`/g, '').trim();`],

  [`    let aiAdded = 0;
    for (const item of JSON.parse(text)) {`,
   `    let parsed = JSON.parse(text); if (!Array.isArray(parsed)) parsed = parsed.results || parsed.items || parsed.matches || [];
    let aiAdded = 0;
    for (const item of parsed) {`],
];

for (const [oldS, newS] of edits) {
  const c = s.split(oldS).length - 1;
  if (c !== 1) { console.error(`Expected to find this exactly once, found ${c}x:\n  ${oldS.split('\n')[0]}\nAborting without writing.`); process.exit(1); }
  s = s.replace(oldS, newS);
}
writeFileSync(buildPath, s);
console.log('build-data.mjs: AI fallback now calls Gemini (keys/gemini.txt or GEMINI_API_KEY).');
console.log('Re-run with:  DEEP=1 node scripts/build-data.mjs   (watch for an "ai fallback: resolved N" line)');
