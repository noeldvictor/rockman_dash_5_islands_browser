"""Minimal client for a ComfyUI server: upload an input file, run an API-format graph, fetch outputs.

The server address comes from the COMFY environment variable (default http://192.168.1.44:8188).
"""
import json
import mimetypes
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

COMFY = os.environ.get("COMFY", "http://192.168.1.44:8188").rstrip("/")


def upload(path, name=None) -> str:
    """Copy a local file into the server's input folder; returns the name to use in Load* nodes."""
    path = Path(path)
    name = name or path.name
    boundary = uuid.uuid4().hex
    kind = mimetypes.guess_type(name)[0] or "application/octet-stream"
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: {kind}\r\n\r\n'.encode(),
        path.read_bytes(),
        f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n'.encode(),
    ])
    req = urllib.request.Request(f"{COMFY}/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    reply = json.load(urllib.request.urlopen(req, timeout=120))
    return (reply.get("subfolder") + "/" if reply.get("subfolder") else "") + reply["name"]


def run(graph: dict, tag="job", timeout=1800) -> dict:
    """Queue a graph and wait for it. Returns {files: [(kind, subfolder, filename)], text: {node: str},
    seconds} or raises RuntimeError with the server's message."""
    req = urllib.request.Request(f"{COMFY}/prompt", data=json.dumps({"prompt": graph}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        prompt_id = json.load(urllib.request.urlopen(req, timeout=60))["prompt_id"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{tag}: rejected: {e.read()[:1200].decode('utf-8', 'ignore')}") from None
    start = time.time()
    while time.time() - start < timeout:
        entry = json.load(urllib.request.urlopen(f"{COMFY}/history/{prompt_id}", timeout=30)).get(prompt_id)
        if entry and entry["status"].get("completed") is not None:
            messages = [m for m in entry["status"].get("messages", []) if isinstance(m, list)]
            errors = [f"{m[1].get('node_type')}: {m[1].get('exception_message', '')[:500]}" for m in messages if m[0] == "execution_error"]
            if errors:
                raise RuntimeError(f"{tag}: {'; '.join(errors)}")
            files, text = [], {}
            for node, out in entry.get("outputs", {}).items():
                for kind in ("audio", "images"):
                    files += [(kind, i.get("subfolder", ""), i["filename"]) for i in out.get(kind, [])]
                if out.get("text"):
                    text[node] = " ".join(map(str, out["text"]))
            return {"files": files, "text": text, "seconds": round(time.time() - start, 1)}
        time.sleep(2)
    raise RuntimeError(f"{tag}: timed out after {timeout} s")


def download(item, dest) -> Path:
    """Save an output file ((kind, subfolder, filename) from run()) to `dest`."""
    _, subfolder, filename = item
    query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(urllib.request.urlopen(f"{COMFY}/view?{query}", timeout=300).read())
    return dest
