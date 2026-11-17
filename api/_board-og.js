// Per-company Open Graph for /b/<slug> (and /board/<slug>). A link shared on LinkedIn shows a card
// built from the OG tags in the served HTML, and the crawler does NOT run JS, so a personalized card
// (about THAT company's board, not the generic AdRoast card) has to be rendered server-side. This
// function serves the same SPA shell with the og:/twitter: tags rewritten for the company, so real
// users still get the app and boot normally, while the crawler reads the company-specific card.
// Any failure falls back to the untouched shell, so the board can never break from this.
import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

let _redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  }
} catch (e) { _redis = null; }

// Cache the shell in memory across warm invocations. Disk first (the built index.html ships with the
// deployment); if that ever fails, fetch the static root of the same site (which serves index.html).
let _shell = null;
async function getShell() {
  if (_shell) return _shell;
  for (const p of [path.join(process.cwd(), 'index.html'), '/var/task/index.html']) {
    try { const s = fs.readFileSync(p, 'utf8'); if (s && s.length > 500) { _shell = s; return _shell; } } catch (e) {}
  }
  try {
    const r = await fetch('https://www.adroast.in/', { headers: { 'x-og-bypass': '1' } });
    const s = await r.text();
    if (s && s.length > 500) { _shell = s; return _shell; }
  } catch (e) {}
  return null;
}

const attr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// slug -> domain: mirrors the client's expandDom (a dot-less slug is a .com; anything with a dot is
// already a domain). Then a display name from the first label ("softr.io" -> "Softr").
function slugToDomain(slug) {
  let s = String(slug || '').trim().toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
  s = s.split(/[/?#]/)[0];
  if (!s) return '';
  return s.indexOf('.') === -1 ? s + '.com' : s;
}
// /b/<domain>/linkedin (or /google, /meta) is the board filtered to one platform. The outreach line
// links it as "the two linkedin ads I'd fix first are in here", so its card names the platform.
const PLAT_LABEL = { linkedin: 'LinkedIn', google: 'Google', meta: 'Meta' };

function slugToPlatform(slug) {
  const m = String(slug || '').toLowerCase().match(/^[^/?#]+\/(linkedin|google|meta)\/?(?:[?#].*)?$/);
  return m ? m[1] : '';
}
function nameFromDomain(domain) {
  const label = String(domain || '').split('.')[0].replace(/[^a-z0-9]+/gi, ' ').trim();
  if (!label) return 'This company';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Same demand-gen exclusions the board uses, so the headline stats match what the CMO sees.
function boardStats(ads) {
  const scored = (ads || []).filter(a => typeof a.score === 'number');
  if (!scored.length) return null;
  const avg = scored.reduce((s, a) => s + a.score, 0) / scored.length;
  // Same cut as the board overview card ("ads to fix" = score 6 or less), so the search
  // snippet never says "0 to fix" while the board itself shows several.
  const toFix = scored.filter(a => a.score <= 6).length;
  return { count: scored.length, avg: Math.round(avg * 10) / 10, toFix };
}

function replaceTag(html, re, value) {
  return re.test(html) ? html.replace(re, value) : html;
}

/* Un crawler no corre JavaScript: de esta pagina usa el title, la description, el JSON-LD y el
   texto. Igual le mandabamos la app React entera, 169,5 KB gzipped, y el sitemap de boards le da
   1.074 URLs a 7 familias de bots. Medido el 19 nov 2026: la pagina completa pesa 169,5 KB
   gzipped y la liviana, con el MISMO title, description, canonical, og/twitter, JSON-LD y texto
   del board, pesa 2,2 KB. Son 78 veces menos, y el Fast Origin Transfer (el trafico CDN<->funcion,
   que es lo que se paso de los 10 GB del plan) se cobra por byte que la funcion le manda al CDN.

   La lista es por familia conocida, no por heuristica: si el User-Agent no cae con certeza en un
   bot, se sirve el bundle completo. Gastar de mas no rompe nada; servirle la pagina chica a una
   persona le rompe el board. Por eso no estan aca ni HeadlessChrome ni PhantomJS (Lighthouse y
   cualquier chequeo de rendimiento tienen que ver la pagina real que ve una persona). */
const BOT_RE = new RegExp([
  // buscadores
  'googlebot', 'google-inspectiontool', 'storebot-google', 'googleother', 'google-extended',
  'bingbot', 'bingpreview', 'msnbot', 'duckduckbot', 'duckduckgo-favicons-bot', 'yandexbot',
  'yandeximages', 'baiduspider', 'sogou', 'seznambot', 'naver', 'qwantify', 'applebot',
  'petalbot', 'mojeekbot', 'yisouspider',
  // motores de respuesta y crawlers de LLM
  'gptbot', 'oai-searchbot', 'chatgpt-user', 'perplexitybot', 'perplexity-user', 'claudebot',
  'claude-web', 'claude-searchbot', 'anthropic-ai', 'ccbot', 'cohere-ai', 'cohere-training-data-crawler',
  'meta-externalagent', 'meta-externalfetcher', 'bytespider', 'amazonbot', 'youbot', 'diffbot',
  'timpibot', 'omgili', 'omgilibot', 'webzio-extended', 'ai2bot', 'firecrawl', 'brightbot',
  // tarjetas de preview al compartir un link (solo leen el <head>)
  'linkedinbot', 'facebookexternalhit', 'facebookcatalog', 'facebookbot', 'twitterbot',
  'slackbot', 'slack-imgproxy', 'discordbot', 'whatsapp', 'telegrambot', 'skypeuripreview',
  'redditbot', 'pinterest', 'tumblr', 'vkshare', 'embedly', 'quora link preview',
  'nuzzel', 'bitlybot', 'flipboard', 'outbrain', 'xing-contenttabreceiver', 'google-pagerenderer',
  // SEO y archivo
  'ahrefsbot', 'ahrefssiteaudit', 'semrushbot', 'mj12bot', 'dotbot', 'rogerbot', 'blexbot',
  'dataforseobot', 'serpstatbot', 'seokicks', 'sistrix', 'screaming frog', 'barkrowler',
  'megaindex', 'zoominfobot', 'linkdexbot', 'exabot', 'ia_archiver', 'archive.org_bot',
  'wayback', 'heritrix', 'nutch', 'commoncrawl', 'exa-bot', 'imagesiftbot', 'awariobot',
  'trendictionbot', 'gigablast', 'siteauditbot', 'semantic-visions'
].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

// Igual que arriba: un match generico ("bot", "crawler", "spider") solo cuenta cuando NO viene con
// la pinta de un navegador real. Un Chrome o un Safari de verdad nunca traen estas palabras, pero
// si alguna vez las trajera, se va por el bundle completo.
const GENERIC_BOT_RE = /(crawler|spider|crawling|\bbot\b|bot\/|\bfeed(fetcher|burner)\b|scrapy|python-requests|python-urllib|node-fetch|go-http-client|okhttp|java\/|libwww-perl|axios\/|got\/|curl\/|wget)/i;
const BROWSERISH_RE = /\b(firefox|edg|edge|opr|samsungbrowser|crios|fxios)\b/i;

/* Los bots que arman la tarjeta cuando alguien PEGA el link en algun lado. Son los unicos que
   necesitan el PNG por empresa, porque esa tarjeta es la que ve un prospecto cuando Marina le manda
   el board: 290 KB medidos en produccion el 19 nov 2026, contra los 2,2 KB de la pagina liviana, o
   sea que la imagen pesa 130 veces la pagina.

   Un buscador o un crawler de LLM no muestra esa tarjeta, asi que se lleva el PNG estatico del CDN
   (og-hero.png, el mismo que usa el home), que no cuesta Fast Origin Transfer porque no sale de la
   funcion. Lo que cambia con esto es la imagen que Google pueda mostrar en resultados: pasa de la
   del board a la generica de AdRoast. El texto, el title, la description y el JSON-LD no cambian.

   Applebot esta aca y no en los buscadores a proposito: es el mismo agente que arma la preview de
   un link en iMessage, asi que se le deja la imagen buena. Su volumen es bajo. */
const PREVIEW_BOT_RE = /(linkedinbot|facebookexternalhit|facebookcatalog|facebookbot|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegrambot|skypeuripreview|redditbot|pinterest|tumblr|vkshare|embedly|quora link preview|nuzzel|bitlybot|flipboard|outbrain|xing-contenttabreceiver|iframely|applebot|snapchat|viber|line-poker|googlebot-image)/i;

function isPreviewBot(req) {
  try {
    const ua = String((req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '');
    if (!ua) return true;        // sin User-Agent no se sabe quien es: la imagen buena
    return PREVIEW_BOT_RE.test(ua);
  } catch (e) { return true; }   // ante la duda, la imagen buena: gastar de mas no rompe la tarjeta
}

function isCrawler(req) {
  try {
    const ua = String((req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '');
    if (!ua) return false;                 // sin User-Agent no se asume nada: bundle completo
    if (BOT_RE.test(ua)) return true;
    if (BROWSERISH_RE.test(ua)) return false;
    return GENERIC_BOT_RE.test(ua);
  } catch (e) { return false; }
}

/* La pagina que ve el crawler. Se arma de cero, sin leer index.html: asi la funcion no toca los
   800 KB de la cascara ni los vuelve a comprimir, que es lo mas caro en CPU de este pedido (el
   Fluid Active CPU del plan esta al 80%).

   Lo que NO lleva, a proposito: el script de GEO_HEAD que pone html.has-js. En la pagina completa
   ese script esconde el texto del crawler porque React lo reemplaza; aca no hay React, asi que
   ponerlo dejaria la pagina en blanco para cualquier cliente que SI corra JavaScript, Googlebot
   incluido, que renderiza con Chromium. El texto va siempre visible. */
function lightCrawlerPage(o) {
  const m = [];
  const meta = (k, v, prop) => m.push('<meta ' + (prop ? 'property' : 'name') + '="' + k + '" content="' + attr(v) + '">');
  m.push('<meta charset="utf-8">');
  m.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  m.push('<title>' + attr(o.docTitle) + '</title>');
  meta('description', o.desc);
  m.push('<link rel="canonical" href="' + attr(o.boardUrl) + '">');
  if (o.noindex) meta('robots', 'noindex, follow');
  meta('og:type', 'website', 1);
  meta('og:site_name', 'AdRoast', 1);
  meta('og:title', o.title, 1);
  meta('og:description', o.desc, 1);
  meta('og:url', o.shareUrl, 1);
  meta('og:image', o.imgUrl, 1);
  meta('og:image:secure_url', o.imgUrl, 1);
  meta('og:image:width', String(o.imgW || 1200), 1);
  meta('og:image:height', String(o.imgH || 630), 1);
  meta('og:image:type', 'image/png', 1);
  meta('og:image:alt', o.title, 1);
  meta('twitter:card', 'summary_large_image');
  meta('twitter:title', o.title);
  meta('twitter:description', o.desc);
  meta('twitter:image', o.imgUrl);
  m.push('<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png?v=5">');
  if (o.ld) m.push('<script type="application/ld+json">' + JSON.stringify(o.ld).replace(/</g, '\\u003c') + '</script>');
  const body = o.content
    || ('<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
      + '<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">' + attr(o.title) + '</h1>'
      + '<p>AdRoast scores a company&rsquo;s live LinkedIn and Google ads against their own ideal buyer.</p>'
      + '<p><a href="' + attr(o.boardUrl) + '">Open this board on AdRoast</a>.</p>'
      + '</main>');
  return '<!doctype html><html lang="en"><head>' + m.join('') + '</head><body>' + body + '</body></html>';
}

export async function boardOgHandler(req, res) {
  const slug = (req.query && (req.query.slug || req.query.s)) || '';
  // ?full=1 fuerza el bundle completo con cualquier User-Agent, para poder comparar las dos
  // versiones de la misma URL sin tener que adivinar como la vio un bot.
  const bot = !(req.query && req.query.full) && isCrawler(req);
  // Un crawler no necesita la cascara: la pagina liviana se arma de cero mas abajo.
  let html = bot ? null : await getShell();
  try {
    if (!html && !bot) { res.setHeader('Location', '/'); res.status(302).end(); return; }
    const domain = slugToDomain(slug);
    if (!domain) {
      // Camino raro (/b/ sin slug). No se cambia lo que devolvia antes: la cascara con 200. Si es
      // un bot todavia no la tenemos cargada, asi que se pide aca, que es barato por ser raro.
      const shell = html || await getShell();
      if (!shell) { res.setHeader('Location', '/'); res.status(302).end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(shell); return;
    }

    let company = nameFromDomain(domain);
    // Canonical form is the normalized domain (the sitemap lists /b/<domain>), so /b/wiz,
    // /b/Wiz.io and /board/wiz.io all consolidate on one indexable URL.
    const boardUrl = 'https://www.adroast.in/b/' + encodeURIComponent(domain);
    const plat = slugToPlatform(slug);
    const platLabel = PLAT_LABEL[plat] || '';
    // The shared URL of the platform view. LinkedIn caches the preview by og:url, so pointing a
    // /linkedin link at the plain board URL would serve the board-wide card. Canonical stays the board.
    const shareUrl = plat ? boardUrl + '/' + plat : boardUrl;

    // Enrich with real board stats when the pull is cached (free, no model call).
    // Read the CLEAN, scored, non-artifact ad list persisted for GEO (ads:geo), not the
    // raw pull: the raw list can hold capture artifacts and other advertisers' creatives
    // that the board only filters out AFTER scoring, so publishing it would show wrong ads.
    let stats = null, ads = [], posdata = null;
    if (_redis) {
      try {
        const domKey = domain.replace(/[^a-z0-9.]/g, '');
        const raw = await _redis.get('ads:geo:' + domKey);
        const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        ads = Array.isArray(list) ? list : [];
        stats = ads.length ? boardStats(ads) : null;
        // The positioning record carries the company's real name ("Palo Alto Networks", not
        // "Paloaltonetworks" from the domain label). With no clean ads it is also the
        // fallback content, so a company with no readable live ads still gets a crawlable page.
        const pr = await _redis.get('geo:icp:' + domKey);
        const icpRec = pr ? (typeof pr === 'string' ? JSON.parse(pr) : pr) : null;
        const realName = icpRec && typeof icpRec.company === 'string' ? icpRec.company.trim() : '';
        // The name passed on ads-fetch wins: the positioning record sometimes stores the
        // domain label itself ("Orcasecurity"), which is exactly what we want to avoid.
        const nm = await _redis.get('geo:name:' + domKey);
        if (nm && typeof nm === 'string' && nm.trim() && nm.trim().length <= 60) company = nm.trim();
        else if (realName && realName.length <= 60) company = realName;
        if (!ads.length) posdata = icpRec;
      } catch (e) { stats = null; ads = []; posdata = null; }
    }

    // Platform view: its own title and numbers, from the same clean list filtered to that platform.
    const platAds = plat ? ads.filter(a => String(a.plat || '').toLowerCase() === plat) : [];
    const platStats = platAds.length ? boardStats(platAds) : null;
    // Which platforms this company actually has clean live ads on, so the board-wide title and
    // description name only those (a company with 0 Google ads never reads "LinkedIn & Google", and
    // the list reflects Meta now that it is live). Falls back to all three only when there are no ads.
    const _present = ['LinkedIn', 'Google', 'Meta'].filter(P => ads.some(a => String(a.plat || '').toLowerCase() === P.toLowerCase()));
    const _join = (arr, amp) => arr.length === 0 ? (amp ? 'LinkedIn, Google & Meta' : 'LinkedIn, Google and Meta')
      : arr.length === 1 ? arr[0]
      : arr.slice(0, -1).join(', ') + (amp ? ' & ' : ' and ') + arr[arr.length - 1];
    const platsAnd = _join(_present, false);
    const platsAmp = _join(_present, true);
    // Marina's own copy, 9 nov 2026. One line per card, and the two never repeat: the board link
    // names the company, the platform link names the ad. That split is the point of the card split,
    // so a company on a single platform does not get the identical preview under both messages.
    const title = plat
      ? 'Start here: your worst ' + platLabel + ' ad.'
      : company + ' ads, brutally reviewed.';
    // Nothing else goes under the title: the factual line below is what LinkedIn prints.
    const desc = plat
      ? (platStats
        ? company + "'s live " + platLabel + ' ads, each scored against their ideal buyer. ' + platStats.count + ' live ' + platLabel + ' ads, ' + platStats.avg + '/10 average fit, ' + platStats.toFix + ' to fix.'
        : company + "'s live " + platLabel + ' ads, each scored against their ideal buyer, with the exact fix for the ones to change first.')
      : stats
      ? company + "'s live " + platsAnd + " ads, each scored against their ideal buyer. " + stats.count + ' live ads, ' + stats.avg + '/10 average fit, ' + stats.toFix + ' to fix. See the board.'
      : company + "'s live " + platsAnd + " ads, each scored against their ideal buyer, with the exact fixes. Free, no card.";

    // Search-engine identity of the page: without these the board ships the home's <title>,
    // meta description and canonical (https://www.adroast.in/), so Google folds every board into
    // the home as a duplicate and never indexes it. Board-specific, self-canonical.
    const docTitle = (plat
      ? company + ' live ' + platLabel + ' ads, scored against their buyer'
      : company + ' ' + platsAmp + ' ads, scored against their buyer') + ' | AdRoast';
    html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${attr(docTitle)}</title>`);
    html = replaceTag(html, /(<meta name="description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<link rel="canonical" href=")[^"]*(">)/, `$1${attr(boardUrl)}$2`);

    html = replaceTag(html, /(<meta property="og:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta property="og:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<meta property="og:url" content=")[^"]*(">)/, `$1${attr(shareUrl)}$2`);
    html = replaceTag(html, /(<meta name="twitter:title" content=")[^"]*(">)/, `$1${attr(title)}$2`);
    html = replaceTag(html, /(<meta name="twitter:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);

    // Per-company og:image: a 1200x630 PNG rendered for THIS company (name + live board stats) by
    // /api/icp?ogimg=1 (satori + resvg-wasm). Falls back to the static hero on any render error.
    // v=p2: a new image URL for the platform card, so a crawler that cached the old board-wide image
    // under the same URL fetches the new one.
    const imgUrl = 'https://www.adroast.in/api/icp?ogimg=1&slug=' + encodeURIComponent(domain)
      + (plat ? '&p=' + plat + '&v=p2' : '');
    html = replaceTag(html, /(<meta property="og:image" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    // LinkedIn and Slack prefer og:image:secure_url when both are present, so leaving it
    // on the static card silently served the generic image for every board.
    html = replaceTag(html, /(<meta property="og:image:secure_url" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    html = replaceTag(html, /(<meta name="twitter:image" content=")[^"]*(">)/, `$1${attr(imgUrl)}$2`);
    html = replaceTag(html, /(<meta property="og:image:alt" content=")[^"]*(">)/, `$1${attr(title)}$2`);

    // GEO (generative-engine optimization): inject real, crawlable body content plus
    // JSON-LD so LLM crawlers (GPTBot, PerplexityBot, ClaudeBot) and search bots read
    // a substantive page, not an empty SPA shell. React calls createRoot(#root).render
    // on mount, which REPLACES this markup, so real (JS) users never see it, only the
    // no-JS crawler does. Injected ONLY when the company has real scored ads, so a
    // company with nothing to say never produces a thin page.
    //
    // Progressive enhancement so a human never sees that crawler text flash before the app
    // boots: the inline head script sets html.has-js during parse (before first paint), which
    // hides the SEO shell and shows a clean loader for JS users. No-JS crawlers never set the
    // class, so they still read the full visible text. React then replaces #root with the board.
    const GEO_HEAD = '<style>@keyframes geospin{to{transform:rotate(360deg)}}.geo-loading{display:none}'
      + 'html.has-js .geo-shell{display:none!important}html.has-js .geo-loading{display:flex!important}</style>'
      + '<script>document.documentElement.classList.add("has-js")</script>';
    const GEO_LOADING = '<div class="geo-loading" style="min-height:70vh;align-items:center;justify-content:center">'
      + '<div style="width:34px;height:34px;border:3px solid #e7ecf3;border-top-color:#0a66c2;border-radius:50%;animation:geospin .8s linear infinite"></div></div>';
    const injectRoot = (h, content) => h ? h.replace('<div id="root"></div>', '<div id="root">' + GEO_LOADING + '<div class="geo-shell">' + content + '</div></div>') : h;
    // El texto y el JSON-LD se calculan una sola vez y los usan las dos versiones de la pagina:
    // la completa los inyecta en la cascara, la liviana los sirve solos. Asi un bot y una persona
    // nunca pueden ver un board distinto.
    let botContent = null, botLd = null;
    const listable = ads.filter(a => a && (a.head || a.headline));
    if (listable.length > 0) {
      const items = listable.slice(0, 20).map(a => {
        const h = attr(a.head || a.headline);
        const sc = (typeof a.score === 'number') ? `, scored ${a.score}/10 against ${attr(company)}&rsquo;s ideal buyer` : '';
        const v = a.verdict ? '. ' + attr(String(a.verdict)) : '';
        return `<li><strong>${h}</strong>${sc}${v}</li>`;
      }).join('');
      const statLine = stats ? ` Their average fit to their own ideal buyer is ${stats.avg} out of 10, and ${stats.toFix === 1 ? '1 ad needs fixing' : stats.toFix + ' ads need fixing'}.` : '';
      const intro = `${attr(company)} is running ${listable.length} live ads on ${attr(platsAnd)}.${statLine} Each ad below is one of ${attr(company)}&rsquo;s real live creatives, read straight from the ad libraries.`;
      const content = '<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
        + `<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">${attr(title)}</h1>`
        + `<p>${intro}</p>`
        + `<h2 style="font-size:18px;font-weight:600;margin-top:26px">${attr(company)}&rsquo;s live ads, scored against their buyer</h2>`
        + `<ul>${items}</ul>`
        + `<p><a href="/b/${attr(slug)}">See ${attr(company)}&rsquo;s full live-ad board on AdRoast</a>. Every creative scored against their ICP, with the exact fix for each.</p>`
        + `<p>Learn the method behind these scores: the AdRoast <a href="/guides">guides</a> cover how to <a href="/guides/audit-linkedin-ads-icp">audit your ads against your ICP</a> and why <a href="/guides/clicks-no-pipeline">clicks do not turn into pipeline</a>.</p>`
        + '</main>';
      html = injectRoot(html, content);
      const ld = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: title,
        description: desc,
        url: boardUrl,
        // logo: the COMPANY's own logo, resolved + re-served by our logo proxy (declared-on-site icon,
        // then Logo.dev / Google favicon). Without it the only Organization logo a crawler finds on a
        // board is AdRoast's own (the global org schema in index.html), so the board reads as if AdRoast
        // were the advertiser. This pins the board's subject logo to the company, never to our brand.
        about: { '@type': 'Organization', name: company, url: 'https://' + domain, logo: 'https://www.adroast.in/api/icp?logo=' + encodeURIComponent(domain) }
      };
      botContent = content; botLd = ld;
      const ldScript = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
      if (html) html = html.replace('</head>', GEO_HEAD + ldScript + '</head>');
    } else if (posdata && posdata.company) {
      // GEO phase 2: no readable live ads, so render a positioning page (who they sell to)
      // instead, keeping a crawlable, citable page for a company with no ad footprint.
      const comp = attr(posdata.company);
      const tagList = Array.isArray(posdata.tags) ? posdata.tags.filter(Boolean).slice(0, 8) : [];
      const content = '<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
        + `<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">${comp}: who they sell to, and their live ad presence</h1>`
        + (posdata.summary ? `<p>${attr(posdata.summary)}</p>` : '')
        + (posdata.icp_text ? `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Who ${comp} sells to</h2><p>${attr(posdata.icp_text)}</p>` : '')
        + (tagList.length ? `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Buyer and segments</h2><ul>${tagList.map(t => `<li>${attr(t)}</li>`).join('')}</ul>` : '')
        + `<h2 style="font-size:18px;font-weight:600;margin-top:26px">Live ad presence</h2><p>We checked the LinkedIn and Google ad libraries and found no live ads we can read for ${comp} right now. When they run ads, AdRoast scores each one against the buyer above.</p>`
        + `<p><a href="/b/${attr(slug)}">Score ${comp}&rsquo;s ads against this buyer on AdRoast</a>.</p>`
        + `<p>Learn the method: the AdRoast <a href="/guides">guides</a> cover how to <a href="/guides/audit-linkedin-ads-icp">audit ads against your ICP</a> and how to <a href="/guides/what-is-an-ad-teardown">run an ad teardown</a>.</p>`
        + '</main>';
      html = injectRoot(html, content);
      // logo: the company's own logo via our resolver (see the board branch above), so this positioning
      // page does not inherit AdRoast's logo as the only Organization logo on the page.
      const ld = { '@context': 'https://schema.org', '@type': 'Organization', name: posdata.company, url: posdata.website || ('https://' + domain), description: posdata.summary || posdata.icp_text || '', logo: 'https://www.adroast.in/api/icp?logo=' + encodeURIComponent(domain) };
      botContent = content; botLd = ld;
      const ldScript = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
      if (html) html = html.replace('</head>', GEO_HEAD + ldScript + '</head>');
    }

    // Nothing real to show (no clean ads, no positioning record): keep it out of the index so an
    // arbitrary /b/<anything> never becomes a thin indexed page. Humans still get the app.
    const noindex = !listable.length && !(posdata && posdata.company);
    if (noindex && html) {
      html = html.replace('</head>', '<meta name="robots" content="noindex, follow"></head>');
    }

    /* Aca se parte: el crawler se lleva la pagina chica, la persona el bundle entero, sin cambiar
       una coma de lo que recibe hoy. La chica NO se cachea en el CDN a proposito: el CDN guarda por
       URL, no por User-Agent, asi que una pagina chica cacheada se le podria servir a una persona y
       dejarla sin board. Un Vary: User-Agent lo arreglaria formalmente pero parte el cache por cada
       variante de User-Agent, tambien las de los navegadores, y eso SUBIRIA el Fast Origin Transfer.
       Sin cachear, cada pedido de bot invoca la funcion y cuesta 2,2 KB en vez de 169,5 KB; las
       invocaciones estan al 12,8% de 1.000.000, hay lugar de sobra, y esta rama no lee ni comprime
       los 800 KB de la cascara, asi que tambien gasta menos CPU que la completa. */
    if (bot) {
      /* El og:image del board se renderiza con satori + resvg y pesa 290 KB (medido en produccion).
         Solo lo necesita el bot que arma la tarjeta al pegar el link; al resto le va el PNG estatico,
         que sale del CDN y no cuesta Fast Origin Transfer. og-hero.png mide 2400x1260 de verdad. */
      /* MEDIDA TEMPORAL CON VENCIMIENTO, 20 nov 2026.

         Hasta esta fecha y hora, la tarjeta por empresa se apaga para TODOS, tambien
         para LinkedIn, y el PNG dinamico deja de fabricarse por completo. Cada render
         son 290 KB y, despues de bajar las paginas de 174 KB a 7,3 KB, los renders
         pasaron a ser TODO el Fast Origin Transfer que queda: medido el 20 nov a las
         20:20 UTC, 47 renders/h contra un presupuesto de 23/h. Apagarlos deja el
         consumo en ~4,6 MB/h, abajo del presupuesto de 6,4 MB/h que hace falta para
         bajar del limite antes de que Vercel pause la cuenta (plazo 15:27 UTC).

         SE APAGA SOLO. No hace falta deployar nada ni que nadie se acuerde: pasada la
         fecha, la condicion da false y vuelve la tarjeta por empresa, en el mismo
         deploy que esta corriendo. Se eligio 16:00 UTC, media hora despues del plazo
         de Vercel, y el vigilante que reactiva el outreach de ICP (cola-cron y
         tarjetas-cron, pausados en la maquina de Marina) arranca a esa misma hora,
         asi que las tarjetas vuelven a ser por empresa ANTES de que vuelva a salir un
         mensaje con link de board.

         Lo que se pierde mientras dura: un board compartido en LinkedIn muestra la
         tarjeta generica de AdRoast en vez de la de la empresa. Por eso el outreach de
         ICP quedo pausado en paralelo: Marina no quiere mandar outreach con tarjetas
         que no esten bien. Los mensajes ya enviados NO se tocan, porque LinkedIn se
         guarda su propia copia de la tarjeta cuando la arma. */
      const FIN_EMERGENCIA = Date.parse('2026-11-20T16:00:00Z');
      const tarjetaGenericaParaTodos = Date.now() < FIN_EMERGENCIA;

      const preview = !tarjetaGenericaParaTodos && isPreviewBot(req);
      const bImg = preview ? imgUrl : 'https://www.adroast.in/og-hero.png?v=1';
      const light = lightCrawlerPage({ docTitle, desc, title, boardUrl, shareUrl,
        imgUrl: bImg, imgW: preview ? 1200 : 2400, imgH: preview ? 630 : 1260,
        ld: botLd, content: botContent, noindex });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', noindex ? 'noindex, follow' : 'index, follow');
      res.status(200).send(light);
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    /* El CDN guarda esta pagina un DIA, y sirve la vieja hasta una semana mientras la refresca.
       Antes era una hora. El motivo (19 nov 2026): sitemap-boards.xml le da a los crawlers 1.074
       URLs de board, y cada una devuelve 174 KB de app desde la funcion. Con una hora de cache,
       cada pasada de cada bot (Google, ahrefs, petalbot, exa, LinkedIn, Meta) vuelve a pedirlas
       todas: 182 MB por pasada. El ciclo de Vercel cerro el 19 nov en 10,01 de 10 GB de Fast
       Origin Transfer, o sea pasado. Una pagina de board es la cascara de la app con sus meta
       tags: no cambia cada hora, y stale-while-revalidate la refresca sola por detras. */
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).send(html);
  } catch (e) {
    // Never break the board: serve the plain shell on any error. Si el pedido venia de un crawler
    // no hay cascara cargada (la rama liviana no la lee), asi que se pide aca: un 302 al home
    // desde la URL de un board le diria al crawler que el board no existe.
    try { if (!html) html = await getShell(); } catch (e2) {}
    if (html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); }
    else { res.setHeader('Location', '/'); res.status(302).end(); }
  }
}

// Services page OG + crawlable body for /services and /work-with-us (rewritten to
// /api/icp?services=1). Without this the services URL ships the tool home's <title>
// ("free live-ad audit"), meta and empty SPA shell, so crawlers never see the
// positioning offer. Static content (no Redis); React clears #root so humans boot the app.
export async function servicesOgHandler(req, res) {
  // Lo mismo que en el board: /services y /work-with-us devolvian la app React entera, 178 KB
  // gzipped medidos el 19 nov 2026, y de esa pagina un crawler usa el title, la description, el
  // JSON-LD del Service y el texto de la oferta. Son dos URLs, no 1.074, pero estan en el sitemap
  // principal y las pasan las mismas 7 familias de bots, y el contenido aca es fijo.
  const bot = !(req.query && req.query.full) && isCrawler(req);
  let html = bot ? null : await getShell();
  try {
    if (!html && !bot) { res.setHeader('Location', '/'); res.status(302).end(); return; }
    const url = 'https://www.adroast.in/services';
    const docTitle = 'Reposition your paid campaigns around the buyer | AdRoast';
    const desc = 'For B2B SaaS spending on paid: we find where your campaign loses the right buyers and reposition the whole ad-to-page journey. 10-day Campaign Repositioning Sprint.';
    const ogTitle = "Spending on ads but the right buyers aren't booking?";

    html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${attr(docTitle)}</title>`);
    html = replaceTag(html, /(<meta name="description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<link rel="canonical" href=")[^"]*(">)/, `$1${attr(url)}$2`);
    html = replaceTag(html, /(<meta property="og:title" content=")[^"]*(">)/, `$1${attr(ogTitle)}$2`);
    html = replaceTag(html, /(<meta property="og:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);
    html = replaceTag(html, /(<meta property="og:url" content=")[^"]*(">)/, `$1${attr(url)}$2`);
    html = replaceTag(html, /(<meta name="twitter:title" content=")[^"]*(">)/, `$1${attr(ogTitle)}$2`);
    html = replaceTag(html, /(<meta name="twitter:description" content=")[^"]*(">)/, `$1${attr(desc)}$2`);

    const h2 = 'font-size:18px;font-weight:600;margin-top:26px';
    const content = '<main style="max-width:720px;margin:0 auto;padding:40px 20px;font-family:system-ui,-apple-system,sans-serif;color:#1f2937;line-height:1.65">'
      + '<h1 style="font-size:26px;font-weight:600;letter-spacing:-.3px">Spending on ads but the right buyers aren&rsquo;t booking?</h1>'
      + '<p>AdRoast&rsquo;s positioning services are built for B2B SaaS teams spending on paid. We find where your campaign loses the right buyers and reposition the whole ad-to-page journey around them, so the demos your ads earn actually show up.</p>'
      + `<h2 style="${h2}">Message Drift: why the click never becomes a booked demo</h2>`
      + '<p>In B2B campaigns the ad creates one expectation while the landing page introduces another. Our positioning sprints identify and repair that break across the ad, the landing page and the sales narrative.</p>'
      + `<h2 style="${h2}">What you get</h2>`
      + '<ul>'
      + '<li><strong>Campaign Repositioning Sprint</strong> (one-time, 10 days): a campaign teardown, a new positioning direction, messaging angles ranked by upside, a rewritten ad-to-page journey and a ranked action plan. About 3 hours of your time.</li>'
      + '<li><strong>Done-For-You Rebuild</strong> (3-month): the same diagnosis, then our team builds it, launches it and optimizes it live.</li>'
      + '</ul>'
      + `<h2 style="${h2}">Proof: public ad teardowns of SaaS you know</h2>`
      + '<ul><li><a href="/teardowns/kanopy-security">Kanopy Security ad teardown</a></li><li><a href="/teardowns/cyberhaven">Cyberhaven ad teardown</a></li><li><a href="/teardowns/drata">Drata ad teardown</a></li><li><a href="/teardowns/cato-networks">Cato Networks ad teardown</a></li><li><a href="/teardowns/databricks">Databricks ad teardown</a></li><li><a href="/teardowns/typeform">Typeform ad teardown</a></li><li><a href="/teardowns/orca-security">Orca Security ad teardown</a></li><li><a href="/teardowns/snyk">Snyk ad teardown</a></li><li><a href="/teardowns/monday">monday.com ad teardown</a></li><li><a href="/teardowns/klaviyo">Klaviyo ad teardown</a></li><li><a href="/teardowns/webflow">Webflow ad teardown</a></li><li><a href="/teardowns/clickup">ClickUp ad teardown</a></li><li><a href="/teardowns/silverfort">Silverfort ad teardown</a></li><li><a href="/teardowns/semgrep">Semgrep ad teardown</a></li><li><a href="/teardowns/descope">Descope ad teardown</a></li><li><a href="/teardowns/cycode">Cycode ad teardown</a></li></ul>'
      + '<p><a href="/teardowns">See every ad teardown</a>.</p>'
      + '<p>Across 50+ B2B teams we have repositioned paid campaigns to earn up to 3x more demos from the same ad spend.</p>'
      + '<p><a href="https://calendly.com/marina-kogan-adroast/30min">Book a 30-minute call</a> to see if it is a fit, or <a href="/">roast one ad free</a> first.</p>'
      + '<p>Learn the method: the AdRoast <a href="/guides">guides</a> cover how to <a href="/guides/audit-linkedin-ads-icp">audit your ads against your ICP</a> and why <a href="/guides/clicks-no-pipeline">clicks do not turn into pipeline</a>.</p>'
      + '</main>';
    // Same progressive-enhancement trick as the board page: hide the crawler text behind a loader
    // for JS users (html.has-js) so a human never sees the raw services copy flash before the SPA
    // boots; no-JS crawlers never set the class and still read the full visible text.
    const GEO_HEAD = '<style>@keyframes geospin{to{transform:rotate(360deg)}}.geo-loading{display:none}'
      + 'html.has-js .geo-shell{display:none!important}html.has-js .geo-loading{display:flex!important}</style>'
      + '<script>document.documentElement.classList.add("has-js")</script>';
    const GEO_LOADING = '<div class="geo-loading" style="min-height:70vh;align-items:center;justify-content:center">'
      + '<div style="width:34px;height:34px;border:3px solid #e7ecf3;border-top-color:#0a66c2;border-radius:50%;animation:geospin .8s linear infinite"></div></div>';
    if (html) html = html.replace('<div id="root"></div>', '<div id="root">' + GEO_LOADING + '<div class="geo-shell">' + content + '</div></div>');

    const ld = {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'Campaign Repositioning for B2B SaaS paid media',
      serviceType: 'Ad campaign positioning and messaging',
      description: desc,
      url: url,
      areaServed: 'Global',
      provider: { '@type': 'Organization', name: 'AdRoast', url: 'https://www.adroast.in' },
      offers: [
        { '@type': 'Offer', name: 'Campaign Repositioning Sprint', description: 'One-time 10-day repositioning of the ad-to-page journey.' },
        { '@type': 'Offer', name: 'Done-For-You Rebuild', description: '3-month build, launch and optimization.' }
      ]
    };
    const ldScript = '<script type="application/ld+json">' + JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>';
    if (html) html = html.replace('</head>', GEO_HEAD + ldScript + '</head>');

    // Misma razon que en el board para no cachear la liviana: el CDN guarda por URL y no por
    // User-Agent, y una pagina chica cacheada le dejaria /services sin la pagina real a una persona.
    if (bot) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(lightCrawlerPage({ docTitle, desc, title: ogTitle, boardUrl: url, shareUrl: url,
        imgUrl: 'https://www.adroast.in/og-hero.png?v=1', imgW: 2400, imgH: 1260, ld, content, noindex: false }));
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).send(html);
  } catch (e) {
    // Igual que en el board: si es un crawler no hay cascara cargada, y un 302 al home desde
    // /services le diria que la pagina no existe.
    try { if (!html) html = await getShell(); } catch (e2) {}
    if (html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); }
    else { res.setHeader('Location', '/'); res.status(302).end(); }
  }
}
