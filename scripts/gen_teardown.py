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
    return (f'<div class="finding"><button class="fh"><span class="tag tag-{f["tag"]}">{"Ad" if f["tag"]=="ad" else "Page"}</span>'
            f'{icon}<span class="ftitle">{typo(f["title"])}</span>'
            f'<span class="fscore" style="background:{c}1a;color:{c}">{f["score"]}/10</span>{FCHEV}</button>'
            f'<div class="fd"><div class="lbl2">What{chr(0x2019)}s happening</div><p>{typo(f["what"])}</p>'
            f'<div class="lbl2" style="color:#0f6e56">The fix</div><p>{typo(f["fix"])}</p></div></div>')

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
<header class="bar"><div class="bar-in"><a class="brand" href="/teardowns"><span class="lg"></span><b>AdRoast</b><span class="sl">/ Teardowns</span></a><a class="btn" href="/?library=1">Roast your ads free</a></div></header>
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
      <div class="win ad"><div class="wl">The ad</div><div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>LinkedIn &middot; sponsored</span></div><div class="shot"><img src="{ad_uri}" alt="{esc(d["name"])} LinkedIn ad"></div></div>
      <div class="arr">&rarr;</div>
      <div class="win lp"><div class="wl">The landing page</div><div class="wh"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span>{d["domain"]}/</span></div><div class="shot"><img src="{lp_uri}" alt="{esc(d["name"])} landing page screenshot"></div></div>
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

if __name__ == "__main__":
    data = json.load(open(sys.argv[2]))
    html = build(data)
    out = sys.argv[3]
    open(out, "w", encoding="utf-8").write(html)
    sys.stderr.write("wrote %s (%d KB)\n" % (out, len(html.encode()) // 1024))
