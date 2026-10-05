#!/usr/bin/env python3
"""Fetch documentation pages that only exist after JavaScript has run, as plain text.

    .venv/bin/python .claude/skills/rendered-docs/fetch.py <url> [<url> ...]
        [--out DIR]        where to write the pages (default build/docs/<host>/)
        [--links]          also print the same-site links found on each page
        [--crawl N]        follow same-site links from the first URL, up to N pages
        [--wait MS]        extra time after load for late content (default 1500)
        [--selector CSS]   take the text of this element instead of the whole body

Each page is written as <out>/<path>.txt (the visible text, as a reader would see it) and its
path is printed. Uses Playwright's own Chromium, headless.
"""
import argparse
import os
import re
import sys
from urllib.parse import urldefrag, urljoin, urlparse

from playwright.sync_api import sync_playwright


def slug(url):
    p = urlparse(url)
    name = (p.path.strip('/') or 'index') + ('_' + p.query if p.query else '')
    return re.sub(r'[^A-Za-z0-9._-]+', '_', name)[:150]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('urls', nargs='+')
    ap.add_argument('--out')
    ap.add_argument('--links', action='store_true')
    ap.add_argument('--crawl', type=int, default=0)
    ap.add_argument('--wait', type=int, default=1500)
    ap.add_argument('--selector', default='body')
    args = ap.parse_args()
    host = urlparse(args.urls[0]).netloc
    out = args.out or os.path.join('build', 'docs', host)
    os.makedirs(out, exist_ok=True)
    queue = list(args.urls)
    seen = set()
    limit = max(len(queue), args.crawl)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={'width': 1400, 'height': 2000})
        while queue and len(seen) < limit:
            url = urldefrag(queue.pop(0))[0]
            if url in seen:
                continue
            seen.add(url)
            try:
                page.goto(url, wait_until='networkidle', timeout=45000)
            except Exception as e:  # a page that never goes idle still has its content
                print(f'  (load did not settle: {type(e).__name__})', file=sys.stderr)
            page.wait_for_timeout(args.wait)
            try:
                text = page.inner_text(args.selector)
            except Exception:
                text = page.inner_text('body')
            path = os.path.join(out, slug(page.url) + '.txt')
            with open(path, 'w') as f:
                f.write(f'# {page.title()}\n# {page.url}\n\n{text}\n')
            print(f'{path}  ({len(text)} chars)  {page.url}')
            hrefs = page.eval_on_selector_all('a[href]', 'els => els.map(e => e.href)')
            same = []
            for h in hrefs:
                h = urldefrag(urljoin(page.url, h))[0]
                if urlparse(h).netloc == host and h not in same:
                    same.append(h)
            if args.links:
                for h in same:
                    print('   ', h)
            if args.crawl:
                queue.extend(h for h in same if h not in seen)
        browser.close()


if __name__ == '__main__':
    main()
