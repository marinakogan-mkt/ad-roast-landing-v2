#!/usr/bin/env python3
"""Generator for the REDESIGNED AdRoast teardown pages (two-window ad->landing,
expandable findings, animated 5-axis scorecard, FAQ + JSON-LD). Rebuilds the
gen_teardowns.py that was lost with an old session scratchpad, matching the exact
markup of teardowns/clickup/index.html. Self-contained: downloads the ad creative
and a thum.io landing screenshot and base64-inlines them, so the page ships with
no external image deps. No em/en dashes anywhere (project rule)."""
import base64, io, json, math, sys, urllib.request, time

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

def fetch(url, tries=4, min_bytes=1500):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*,*/*"})
            data = urllib.request.urlopen(req, timeout=45).read()
            if len(data) >= min_bytes:
                return data
            last = "too small (%d bytes)" % len(data)
        except Exception as e:
            last = str(e)
        time.sleep(3)
    raise RuntimeError("fetch failed for %s: %s" % (url, last))

def datauri(url, mime=None, min_bytes=1500):
    data = fetch(url, min_bytes=min_bytes)
    if mime is None:
        if data[:3] == b"\xff\xd8\xff": mime = "image/jpeg"
        elif data[:8] == b"\x89PNG\r\n\x1a\n": mime = "image/png"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP": mime = "image/webp"
        else: mime = "image/jpeg"
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode()), len(data)

def img_datauri(url, max_w=1000, quality=82, min_bytes=1500):
    """Fetch a screenshot and re-encode it as a right-sized JPEG, so a heavy
    thum.io PNG (2 MB+) inlines at ~200 KB instead of bloating the page."""
    from PIL import Image
    data = fetch(url, min_bytes=min_bytes)
    im = Image.open(io.BytesIO(data))
    if im.mode != "RGB":
        im = im.convert("RGB")
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=True)
    b = buf.getvalue()
    return "data:image/jpeg;base64,%s" % base64.b64encode(b).decode(), len(b)

def esc(t):
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))

def typo(t):
    # straight apostrophe -> right single quote, to match the template's &rsquo;.
    # Double curly quotes are written directly in the data (“ ”). Plain hyphens only.
    return t.replace("'", "’")

def color(score):
    return "#16a34a" if score >= 7 else ("#d97706" if score >= 5 else "#dc2626")

CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#12805c" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>'
TRI = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/></svg>'
FCHEV = '<svg class="fchev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>'
SCCHEV = '<svg class="scchev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>'

CSS = open(sys.argv[1] if len(sys.argv) > 1 else "/Users/marin/Downloads/ad-roast-live/teardowns/clickup/index.html", encoding="utf-8").read()
import re
CSS = re.search(r"<style>\n(.*?)\n</style>", CSS, re.S).group(1)

def ring(score):
    C = 2 * math.pi * 22
    arc = C * score / 10.0
    return (f'<svg width="52" height="52" viewBox="0 0 52 52"><circle cx="26" cy="26" r="22" fill="none" stroke="#eef0f3" stroke-width="6"/>'
            f'<circle class="ring-arc" cx="26" cy="26" r="22" fill="none" stroke="{color(score)}" stroke-width="6" stroke-linecap="round" '
            f'stroke-dasharray="{arc:.1f} {C:.1f}" stroke-dashoffset="{arc:.1f}" transform="rotate(-90 26 26)"/>'
            f'<text x="26" y="24" text-anchor="middle" font-size="16" font-weight="700" fill="#0a2540">{score}</text>'
            f'<text x="26" y="36" text-anchor="middle" font-size="9" fill="#94a3b8">/10</text></svg>')

def finding(f):
    icon = CHECK if f["good"] else TRI
    c = color(f["score"])
    fix = f.get("fix", "")
    fixblock = (f'<div class="lbl2" style="color:#0f6e56">The fix</div><p>{typo(fix)}</p>') if fix else ""
    return (f'<div class="finding"><button class="fh"><span class="tag tag-{f["tag"]}">{"Ad" if f["tag"]=="ad" else "Page"}</span>'
            f'{icon}<span class="ftitle">{typo(f["title"])}</span>'
            f'<span class="fscore" style="background:{c}1a;color:{c}">{f["score"]}/10</span>{FCHEV}</button>'
            f'<div class="fd"><div class="lbl2">What{chr(0x2019)}s happening</div><p>{typo(f["what"])}</p>'
            f'{fixblock}</div></div>')

def scitem(s):
    c = color(s["score"])
    return (f'<div class="scitem"><button class="scrow"><span class="sl">{s["label"]}</span>'
            f'<div class="track"><div class="fill" data-w="{s["score"]*10}" style="background:{c}"></div></div>'
            f'<span class="sv" style="color:{c}">{s["score"]}</span>{SCCHEV}</button>'
            f'<div class="scd">{typo(s["note"])}</div></div>')

def qa(q):
    return (f'<div class="qa"><button>{typo(q["q"])}<span>+</span></button>'
            f'<div class="a">{typo(q["a"])}</div></div>')

def build(d):
    ad_uri, ad_n = datauri(d["ad_img"])
    lp_uri, lp_n = datauri(d["lp_shot"])
    logo_uri, logo_n = datauri(d["logo_url"], min_bytes=300)
    sys.stderr.write("  ad creative %d KB, landing %d KB, logo %d KB\n" % (ad_n // 1024, lp_n // 1024, logo_n // 1024))
    ld_article = {"@context": "https://schema.org", "@type": "AnalysisNewsArticle",
        "headline": d["title"], "description": d["meta_desc"], "datePublished": d["date"],
        "author": {"@type": "Person", "name": "Marina Kogan", "url": "https://koganmarina.com"},
        "publisher": {"@type": "Organization", "name": "AdRoast", "url": "https://www.adroast.in"},
        "about": {"@type": "Organization", "name": d["name"], "url": "https://" + d["domain"]},
        "keywords": d["keywords"]}
    ld_faq = {"@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q["q"],
            "acceptedAnswer": {"@type": "Answer", "text": q["a"]}} for q in d["faq"]]}
    findings = "".join(finding(f) for f in d["findings"])
    scorecard = "".join(scitem(s) for s in d["scorecard"])
    faqs = "".join(qa(q) for q in d["faq"])
    related = "".join(
        f'<a class="rcard" href="/teardowns/{r["slug"]}"><div class="rco">{r["name"]}</div>'
        f'<div class="rq">{typo(r["q"])}</div><div class="rgo">Read the teardown &rarr;</div></a>'
        for r in d["related"])
    h1 = "<br>".join(typo(l) for l in d["hook"])
    html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(d["title"])} | AdRoast</title>
<meta name="description" content="{esc(d["meta_desc"])}">
<link rel="canonical" href="https://www.adroast.in/teardowns/{d["slug"]}">
<meta property="og:title" content="{esc(d["name"])} LinkedIn ads teardown | AdRoast">
<meta property="og:description" content="{esc(d["og_desc"])}">
<script type="application/ld+json">{json.dumps(ld_article, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(ld_faq, ensure_ascii=False)}</script>
<style>
{CSS}
</style></head>
<body>
<header class="bar"><div class="bar-in"><a class="brand" href="/teardowns"><img class="lg" src="/apple-touch-icon.png" alt="AdRoast" width="22" height="22"><b>AdRoast</b><span class="sl">/ Teardowns</span></a><a class="btn" href="/?library=1">Roast your ads free</a></div></header>
<main>
  <div class="eyebrow">Ad teardown &middot; B2B SaaS</div>
  <h1>{h1}</h1>
  <p class="lede">{typo(d["lede"])}</p>
  <div class="meta">
    <div class="co"><div class="co-badge"><img src="{logo_uri}" alt="{esc(d["name"])}"></div><div><div class="co-name">{d["name"]}</div><div class="co-dom">{d["domain"]} &middot; LinkedIn</div></div></div>
    <div class="score">{ring(d["score"])}<span class="cap">Ad-to-page<br>score</span></div>
  </div>

  <div class="sec">
    <p class="stitle">The ad and the page it lands on</p>
    <div class="twostage">
      <a class="win ad" href="{d.get("ad_detail_url") or ("https://www.adroast.in/?id=" + d["roast_id"])}" target="_blank" rel="noopener" title="See the ad"><div class="wl">The ad</div><div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>LinkedIn &middot; sponsored</span></div><div class="shot"><img src="{ad_uri}" alt="{esc(d["name"])} LinkedIn ad"></div></a>
      <div class="arr">&rarr;</div>
      <a class="win lp" href="{d.get("lp_url") or ("https://%s/" % d["domain"])}" target="_blank" rel="noopener" title="Open {d["domain"]}"><div class="wl">The landing page</div><div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>{d["domain"]}/</span></div><div class="shot"><img src="{lp_uri}" alt="{esc(d["name"])} landing page screenshot"></div></a>
    </div>
  </div>

  <div class="sec">
    <p class="stitle">What the roast found &middot; tap to open each one</p>
    <div class="findings">{findings}</div>
  </div>

  <div class="sec">
    <p class="stitle">Why it scores {d["score"]}/10 &middot; tap a row</p>
    <div class="scorecard">{scorecard}</div>
  </div>

  <div class="sec">
    <p class="stitle">Questions, answered</p>
    <div class="faq">{faqs}</div>
    <p style="margin-top:16px;font-size:14px;color:#64748b">This teardown is based on a real AdRoast roast of {d["name"]}{chr(0x2019)}s live ad. <a href="https://www.adroast.in/?id={d["roast_id"]}" target="_blank" rel="noopener">See the full roast &rarr;</a></p>
  </div>

  <div class="sec">
    <p class="stitle">More teardowns</p>
    <div class="related">{related}</div>
  </div>

  <div class="band"><div><h2>Your ads, roasted the same way</h2><p>Pull your live ads, score each against your buyer, see where the click leaks.</p></div><a class="btn-white" href="/?library=1">Roast your ads free &rarr;</a></div>
</main>
<script>
(function(){{
  [].slice.call(document.querySelectorAll('.finding .fh')).forEach(function(b){{b.addEventListener('click',function(){{b.parentElement.classList.toggle('open');}});}});
  [].slice.call(document.querySelectorAll('.scrow')).forEach(function(b){{b.addEventListener('click',function(){{b.parentElement.classList.toggle('open');}});}});
  [].slice.call(document.querySelectorAll('.qa button')).forEach(function(b){{b.addEventListener('click',function(){{var qa=b.parentElement;qa.classList.toggle('open');b.querySelector('span').textContent=qa.classList.contains('open')?'–':'+';}});}});
  function bars(){{[].slice.call(document.querySelectorAll('.scrow .fill')).forEach(function(f){{f.style.width=f.dataset.w+'%';}});}}
  function ring(){{var a=document.querySelector('.ring-arc');if(a)a.style.strokeDashoffset='0';}}
  setTimeout(ring,220);
  if('IntersectionObserver' in window){{var sc=document.querySelector('.scorecard');if(sc){{var io=new IntersectionObserver(function(es){{es.forEach(function(e){{if(e.isIntersecting){{bars();io.disconnect();}}}});}});io.observe(sc);}}else{{bars();}}}}else{{bars();}}
}})();
</script>
</body></html>'''
    return html

# ---------------------------------------------------------------------------
# v2: build straight from a roast_ad output + a small voice layer, and
# integrate the page into the hub, sitemap and /work-with-us proof.
# Input JSON (v2): {"meta": {...}, "voice": {...}, "roast": <roast_ad output>}.
# Legacy flat JSON (no "roast" key) still works as before.
# ---------------------------------------------------------------------------
def logo_for(domain):
    return "https://icons.duckduckgo.com/ip3/%s.ico" % domain

def lp_for(url):
    # Use AdRoast's own screenshot endpoint (ScreenshotOne, blocks until rendered)
    # instead of thum.io directly, which sometimes returns a cold-render spinner.
    import urllib.parse
    return "https://www.adroast.in/api/icp?shot=" + urllib.parse.quote(url, safe="")

def from_roast(cfg):
    """Turn {meta, voice, roast} into the flat dict build() expects. The 5-axis
    scorecard comes straight from the roast (authentic, no retyping); the voice
    layer carries only what needs judgment: hook, lede, findings, fixes, faq."""
    meta, voice, roast = cfg["meta"], cfg.get("voice", {}), cfg.get("roast", {})
    d = dict(meta)
    d["score"] = roast.get("overall_score", meta.get("score"))
    rid = meta.get("roast_id", "")
    if not rid and meta.get("roast_link"):
        m = re.search(r"id=([A-Za-z0-9]+)", meta["roast_link"])
        rid = m.group(1) if m else ""
    d["roast_id"] = rid
    d.setdefault("logo_url", logo_for(meta["domain"]))
    d.setdefault("lp_shot", lp_for(meta.get("lp_url", "https://%s/" % meta["domain"])))
    d["hook"], d["lede"], d["faq"] = voice["hook"], voice["lede"], voice["faq"]
    # scorecard: straight from the roast issues, unless voice overrides/reorders
    if voice.get("scorecard"):
        d["scorecard"] = voice["scorecard"]
    else:
        d["scorecard"] = [{"label": i["title"], "score": i["score"], "note": i["explanation"]}
                           for i in roast.get("issues", [])]
    # findings: voice-authored (punchy) if given, else auto from the issues
    if voice.get("findings"):
        d["findings"] = voice["findings"]
    else:
        fs = []
        for i in roast.get("issues", []):
            blob = (i["title"] + " " + i.get("explanation", "")).lower()
            tag = "page" if re.search(r"landing|the page|homepage|lands on", blob) else "ad"
            fs.append({"tag": tag, "good": i["score"] >= 6, "title": i["title"],
                       "what": i.get("explanation", ""), "fix": ""})
        d["findings"] = fs
    return d

def integrate(d, repo="."):
    """Add the page to teardowns/index.html (card + JSON-LD), sitemap.xml and the
    /work-with-us proof list in api/_board-og.js. Idempotent: skips a file that
    already references the slug."""
    import os
    slug, name, dom = d["slug"], d["name"], d["domain"]
    score, date = d["score"], d.get("human_date", d["date"])
    initial = d.get("initial", name[0])
    badge = d.get("badge_color", "#0a66c2")
    sev = "sev-red" if score <= 4 else "sev-amber"
    hook = " ".join(typo(l) for l in d["hook"])
    desc = d.get("card_desc") or typo(d["lede"])[:180]
    done = []
    # 1) hub card (prepended as newest) + JSON-LD ItemList (renumbered)
    hub = os.path.join(repo, "teardowns/index.html")
    h = open(hub, encoding="utf-8").read()
    if ("/teardowns/%s" % slug) not in h:
        card = (f'<a class="tcard" href="/teardowns/{slug}"><div class="tcard-top">'
                f'<div class="tcard-badge" style="background:{badge}"><img src="/api/icp?logo={dom}" alt="" loading="lazy" onerror="this.remove()">{initial}</div>'
                f'<div><div class="tcard-co">{name}</div><div class="tcard-date">{date}</div></div>'
                f'<span class="mini {sev}">{score}/10</span></div>'
                f'<h3>{hook}</h3><p>{desc}</p>'
                f'<div class="foot">Read the teardown<span class="go">&rarr;</span></div></a>')
        h = h.replace('<div class="grid">', '<div class="grid">' + card, 1)
        li = (f'{{"@type": "ListItem", "position": 0, '
              f'"url": "https://www.adroast.in/teardowns/{slug}", "name": "{name} ad teardown"}}, ')
        h = h.replace('"itemListElement": [', '"itemListElement": [' + li, 1)
        mi = h.find('"itemListElement": ['); me = h.find("]", mi)
        c = [0]
        def rn(m):
            c[0] += 1; return '"position": %d' % c[0]
        h = h[:mi] + re.sub(r'"position": \d+', rn, h[mi:me]) + h[me:]
        open(hub, "w", encoding="utf-8").write(h); done.append("hub")
    # 2) sitemap
    sm = os.path.join(repo, "sitemap.xml")
    s = open(sm, encoding="utf-8").read()
    if ("/teardowns/%s<" % slug) not in s:
        block = ("  <url>\n    <loc>https://www.adroast.in/teardowns/%s</loc>\n"
                 "    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n" % slug)
        anchor = "  <url>\n    <loc>https://www.adroast.in/teardowns/monday</loc>"
        if anchor not in s:
            anchor = "  <url>\n    <loc>https://www.adroast.in/teardowns/cycode</loc>"
        s = s.replace(anchor, block + anchor, 1)
        open(sm, "w", encoding="utf-8").write(s); done.append("sitemap")
    # 3) /work-with-us proof list
    og = os.path.join(repo, "api/_board-og.js")
    o = open(og, encoding="utf-8").read()
    if ("/teardowns/%s" % slug) not in o:
        li = f'<ul><li><a href="/teardowns/{slug}">{name} ad teardown</a></li>'
        o = o.replace("<ul><li><a href=\"/teardowns/", li + '<li><a href="/teardowns/', 1)
        open(og, "w", encoding="utf-8").write(o); done.append("proof")
    return done

# ---------------------------------------------------------------------------
# Embed mode (approach B): restyle an older embed-centric teardown into the new
# look WITHOUT a fresh roast. The "ad" window is the real LinkedIn teardown post
# (iframe, clickable), beside a live screenshot of the landing page. No 5-axis
# scorecard (there is no roast); a verdict word shows as a chip instead of a ring.
# Input JSON: {"embed": true, "meta": {...}, "voice": {...}}.

EMBED_CSS = (
    ".twostage.embedstage{align-items:start}"
    ".win.embedwin{overflow:visible}"
    ".win.embedwin .liwrap{padding:12px;background:#f7f8fa;flex:1}"
    ".win.embedwin iframe.liembed{width:100%;height:560px;border:0;border-radius:10px;display:block;background:#fff}"
    ".win.embedwin .liopen{display:block;text-align:center;padding:11px 12px;font-size:13px;font-weight:700;color:var(--blue);border-top:1px solid var(--line);text-decoration:none}"
    ".win.embedwin .liopen:hover{background:#eef4ff}"
    ".vchip{display:inline-flex;align-items:center;font-weight:800;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;padding:8px 14px;border-radius:999px;white-space:nowrap}"
    ".embedstage.embed-only{max-width:600px;margin:0 auto;display:block}"
    "@media(max-width:720px){.win.embedwin iframe.liembed{height:470px}}"
)

def vchip(verdict):
    red = any(w in verdict.lower() for w in ["wrong", "broken", "dead", "fail", "mismatch"])
    c = "#dc2626" if red else "#d97706"
    return f'<span class="vchip" style="background:{c}1a;color:{c}">{esc(verdict)}</span>'

def finding_embed(f):
    icon = CHECK if f["good"] else TRI
    fix = f.get("fix", "")
    fixblock = (f'<div class="lbl2" style="color:#0f6e56">The fix</div><p>{typo(fix)}</p>') if fix else ""
    return (f'<div class="finding"><button class="fh"><span class="tag tag-{f["tag"]}">{"Ad" if f["tag"]=="ad" else "Page"}</span>'
            f'{icon}<span class="ftitle">{typo(f["title"])}</span>{FCHEV}</button>'
            f'<div class="fd"><div class="lbl2">What{chr(0x2019)}s happening</div><p>{typo(f["what"])}</p>'
            f'{fixblock}</div></div>')

def build_embed(d):
    has_lp = bool(d.get("lp_shot"))
    lp_uri, lp_n = (img_datauri(d["lp_shot"]) if has_lp else ("", 0))
    logo_uri, logo_n = datauri(d["logo_url"], min_bytes=300)
    sys.stderr.write("  landing %d KB, logo %d KB (embed mode%s)\n" % (lp_n // 1024, logo_n // 1024, "" if has_lp else ", embed-only"))
    ld_article = {"@context": "https://schema.org", "@type": "AnalysisNewsArticle",
        "headline": d["title"], "description": d["meta_desc"], "datePublished": d["date"],
        "author": {"@type": "Person", "name": "Marina Kogan", "url": "https://koganmarina.com"},
        "publisher": {"@type": "Organization", "name": "AdRoast", "url": "https://www.adroast.in"},
        "about": {"@type": "Organization", "name": d["name"], "url": "https://" + d["domain"]},
        "keywords": d["keywords"]}
    ld_faq = {"@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q["q"],
            "acceptedAnswer": {"@type": "Answer", "text": q["a"]}} for q in d["faq"]]}
    findings = "".join(finding_embed(f) for f in d["findings"])
    faqs = "".join(qa(q) for q in d["faq"])
    related = "".join(
        f'<a class="rcard" href="/teardowns/{r["slug"]}"><div class="rco">{r["name"]}</div>'
        f'<div class="rq">{typo(r["q"])}</div><div class="rgo">Read the teardown &rarr;</div></a>'
        for r in d["related"])
    h1 = "<br>".join(typo(l) for l in d["hook"])
    eyebrow = typo(d.get("eyebrow", "Ad teardown &middot; B2B SaaS"))
    has_score = isinstance(d.get("score"), int)
    score_block = (f'{ring(d["score"])}<span class="cap">Ad-to-page<br>score</span>' if has_score
                   else f'{vchip(d["verdict"])}<span class="cap">Verdict</span>')
    post_url = d.get("post_url") or ("https://www.linkedin.com/feed/update/" + d["urn"])
    embed_src = "https://www.linkedin.com/embed/feed/update/" + d["urn"]
    embed_win = (
        '<div class="win ad embedwin"><div class="wl">The ad, torn apart</div>'
        '<div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>LinkedIn post</span></div>'
        f'<div class="liwrap"><iframe class="liembed" src="{embed_src}" title="{esc(d["name"])} ad teardown on LinkedIn" frameborder="0" allowfullscreen loading="lazy"></iframe></div>'
        f'<a class="liopen" href="{post_url}" target="_blank" rel="noopener">Open on LinkedIn &rarr;</a></div>')
    if has_lp:
        landing_win = (
            f'<a class="win lp" href="{d.get("lp_url") or ("https://%s/" % d["domain"])}" target="_blank" rel="noopener" title="Open {d["domain"]}">'
            '<div class="wl">The landing page</div>'
            f'<div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>{d["domain"]}/</span></div>'
            f'<div class="shot"><img src="{lp_uri}" alt="{esc(d["name"])} landing page screenshot"></div></a>')
        stage_inner = embed_win + '<div class="arr">&rarr;</div>' + landing_win
        stitle, stage_cls = "The ad, and the page it lands on", "twostage embedstage"
    else:
        stage_inner, stitle, stage_cls = embed_win, "The teardown, on LinkedIn", "twostage embedstage embed-only"
    stage_sec = f'<div class="sec"><p class="stitle">{stitle}</p><div class="{stage_cls}">{stage_inner}</div></div>'
    html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(d["title"])} | AdRoast</title>
<meta name="description" content="{esc(d["meta_desc"])}">
<link rel="canonical" href="https://www.adroast.in/teardowns/{d["slug"]}">
<meta property="og:title" content="{esc(d["name"])} LinkedIn ads teardown | AdRoast">
<meta property="og:description" content="{esc(d["og_desc"])}">
<script type="application/ld+json">{json.dumps(ld_article, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(ld_faq, ensure_ascii=False)}</script>
<style>
{CSS}
{EMBED_CSS}
</style></head>
<body>
<header class="bar"><div class="bar-in"><a class="brand" href="/teardowns"><img class="lg" src="/apple-touch-icon.png" alt="AdRoast" width="22" height="22"><b>AdRoast</b><span class="sl">/ Teardowns</span></a><a class="btn" href="/?library=1">Roast your ads free</a></div></header>
<main>
  <div class="eyebrow">{eyebrow}</div>
  <h1>{h1}</h1>
  <p class="lede">{typo(d["lede"])}</p>
  <div class="meta">
    <div class="co"><div class="co-badge"><img src="{logo_uri}" alt="{esc(d["name"])}"></div><div><div class="co-name">{d["name"]}</div><div class="co-dom">{d["domain"]} &middot; LinkedIn</div></div></div>
    <div class="score">{score_block}</div>
  </div>

  {stage_sec}

  <div class="sec">
    <p class="stitle">What the teardown found &middot; tap to open each one</p>
    <div class="findings">{findings}</div>
  </div>

  <div class="sec">
    <p class="stitle">Questions, answered</p>
    <div class="faq">{faqs}</div>
    <p style="margin-top:16px;font-size:14px;color:#64748b">This is Marina Kogan{chr(0x2019)}s original teardown of {d["name"]}{chr(0x2019)}s live ad. <a href="{post_url}" target="_blank" rel="noopener">See the full infographic on LinkedIn &rarr;</a></p>
  </div>

  <div class="sec">
    <p class="stitle">More teardowns</p>
    <div class="related">{related}</div>
  </div>

  <div class="band"><div><h2>Your ads, roasted the same way</h2><p>Pull your live ads, score each against your buyer, see where the click leaks.</p></div><a class="btn-white" href="/?library=1">Roast your ads free &rarr;</a></div>
</main>
<script>
(function(){{
  [].slice.call(document.querySelectorAll('.finding .fh')).forEach(function(b){{b.addEventListener('click',function(){{b.parentElement.classList.toggle('open');}});}});
  [].slice.call(document.querySelectorAll('.qa button')).forEach(function(b){{b.addEventListener('click',function(){{var qa=b.parentElement;qa.classList.toggle('open');b.querySelector('span').textContent=qa.classList.contains('open')?'–':'+';}});}});
  function ring(){{var a=document.querySelector('.ring-arc');if(a)a.style.strokeDashoffset='0';}}
  setTimeout(ring,220);
}})();
</script>
</body></html>'''
    return html

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("template"); ap.add_argument("input"); ap.add_argument("out")
    ap.add_argument("--integrate", action="store_true")
    ap.add_argument("--repo", default=".")
    a = ap.parse_args()
    cfg = json.load(open(a.input))
    if cfg.get("embed"):
        d = dict(cfg["meta"]); v = cfg.get("voice", {})
        d["hook"], d["lede"], d["findings"], d["faq"] = v["hook"], v["lede"], v["findings"], v["faq"]
        d.setdefault("logo_url", logo_for(d["domain"]))
        if d.get("lp_url"):
            d.setdefault("lp_shot", lp_for(d["lp_url"]))
        html = build_embed(d)
        d = {}  # embed pages are already in the hub/sitemap/proof; never integrate
    else:
        d = from_roast(cfg) if "roast" in cfg or "meta" in cfg else cfg
        html = build(d)
    import os
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    open(a.out, "w", encoding="utf-8").write(html)
    sys.stderr.write("wrote %s (%d KB)\n" % (a.out, len(html.encode()) // 1024))
    if a.integrate and d:
        done = integrate(d, a.repo)
        sys.stderr.write("integrated into: %s\n" % (", ".join(done) if done else "(already present everywhere)"))
