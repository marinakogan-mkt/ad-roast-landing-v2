#!/usr/bin/env python3
"""Keep the teardown pages' outgoing links clickable only while they still resolve.

A published teardown is a snapshot: the copy, the scores and the screenshots never change
after the fact. The one thing that rots is its links. Each teardowns/<slug>/index.html points
out at (a) the advertiser's landing page and (b) either the saved roast report on adroast.in
or the original ad post on LinkedIn. When one of those dies, the page should stop sending
people to a 404 WITHOUT losing a word of the teardown: the anchor becomes a <span> carrying
the same classes, the same inline style and the same text, so it reads identically and simply
is not clickable any more. The dead URL is kept in data-dead-link, so a later run can tell the
span apart from hand-written markup and can turn it back into a link if the URL comes back.

Being wrong in the "dead" direction is far more expensive than being wrong in the "alive"
direction: a link that 403s today still works for a human, while a wrongly unlinked post makes
eight cyber teardowns look broken at once. So a URL is only ever marked dead on an unequivocal
signal:

  dead       404 or 410 confirmed on a real GET, a host that does not resolve at all, or
             (for a saved roast) /api/roast-view answering 404 for that id
  alive      any 2xx or 3xx
  ambiguous  403, 999, 401, 429, 5xx, timeouts, TLS errors, login walls: left CLICKABLE

LinkedIn is the trap. It answers 403 or 999 to anything without a session, and its own post
URL answers 200 even for a post id that never existed, so neither a naive HEAD nor the post URL
can be believed. A post is therefore judged on the public logged-out embed endpoint, the same one
these pages iframe: it answers 200 for a live post and 404 for one that is gone, and if the embed
404s the page's own iframe is already broken anyway.

Jina Reader is used the way the rest of the repo uses it, to read a page Cloudflare will not serve
us, but only ever to tell a blocked-yet-live site from an unreachable one. It can NEVER mark a URL
dead: it renders a 404 page as happily as a real one (a missing cycode.com path comes back as 18KB
of rendered content), so a confirmed 404 is believed over any Jina render. The key comes from
JINA_API_KEY or ~/jina-token.txt and is never written into the code or the report.

Idempotent and non-interactive, so it can sit in a scheduled task:

    python3 scripts/check_teardown_links.py            # check and rewrite
    python3 scripts/check_teardown_links.py --dry-run   # report only, touch nothing
"""
import argparse
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ALIVE, DEAD, AMBIG = "alive", "dead", "ambiguous"

# Links that are part of the site itself, not outgoing: the canonical and the internal nav.
SELF_RE = re.compile(r"^https?://(?:www\.)?adroast\.in/teardowns(?:/|$)", re.I)
REPORT_RE = re.compile(r"^https?://(?:www\.)?adroast\.in/\?id=([A-Za-z0-9_-]+)", re.I)
LINKEDIN_POST_RE = re.compile(r"^https?://(?:www\.)?linkedin\.com/feed/update/(urn:li:[A-Za-z]+:\d+)", re.I)


def jina_key():
    k = (os.environ.get("JINA_API_KEY") or "").strip()
    if k:
        return k
    path = os.path.expanduser("~/jina-token.txt")
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def request(url, method="GET", timeout=25, headers=None):
    """Return (status, body_len) for a real request, or (None, reason) when it never answered."""
    h = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*",
         "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(4096) if method == "GET" else b""
            return r.status, len(body)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(4096)
        except Exception:
            body = b""
        return e.code, len(body)
    except urllib.error.URLError as e:
        return None, "url error: %s" % (e.reason,)
    except socket.timeout:
        return None, "timeout"
    except Exception as e:  # malformed redirect, bad TLS, reset mid-read
        return None, "%s: %s" % (type(e).__name__, e)


def confirm(url, method="GET", timeout=25, tries=2):
    """Re-ask before believing a 404: one transient error must never unlink a live page."""
    status, info = request(url, method=method, timeout=timeout)
    if status in (404, 410) and tries > 1:
        time.sleep(2)
        status2, info2 = request(url, method=method, timeout=timeout)
        if status2 not in (404, 410):
            return status2, info2
    return status, info


def host_resolves(host):
    """True / False / None, where None means the lookup itself was inconclusive.

    Only a repeated "name or service not known" counts as False: a one-off resolver hiccup
    must never unlink a live site.
    """
    verdict = None
    for attempt in range(2):
        try:
            socket.getaddrinfo(host, None)
            return True
        except socket.gaierror as e:
            if e.errno in (socket.EAI_NONAME, socket.EAI_NODATA):
                verdict = False
            else:
                return None
        except Exception:
            return None
        time.sleep(1.5 if attempt == 0 else 0)
    return verdict


def jina_reads(url, key):
    """Does Jina Reader render this page? Used only to RESCUE a blocked URL into 'alive'."""
    headers = {"X-Timeout": "20"}
    if key:
        headers["Authorization"] = "Bearer " + key
    for use_key in ([True, False] if key else [False]):
        h = dict(headers)
        if not use_key:
            h.pop("Authorization", None)
        req = urllib.request.Request("https://r.jina.ai/" + url, headers=h, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read(200000)
                if r.status == 200 and len(body) >= 400:
                    return True, len(body)
                return False, "jina %s, %d bytes" % (r.status, len(body))
        except urllib.error.HTTPError as e:
            if e.code in (401, 402, 403) and use_key:
                continue  # key exhausted or rejected: retry anonymously
            return False, "jina http %s" % e.code
        except Exception as e:
            return False, "jina %s" % type(e).__name__
    return False, "jina unavailable"


def check_report(url, key):
    """A saved roast lives behind /?id=<id>; the SPA shell answers 200 for any id, so ask the
    API the page itself reads."""
    m = REPORT_RE.match(url)
    if not m:
        return AMBIG, "not a recognizable report link"
    rid = m.group(1)
    api = "https://www.adroast.in/api/roast-view?id=" + urllib.parse.quote(rid)
    status, info = confirm(api)
    if status is None:
        return AMBIG, "roast-view unreachable (%s)" % info
    if status in (404, 410):
        return DEAD, "roast-view %d for id=%s (report no longer saved)" % (status, rid)
    if 200 <= status < 400:
        return ALIVE, "roast-view %d for id=%s" % (status, rid)
    return AMBIG, "roast-view %d" % status


def check_linkedin(url, key):
    """Judge a post on its public logged-out embed, the only LinkedIn endpoint that answers
    honestly without a session.

    Measured: the embed of a live post answers 200, the embed of an id that never existed answers
    404. The post URL itself answers 200 for both, so it is worthless here, and Jina renders
    LinkedIn's "post not found" shell as real content, so it cannot break the tie either. A 404 is
    only believed after a retry, and anything LinkedIn throws at anonymous readers (403, 999, 429)
    leaves the link alone.
    """
    m = LINKEDIN_POST_RE.match(url)
    if not m:
        return AMBIG, "not a recognizable LinkedIn post URL"
    embed = "https://www.linkedin.com/embed/feed/update/" + m.group(1)
    status, info = confirm(embed)
    if status is None:
        return AMBIG, "embed unreachable (%s)" % info
    if 200 <= status < 400:
        return ALIVE, "embed %d" % status
    if status in (404, 410):
        return DEAD, "public embed %d on retry (post deleted or made private)" % status
    return AMBIG, "embed %d (LinkedIn blocks anonymous reads)" % status


def check_page(url, key):
    """An advertiser landing page. 404/410 has to survive a GET; everything else blocked or
    flaky stays clickable."""
    host = urllib.parse.urlsplit(url).hostname or ""
    resolves = host_resolves(host)
    if resolves is False:
        return DEAD, "%s does not resolve (domain gone)" % host
    if resolves is None:
        return AMBIG, "DNS inconclusive for %s" % host

    status, info = request(url, method="HEAD", timeout=20)
    if status is not None and 200 <= status < 400:
        return ALIVE, "HEAD %d" % status
    # HEAD is widely mishandled, so never conclude anything from it alone.
    gstatus, ginfo = confirm(url, method="GET", timeout=25)
    if gstatus is not None and 200 <= gstatus < 400:
        return ALIVE, "GET %d" % gstatus
    if gstatus in (404, 410):
        # Deliberately no Jina rescue here: Jina happily renders a styled 404 page, so asking it
        # would turn every genuinely dead URL back into a live one.
        return DEAD, "GET %d on retry (page gone)" % gstatus
    # Blocked or flaky, never dead. Jina only says whether a reader can still see the page.
    ok, jinfo = jina_reads(url, key)
    shown = gstatus if gstatus is not None else ginfo
    if ok:
        return ALIVE, "blocked (%s) but Jina still reads it (%s bytes)" % (shown, jinfo)
    return AMBIG, "no clear answer (HEAD %s, GET %s, %s)" % (
        status if status is not None else info, shown, jinfo)


def classify(url, key):
    if REPORT_RE.match(url):
        return check_report(url, key)
    if LINKEDIN_POST_RE.match(url):
        return check_linkedin(url, key)
    return check_page(url, key)


ATTR_RE = re.compile(r'\s(href|target|rel|data-dead-link)\s*=\s*"([^"]*)"', re.I)


def attrs_of(tag):
    return {m.group(1).lower(): m.group(2) for m in ATTR_RE.finditer(tag)}


def strip_attrs(tag, names):
    out = tag
    for n in names:
        out = re.sub(r'\s%s\s*=\s*"[^"]*"' % re.escape(n), "", out, flags=re.I)
    return out


def match_close(html, open_end, open_name, close_name):
    """Index of the tag that closes the element opened just before open_end, nesting aware."""
    depth = 1
    pat = re.compile(r"<(/?)%s\b" % open_name, re.I)
    i = open_end
    while True:
        m = pat.search(html, i)
        if not m:
            return -1
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.start()
        i = m.end()


def outgoing_links(html):
    """Every outgoing link on the page, as (kind, url, start, end_of_open_tag, tag)."""
    found = []
    for m in re.finditer(r"<a\b[^>]*>", html, re.I):
        a = attrs_of(m.group(0))
        url = a.get("href", "")
        if not url.lower().startswith(("http://", "https://")) or SELF_RE.match(url):
            continue
        found.append(("a", url, m.start(), m.end(), m.group(0)))
    for m in re.finditer(r"<span\b[^>]*\bdata-dead-link\s*=\s*\"[^\"]*\"[^>]*>", html, re.I):
        url = attrs_of(m.group(0)).get("data-dead-link", "")
        if url:
            found.append(("span", url, m.start(), m.end(), m.group(0)))
    return found


def unlink(html, start, open_end, tag):
    """<a ...>text</a> -> <span ...>text</span>, same classes, same style, same text."""
    close = match_close(html, open_end, "a", "span")
    if close < 0:
        return html, False
    url = attrs_of(tag).get("href", "")
    body = strip_attrs(tag, ["href", "target", "rel"])
    body = re.sub(r"^<a\b", "<span", body, flags=re.I)
    body = re.sub(r"\s*>$", ' data-dead-link="%s">' % url.replace('"', "&quot;"), body)
    return html[:start] + body + html[open_end:close] + "</span>" + html[close + len("</a>"):], True


def relink(html, start, open_end, tag):
    """A link that came back to life: <span data-dead-link=...> -> a real <a>."""
    close = match_close(html, open_end, "span", "a")
    if close < 0:
        return html, False
    url = attrs_of(tag).get("data-dead-link", "")
    body = strip_attrs(tag, ["data-dead-link"])
    body = re.sub(r"^<span\b", "<a", body, flags=re.I)
    body = re.sub(r"\s*>$", ' href="%s" target="_blank" rel="noopener">' % url, body)
    return html[:start] + body + html[open_end:close] + "</a>" + html[close + len("</span>"):], True


def main():
    ap = argparse.ArgumentParser(description="Unlink dead outgoing links on the teardown pages.")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--root", default=REPO, help="repo root (default: the repo this script is in)")
    args = ap.parse_args()

    key = jina_key()
    pages = sorted(
        p for p in (os.path.join(args.root, "teardowns", d, "index.html")
                    for d in sorted(os.listdir(os.path.join(args.root, "teardowns"))))
        if os.path.isfile(p)
    )
    print("Teardown link check  %s" % time.strftime("%Y-%m-%d %H:%M:%S %Z"))
    print("%d pages, Jina key %s\n" % (len(pages), "loaded" if key else "NOT found (blocked sites stay ambiguous)"))

    cache = {}
    tally = {ALIVE: 0, DEAD: 0, AMBIG: 0}
    dead_urls, ambig_urls, changed = {}, {}, []

    for path in pages:
        slug = os.path.basename(os.path.dirname(path))
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        links = outgoing_links(html)
        urls = []
        for _, url, _, _, _ in links:
            if url not in urls:
                urls.append(url)
        print("%s" % slug)
        for url in urls:
            if url not in cache:
                cache[url] = classify(url, key)
            verdict, reason = cache[url]
            tally[verdict] += 1
            print("  %-9s %s\n            %s" % (verdict.upper(), url, reason))
            if verdict == DEAD:
                dead_urls.setdefault(url, []).append(slug)
            elif verdict == AMBIG:
                ambig_urls.setdefault(url, []).append(slug)

        # Rewrite back to front so earlier offsets stay valid.
        new = html
        edits = 0
        for kind, url, start, open_end, tag in sorted(links, key=lambda x: -x[2]):
            verdict = cache[url][0]
            if kind == "a" and verdict == DEAD:
                new, ok = unlink(new, start, open_end, tag)
                edits += 1 if ok else 0
            elif kind == "span" and verdict == ALIVE:
                new, ok = relink(new, start, open_end, tag)
                edits += 1 if ok else 0
        if edits and new != html:
            changed.append((slug, edits))
            if not args.dry_run:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(new)
            print("  -> %d link(s) rewritten%s" % (edits, " (dry run, not saved)" if args.dry_run else ""))
        print("")

    print("Summary: %d alive, %d dead, %d ambiguous (ambiguous stays clickable)"
          % (tally[ALIVE], tally[DEAD], tally[AMBIG]))
    if dead_urls:
        print("\nDead, unlinked:")
        for url, slugs in dead_urls.items():
            print("  %s  on %s" % (url, ", ".join(slugs)))
    if ambig_urls:
        print("\nAmbiguous, left clickable:")
        for url, slugs in ambig_urls.items():
            print("  %s  on %s  (%s)" % (url, ", ".join(slugs), cache[url][1]))
    if changed:
        print("\nPages %s: %s" % ("that would change" if args.dry_run else "rewritten",
                                  ", ".join("%s (%d)" % c for c in changed)))
    else:
        print("\nNo page needed a change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
