#!/usr/bin/python3
"""Monthly check of the Google and LinkedIn ad rules behind the roaster. No model in the loop.

Fetches the platforms' own spec and policy pages and compares them with what we hold:
- Character limits: read from fixed sentences on the page. A change that passes the guard
  rewrites api/_platform-rules.js, and with --push it is committed and deployed.
- Policy wording: never applied. Any change to a page goes to a review report as a raw diff,
  because the wording in the prompt was written by hand and a person has to decide.

Nothing changed: exits 0 and says nothing. Anything else: writes the report and notifies.

The launchd job runs this with --push from a dedicated clone (~/adroast-rules-clone), never
from ad-roast-live, which several sessions share. --push resets the clone to origin/main, so
it refuses to run without the .rules-refresh-clone marker file at the top of the clone.

    python3 scripts/refresh_platform_rules.py --dry-run
    python3 scripts/refresh_platform_rules.py --fixtures DIR --state-dir DIR --report-dir DIR
"""
import argparse
import datetime
import difflib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_FILE = os.path.join(ROOT, 'api', '_platform-rules.js')
RULES_RELATIVE = 'api/_platform-rules.js'
CLONE_MARKER = '.rules-refresh-clone'
HOME = os.path.expanduser('~')
DEFAULT_STATE = os.path.join(HOME, 'gtm-flywheel-main', 'data', 'platform-rules')
DEFAULT_REPORTS = os.path.join(HOME, 'gtm-flywheel-main', 'reports')
USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'

# Each fact is one number in one fixed sentence. If the sentence moves, the fact reads as
# unreadable and goes to the report: a rewritten page must never be guessed at.
PAGES = {
    'google-rsa': {
        'url': 'https://support.google.com/google-ads/answer/7684791?hl=en',
        'facts': {
            ('google', 'headline'): r'headline fields for responsive search ads support up to ([\d,]+) characters',
            ('google', 'description'): r'description fields support up to ([\d,]+) characters',
            ('google', 'display_path'): r'path fields support up to ([\d,]+) each',
        },
    },
    'google-editorial': {'url': 'https://support.google.com/adspolicy/answer/6021546?hl=en'},
    'google-trademarks': {'url': 'https://support.google.com/adspolicy/answer/6118?hl=en'},
    'linkedin-single-image': {
        'url': 'https://www.linkedin.com/help/lms/answer/a426534',
        'facts': {
            ('linkedin', 'intro_truncate'): r'Use up to ([\d,]+) characters including spaces, emojis, and punctuation to avoid truncation',
            ('linkedin', 'intro_max'): r'emojis, and punctuation to avoid truncation \(([\d,]+) character maximum\)',
            ('linkedin', 'emoji_max'): r'You can use up to ([\d,]+) emojis',
            ('linkedin', 'headline_truncate'): r'Use up to ([\d,]+) characters to avoid truncation \([\d,]+ character maximum\)',
            ('linkedin', 'headline_max'): r'Use up to [\d,]+ characters to avoid truncation \(([\d,]+) character maximum\)',
            ('linkedin', 'description_truncate'): r'Use ([\d,]+) characters to avoid truncation \([\d,]+ character maximum\)',
            ('linkedin', 'description_max'): r'Use [\d,]+ characters to avoid truncation \(([\d,]+) character maximum\)',
        },
    },
    'linkedin-ads-policy': {'url': 'https://www.linkedin.com/legal/ads-policy'},
}

# Guard: a bad scrape must not reach production. These platforms move limits rarely and
# one at a time, so anything else is more likely our parsing than their policy.
MAX_RATIO = 2.0
MAX_CHANGES = 3
MIN_TEXT_RATIO = 0.5
TRUNCATE_PAIRS = (('intro_truncate', 'intro_max'), ('headline_truncate', 'headline_max'), ('description_truncate', 'description_max'))


class PageText(HTMLParser):
    """Visible text, one block per line. Google pages carry a random id outside the article,
    so when the page has an <article> only that counts."""
    SKIP = ('script', 'style', 'noscript', 'svg', 'template')
    BLOCK = ('p', 'li', 'h1', 'h2', 'h3', 'h4', 'tr', 'td', 'th', 'div', 'section', 'br')

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.all, self.article = [], []
        self.skip = self.in_article = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag == 'article':
            self.in_article += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag == 'article':
            self.in_article = max(0, self.in_article - 1)
        if tag in self.BLOCK:
            self.all.append('\n')
            if self.in_article:
                self.article.append('\n')

    def handle_data(self, data):
        if self.skip:
            return
        self.all.append(data)
        if self.in_article:
            self.article.append(data)

    def text(self):
        chunks = self.article if ''.join(self.article).strip() else self.all
        lines = (re.sub(r'\s+', ' ', line).strip() for line in ''.join(chunks).splitlines())
        return '\n'.join(line for line in lines if line)


def page_text(html):
    parser = PageText()
    parser.feed(html)
    return parser.text()


def fetch(url):
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9'})
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.read().decode('utf-8', 'replace')
        except Exception as e:
            last = e
            time.sleep(5 * (attempt + 1))
    raise last


def read_rules():
    with open(RULES_FILE, encoding='utf-8') as f:
        source = f.read()
    m = re.search(r'/\*RULES-JSON-START\*/(.*)/\*RULES-JSON-END\*/', source, re.S)
    if not m:
        raise ValueError('no encontre los marcadores RULES-JSON en ' + RULES_RELATIVE)
    return source, m, json.loads(m.group(1))


def write_rules(source, match, rules):
    body = json.dumps(rules, indent=2, ensure_ascii=False)
    with open(RULES_FILE, 'w', encoding='utf-8') as f:
        f.write(source[:match.start(1)] + body + source[match.end(1):])
    if read_rules()[2] != rules:
        raise ValueError('la relectura de ' + RULES_RELATIVE + ' no coincide')


def read_fact(text, pattern):
    values = {int(v.replace(',', '')) for v in re.findall(pattern, text)}
    return values.pop() if len(values) == 1 else None


def judge(limits, found):
    """Returns (changes to apply, reasons to hold them). All or nothing."""
    changes = {k: (limits[k[0]][k[1]], v) for k, v in found.items() if limits[k[0]][k[1]] != v}
    held = []
    for (platform, key), (old, new) in changes.items():
        if new <= 0 or new > old * MAX_RATIO or new < old / MAX_RATIO:
            held.append('%s.%s pasaria de %s a %s, mas del doble o menos de la mitad' % (platform, key, old, new))
    if len(changes) > MAX_CHANGES:
        held.append('cambiarian %d limites a la vez (tope %d)' % (len(changes), MAX_CHANGES))
    merged = {p: dict(v) for p, v in limits.items()}
    for (platform, key), (_, new) in changes.items():
        merged[platform][key] = new
    for short, long in TRUNCATE_PAIRS:
        if merged['linkedin'][short] > merged['linkedin'][long]:
            held.append('linkedin.%s quedaria mayor que %s' % (short, long))
    return changes, held


def git(*args):
    return subprocess.run(['git', '-C', ROOT] + list(args), check=True, capture_output=True, text=True).stdout.strip()


def sync_clone():
    if not os.path.exists(os.path.join(ROOT, CLONE_MARKER)):
        raise SystemExit('--push solo corre en el clon dedicado (falta %s en %s)' % (CLONE_MARKER, ROOT))
    git('fetch', '-q', 'origin')
    git('checkout', '-q', 'main')
    git('reset', '-q', '--hard', 'origin/main')


def publish(changes):
    git('add', RULES_RELATIVE)
    detail = ', '.join('%s.%s %s to %s' % (k[0], k[1], v[0], v[1]) for k, v in changes.items())
    git('commit', '-q', '-m', 'rules: platform limits updated from the spec pages (%s)' % detail, '--', RULES_RELATIVE)
    git('push', '-q', 'origin', 'main')
    return git('rev-parse', '--short', 'HEAD')


def notify(message):
    script = 'display notification %s with title "AdRoast: reglas de plataformas"' % json.dumps(message)
    subprocess.run(['/usr/bin/osascript', '-e', script], capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='prints what it finds, writes nothing')
    ap.add_argument('--push', action='store_true', help='commit and push applied limits (dedicated clone only)')
    ap.add_argument('--fixtures', help='directory with <page>.html to read instead of fetching')
    ap.add_argument('--state-dir', default=DEFAULT_STATE)
    ap.add_argument('--report-dir', default=DEFAULT_REPORTS)
    args = ap.parse_args()

    today = datetime.date.today().isoformat()
    if args.push:
        sync_clone()
    source, match, rules = read_rules()
    limits = rules['limits']

    found, unreadable, diffs, snapshots = {}, [], [], {}
    for name, page in PAGES.items():
        try:
            if args.fixtures:
                with open(os.path.join(args.fixtures, name + '.html'), encoding='utf-8') as f:
                    html = f.read()
            else:
                html = fetch(page['url'])
            text = page_text(html)
        except Exception as e:
            unreadable.append('%s: no se pudo bajar (%s)' % (name, e))
            continue

        snap = os.path.join(args.state_dir, name + '.txt')
        old = open(snap, encoding='utf-8').read() if os.path.exists(snap) else None
        if old is not None and len(text) < len(old) * MIN_TEXT_RATIO:
            unreadable.append('%s: el texto bajo de %d a %d caracteres, parece una pagina rota' % (name, len(old), len(text)))
            continue

        for key, pattern in page.get('facts', {}).items():
            value = read_fact(text, pattern)
            if value is None:
                unreadable.append('%s: no encontre %s.%s (la frase cambio o aparece con dos valores)' % (name, key[0], key[1]))
            else:
                found[key] = value

        snapshots[snap] = text
        if old is not None and old != text:
            diff = difflib.unified_diff(old.splitlines(), text.splitlines(), lineterm='', n=1)
            diffs.append((name, page['url'], list(diff)[2:]))

    changes, held = judge(limits, found)
    if unreadable and changes:
        held.append('hubo paginas que no se pudieron leer, no aplico nada a medias')
    if args.dry_run:
        print(json.dumps({'leidos': {'.'.join(k): v for k, v in found.items()},
                          'cambios': {'.'.join(k): v for k, v in changes.items()},
                          'retenidos': held, 'sin_leer': unreadable,
                          'paginas_con_diff': [d[0] for d in diffs]}, indent=2, ensure_ascii=False))
        return 0

    applied = None
    if changes and not held:
        for (platform, key), (_, new) in changes.items():
            rules['limits'][platform][key] = new
        rules['version'] = today
        write_rules(source, match, rules)
        try:
            applied = publish(changes) if args.push else 'sin push'
        except subprocess.CalledProcessError as e:
            unreadable.append('los limites nuevos no se pudieron publicar: %s' % (e.stderr or e))

    if not (applied or changes or unreadable or diffs):
        os.makedirs(args.state_dir, exist_ok=True)
        for path, text in snapshots.items():
            if not os.path.exists(path):
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(text)
        return 0

    out = ['# Reglas de plataformas, chequeo del %s' % today, '']
    if applied:
        out += ['## Limites aplicados solos (%s)' % applied, '']
        out += ['- %s.%s: %s pasa a %s' % (k[0], k[1], v[0], v[1]) for k, v in changes.items()] + ['']
    if held:
        out += ['## Limites NO aplicados, hay que mirarlos', '']
        out += ['- %s: %s pasaria a %s' % ('.'.join(k), v[0], v[1]) for k, v in changes.items()]
        out += ['- Motivo: ' + reason for reason in held] + ['']
    if unreadable:
        out += ['## No se pudo leer', ''] + ['- ' + item for item in unreadable] + ['']
    if diffs:
        out += ['## Cambios de texto en las paginas (no se aplica nada)', '',
                'Si cambia una regla, va a mano en `prompt` de `api/_platform-rules.js`.', '']
        for name, url, lines in diffs:
            out += ['### %s' % name, url, '', '```diff'] + lines + ['```', '']
    os.makedirs(args.report_dir, exist_ok=True)
    report = os.path.join(args.report_dir, '%s-reglas-plataformas.md' % today)
    with open(report, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))

    # Only after the report exists: a diff must not vanish because the run died halfway.
    os.makedirs(args.state_dir, exist_ok=True)
    for path, text in snapshots.items():
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)

    bits = []
    if applied:
        bits.append('limites actualizados')
    if held:
        bits.append('limites retenidos')
    if unreadable:
        bits.append('paginas sin leer')
    if diffs:
        bits.append('texto cambiado')
    notify(', '.join(bits) + '. Ver ' + os.path.basename(report))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        notify('El chequeo fallo: %s' % e)
        raise
