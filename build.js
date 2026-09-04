// Deploy-time precompile: turn the in-browser Babel + JSX into plain JS so the
// 500KB+ @babel/standalone runtime and the per-load JSX compile never ship to users.
// Runs on Vercel (buildCommand). Edits index.html IN PLACE, then Vercel serves it.
// Marina keeps editing the source index.html (with <script type="text/babel">) and
// pushing exactly as before; this step transforms it at deploy time only.
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';

const FILE = 'index.html';
let html = readFileSync(FILE, 'utf8');

const START = '<script type="text/babel">';
const start = html.indexOf(START);
if (start === -1) {
  console.log('[build] No text/babel block found (already compiled?). Nothing to do.');
  process.exit(0);
}
const codeStart = start + START.length;
const codeEnd = html.indexOf('</script>', codeStart);
if (codeEnd === -1) {
  console.error('[build] Unterminated text/babel script.');
  process.exit(1);
}

const jsx = html.slice(codeStart, codeEnd);
console.log('[build] JSX source bytes:', jsx.length);

let compiled;
try {
  const res = transformSync(jsx, {
    filename: 'app.jsx',
    babelrc: false,
    configFile: false,
    compact: false,
    comments: false, // also drops the code comments -> smaller payload
    presets: [[presetReact, { runtime: 'classic' }]],
  });
  compiled = res.code;
} catch (e) {
  console.error('[build] Babel compile failed:', e.message);
  process.exit(1);
}
if (!compiled || !compiled.trim()) {
  console.error('[build] Empty compile output; aborting.');
  process.exit(1);
}

// Swap the babel block for the compiled JS (plain <script>, executes as classic).
let out = html.slice(0, start) + '<script>\n' + compiled + '\n</script>' + html.slice(codeEnd + '</script>'.length);

// Drop the @babel/standalone CDN tag (any host) - no longer needed.
out = out.replace(/[ \t]*<script[^>]*@babel\/standalone[^>]*><\/script>\n?/g, '');

writeFileSync(FILE, out, 'utf8');
console.log('[build] Done. Removed Babel runtime + inlined compiled JS. Output bytes:', out.length);
