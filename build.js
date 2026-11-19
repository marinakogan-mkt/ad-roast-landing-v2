// Deploy-time precompile: turn the in-browser Babel + JSX into plain JS so the
// 500KB+ @babel/standalone runtime and the per-load JSX compile never ship to users.
// Runs on Vercel (buildCommand). Edits index.html IN PLACE, then Vercel serves it.
// Marina keeps editing the source index.html (with <script type="text/babel">) and
// pushing exactly as before; this step transforms it at deploy time only.
//
// 20 nov 2026: ademas el JS compilado ya NO se pega adentro del HTML, se escribe en
// /app.<hash>.js y el HTML queda con un <script src>. El motivo es el Fast Origin
// Transfer del plan: /b/<slug> y /board/<slug> NO son estaticos, los sirve una
// funcion (ver el rewrite en vercel.json), y cada respuesta de una funcion se cobra
// como trafico CDN<->Compute. Medido el 19 nov: de los 805 KB crudos de esa pagina,
// 784 KB eran este bloque inline, o sea 174 KB gzipped por pedido. Con el bundle
// afuera la funcion manda ~5 KB y el navegador baja el JS del CDN, que no cuenta
// para esa metrica.
//
// Para una persona ademas es mas rapido: el HTML pinta sin esperar los 784 KB, y el
// archivo queda cacheado en el navegador, asi que la segunda visita no lo baja. El
// nombre lleva el hash del contenido, asi que un deploy nuevo invalida solo y nunca
// se sirve una version vieja.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// El JS compilado va a su propio archivo, con el hash del contenido en el nombre.
const hash = createHash('sha256').update(compiled).digest('hex').slice(0, 12);
const ASSET = `app.${hash}.js`;
writeFileSync(ASSET, compiled, 'utf8');
console.log('[build] Bundle escrito en', ASSET, '-', compiled.length, 'bytes');

// El <script> queda sin defer ni async a proposito: un <script src> normal se
// ejecuta en el mismo punto del parseo que el inline que reemplaza, asi que
// cualquier script que venga despues en el HTML sigue corriendo despues que este.
// Con defer eso se rompe.
let out = html.slice(0, start) + `<script src="/${ASSET}"></script>` + html.slice(codeEnd + '</script>'.length);

// Drop the @babel/standalone CDN tag (any host) - no longer needed.
out = out.replace(/[ \t]*<script[^>]*@babel\/standalone[^>]*><\/script>\n?/g, '');

// Red de seguridad: si por lo que sea el HTML quedara sin la etiqueta del bundle,
// se cae el build en vez de publicar una pagina que no arranca para nadie.
if (out.indexOf(`<script src="/${ASSET}"></script>`) === -1) {
  console.error('[build] El HTML quedo sin la etiqueta del bundle; abortando.');
  process.exit(1);
}
if (out.indexOf('<div id="root"></div>') === -1) {
  console.error('[build] El HTML quedo sin <div id="root"></div>, que es donde monta React y donde el OG inyecta el texto del crawler; abortando.');
  process.exit(1);
}

writeFileSync(FILE, out, 'utf8');
console.log('[build] Listo. HTML:', html.length, '->', out.length, 'bytes (', Math.round(100 - out.length / html.length * 100), '% menos ). Bundle aparte:', compiled.length);
