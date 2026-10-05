#!/usr/bin/env python3
"""Small client for the Tripo API (https://developers.tripo3d.ai), v3.

The key is read from $TRIPO_API_KEY or build/ai/tripo.key (git-ignored); it is never written
anywhere by this code. Every call that costs credits is a task: submit, poll, download.

    .venv/bin/python tools/ai/tripo.py balance
    .venv/bin/python tools/ai/tripo.py task <task id>
"""
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = 'https://openapi.tripo3d.ai/v3'


def key():
    k = os.environ.get('TRIPO_API_KEY')
    if not k:
        path = os.path.join(ROOT, 'build', 'ai', 'tripo.key')
        if os.path.exists(path):
            k = open(path).read().strip()
    if not k:
        sys.exit('no Tripo API key: set TRIPO_API_KEY or put it in build/ai/tripo.key')
    return k


def _headers():
    return {'Authorization': f'Bearer {key()}'}


def _data(response):
    try:
        body = response.json()
    except ValueError:
        response.raise_for_status()
        raise
    if response.status_code >= 400 or body.get('code', 0) != 0:
        raise RuntimeError(f'Tripo {response.request.method} {response.url}: {response.status_code} {json.dumps(body)[:500]}')
    return body['data']


def balance():
    r = requests.get('https://api.tripo3d.ai/v2/openapi/user/balance', headers=_headers(), timeout=30)
    return _data(r)['balance']


def upload(path):
    """Upload a picture or model; returns the file_token to use as a task's input."""
    with open(path, 'rb') as f:
        r = requests.post(f'{BASE}/files', headers=_headers(), files={'file': (os.path.basename(path), f)}, timeout=300)
    return _data(r)['file_token']


def submit(endpoint, **params):
    """Start a task (endpoint like 'generation/image-to-model'); returns its id."""
    for attempt in range(12):
        r = requests.post(f'{BASE}/{endpoint}', headers=_headers(), json=params, timeout=60)
        if r.status_code != 429:
            break
        # only so many tasks at a time: wait for a running one to finish
        delay = int(r.headers.get('Retry-After') or 0) or 20
        print(f'  busy, trying again in {delay} s', flush=True)
        time.sleep(delay)
    return _data(r)['task_id']


def task(task_id):
    return _data(requests.get(f'{BASE}/tasks/{task_id}', headers=_headers(), timeout=30))


def wait(task_id, every=5, limit=1800, quiet=False):
    """Poll until the task ends; returns the task (raises if it failed)."""
    start = time.time()
    last = None
    while True:
        t = task(task_id)
        if not quiet and t.get('progress') != last:
            last = t.get('progress')
            print(f"  {task_id} {t['status']} {last}%", flush=True)
        if t['status'] == 'success':
            return t
        if t['status'] in ('failed', 'cancelled'):
            raise RuntimeError(f"task {task_id} {t['status']}: {t.get('error_code')} {t.get('error_message')}")
        if time.time() - start > limit:
            raise TimeoutError(f'task {task_id} still {t["status"]} after {limit} s')
        time.sleep(every)


def download(url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(path, 'wb') as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
    return path


if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == 'balance':
        print(balance(), 'credits')
    elif len(sys.argv) >= 3 and sys.argv[1] == 'task':
        print(json.dumps(task(sys.argv[2]), indent=1))
    else:
        sys.exit(__doc__)
