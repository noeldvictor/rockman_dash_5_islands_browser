---
name: rendered-docs
description: Fetch documentation or other web pages that only render with JavaScript (WebFetch returns just a title or an empty page) as plain text, using Playwright Chromium from the repo's Python venv. Set up for the Tripo API docs at developers.tripo3d.ai; works for any site.
---

# Rendered docs

Some documentation sites are single-page apps: a plain HTTP fetch gets an empty shell. This skill
opens the page in headless Chromium, waits for it to render, and saves the visible text.

## Set up (once per machine)

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/python -m playwright install chromium
```

`.venv/` is git-ignored. Use Playwright's own Chromium (the default of `pw.chromium.launch()`),
not a system browser.

## Use

```bash
# one or more pages; prints where each was written
.venv/bin/python .claude/skills/rendered-docs/fetch.py <url> [<url> ...]

# list the same-site links of a page (to find the docs' sections)
.venv/bin/python .claude/skills/rendered-docs/fetch.py <url> --links

# follow same-site links from a start page, up to N pages
.venv/bin/python .claude/skills/rendered-docs/fetch.py <start url> --crawl 80
```

Pages land in `build/docs/<host>/<path>.txt` (`build/` is git-ignored; `--out DIR` changes it).
Then read or `grep` those files instead of fetching again. Options: `--wait MS` for pages that
fill in late, `--selector CSS` to keep only the article element.

The text is what a reader sees, navigation included: tabs and tables come out flattened, so
check a value against its neighbours before relying on it, and re-fetch a single page with
`--selector` if the menu drowns the content.

## Tripo API docs

```bash
.venv/bin/python .claude/skills/rendered-docs/fetch.py https://developers.tripo3d.ai/en/docs --crawl 80
```

About 50 pages. The ones that matter here:

| File in `build/docs/developers.tripo3d.ai/` | What |
|---|---|
| `en_pricing.txt` | credits per task (1 credit = $0.01) |
| `en_docs_quick-start.txt`, `en_docs_authentication.txt`, `en_docs_task-lifecycle.txt`, `en_docs_task-query.txt` | base URL, key header, submitting and polling tasks |
| `en_docs_files.txt`, `en_docs_files-presign.txt` | uploading input files |
| `en_docs_generation-image-to-image.txt`, `en_docs_generation-text-to-image.txt` | image generation and editing (models `seedream_v5`, `banana*`, `chat_image_*`) |
| `en_docs_generation-image-to-model*.txt`, `en_docs_generation-multiview-to-model*.txt`, `en_docs_generation-image-to-multiview.txt` | picture(s) to 3D model |
| `en_docs_models-texture.txt`, `en_docs_mesh-decimate.txt`, `en_docs_models-convert.txt`, `en_docs_mesh-segment.txt` | texturing, retopology / low poly, format conversion, splitting into parts |
| `en_docs_animations-rig-check.txt`, `en_docs_animations-rig.txt`, `en_docs_animations-retarget.txt` | rigging and animation |

The API key is not in the repository: it is read from `build/ai/tripo.key` (git-ignored) or
`$TRIPO_API_KEY`. Never write it into a tracked file or a commit message.
