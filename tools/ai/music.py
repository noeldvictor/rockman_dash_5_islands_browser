#!/usr/bin/env python3
"""Have a music model perform the game's tunes from their score, on a ComfyUI server (comfy.py).

    python3 tools/ai/music.py bgmtitle [--style "..."] [--seed 1] [--variant localized]

The tune's notes are written as an ABC score (tools/ai/mfi_abc.mjs: the lead melody plus one chord
per bar, the loop written twice) and YuE 2 performs it. The style, unless given, names the
instruments the tune itself is written for and its tempo. The performance does
not keep exact time, so the length of one pass is measured from the audio; the loop is then cut so
that it starts at the top of the tune and wraps in the middle of the performance, where the sound
has settled.

Output: build/ai/music/<tune>.yue2.s<seed>.ogg, .abc (the score) and .json (settings, loop
length, and how closely the result follows the game's own rendering: the similarity of the notes
sounding on each beat, next to the same number for deliberately misaligned beats).
Needs the game's sound files unpacked (python3 tools/extract_assets.py), node, ffmpeg and numpy.
Everything written is derived from the game's music: build/ is git-ignored.
"""
import argparse
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import comfy  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "build" / "ai" / "music"
CHECKPOINT = "yue2_3b_int8_convrot.safetensors"
PASSES = 2
CROSSFADE = 0.08  # seconds blended where the two halves of the loop are joined

# The style is taken from the tune itself: the instruments its channels are written for (General
# MIDI program numbers) and its tempo, in the idiom of the series (late-1990s Japanese game pop).
GM_NAMES = {
    0: "piano", 4: "electric piano", 5: "electric piano", 8: "celesta", 11: "vibraphone", 12: "marimba",
    18: "rock organ", 34: "picked bass guitar", 38: "synth bass", 45: "pizzicato strings", 46: "harp",
    47: "timpani", 48: "string section", 49: "string section", 60: "french horn", 61: "brass section",
    62: "synth brass", 80: "square lead synth", 86: "saw lead synth", 98: "bell synth",
}
MOODS = {"bgmboss": "tense, urgent boss battle", "bgmtitle": "bright, cheerful title theme"}


def style_for(tune, info):
    instruments = []
    for program in info["programs"]:
        name = GM_NAMES.get(program)
        if name and name not in instruments:
            instruments.append(name)
    if info["drums"]:
        instruments.append("drum kit")
    return (f"instrumental, late 1990s Japanese video game music, upbeat jazz fusion pop, "
            f"{MOODS.get(tune, 'playful adventure')}, {', '.join(instruments)}, {info['bpm']} bpm, no vocals")


def sh(*cmd, capture=False):
    r = subprocess.run([str(c) for c in cmd], check=True, cwd=ROOT, capture_output=True, text=True)
    return r.stdout if capture else None


def tune_file(tune, variant):
    path = ROOT / "build" / "assets" / variant / "sp" / "sound" / f"{tune}.mld"
    if not path.exists():
        sys.exit(f"{path} not found: run python3 tools/extract_assets.py first")
    return path


def read_wav(path):
    with wave.open(str(path)) as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        return data.reshape(-1, w.getnchannels()), w.getframerate()


def write_wav(path, data, rate):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(data, -1, 1) * 32767).astype("<i2").tobytes())


def graph(style, abc, seed, seconds, prefix):
    """The server's YuE 2 text+score -> music graph (as in its shipped template)."""
    return {
        "15": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CHECKPOINT}},
        "25": {"class_type": "YuE2GenerateMusic", "inputs": {
            "clip": ["15", 1], "style": style, "lyrics": "", "abc": abc, "seed": int(seed), "mode": "full",
            "max_duration": float(seconds), "temperature": 1.0, "top_p": 0.95, "top_k": 100,
            "repetition_penalty": 1.2, "cfg_scale": 1.0}},
        "18": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["25", 0]}},
        "5": {"class_type": "EmptyYuE2LatentAudio", "inputs": {"seconds": ["25", 1], "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["15", 0], "positive": ["25", 0], "negative": ["18", 0],
                                                   "latent_image": ["5", 0], "seed": int(seed), "cfg": 1.0, "denoise": 1.0,
                                                   "steps": 32, "sampler_name": "dpm_2", "scheduler": "sgm_uniform"}},
        "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["8", 0], "vae": ["15", 2]}},
        "10": {"class_type": "SaveAudio", "inputs": {"audio": ["9", 0], "filename_prefix": prefix}},
    }


def chroma(x, rate, hop):
    """Which of the 12 pitch classes sound in each hop-long step (rows of unit vectors)."""
    size = 8192
    freqs = np.fft.rfftfreq(size, 1 / rate)
    band = (freqs > 80) & (freqs < 2000)
    classes = np.round(12 * np.log2(freqs[band] / 440) + 69).astype(int) % 12
    out = []
    for i in range(0, len(x) - size, hop):
        spectrum = np.abs(np.fft.rfft(x[i:i + size] * np.hanning(size)))[band] ** 2
        c = np.zeros(12)
        np.add.at(c, classes, spectrum)
        out.append(c / (np.linalg.norm(c) + 1e-9))
    return np.array(out)


def loop_period(mono, rate, expected):
    """Length in seconds of one pass of the tune in a performance of two: the lag near `expected`
    at which the pitch content best matches itself."""
    hop = int(rate * 0.05)
    c = chroma(mono, rate, hop)
    best = (-1.0, expected)
    for lag in range(int(expected * 0.88 / 0.05), int(expected * 1.12 / 0.05) + 1):
        if lag >= len(c) - 20:
            break
        score = float((c[:-lag] * c[lag:]).sum(axis=1).mean())
        best = max(best, (score, lag * 0.05))
    return best[1], best[0]


def perform(args):
    mld = tune_file(args.tune, args.variant)
    tag = f"{args.tune}.yue2.s{args.seed}"
    work = OUT / "work"
    work.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["node", "tools/ai/mfi_abc.mjs", str(mld), "--passes", str(PASSES), "--info"],
                       check=True, cwd=ROOT, capture_output=True, text=True)
    abc, info = r.stdout, json.loads(r.stderr)
    style = args.style or style_for(args.tune, info)
    seconds = info["bars"] * 4 * 60 / info["bpm"]
    (OUT / f"{tag}.abc").write_text(abc)

    result = comfy.run(graph(style, abc, args.seed, seconds * PASSES + 8, f"rdash/{tag}"), tag)
    audio = next(f for f in result["files"] if f[0] == "audio")
    raw = comfy.download(audio, work / f"{tag}{Path(audio[2]).suffix}")
    decoded = work / f"{tag}.full.wav"
    sh("ffmpeg", "-y", "-i", raw, "-ar", 44100, "-ac", 2, decoded)
    performance, rate = read_wav(decoded)
    mono = performance.mean(axis=1)
    period, repeat = loop_period(mono, rate, seconds)

    # the loop starts at the top of the second pass and wraps half a pass earlier
    n, xf = int(period * rate), int(CROSSFADE * rate)
    half = n // 2
    if len(performance) < n + half + xf:
        raise RuntimeError(f"performance too short ({len(performance) / rate:.1f} s) for a {period:.1f} s loop")
    first = performance[n:n + half + xf].copy()      # tune 0 .. half, from the second pass
    second = performance[half:n]                     # tune half .. end, from the first pass
    fade = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
    joined = np.concatenate([first[:half], first[half:half + xf] * (1 - fade) + second[:xf] * fade, second[xf:]])
    loop_wav = work / f"{tag}.loop.wav"
    write_wav(loop_wav, joined, rate)
    out = OUT / f"{tag}.ogg"
    sh("ffmpeg", "-y", "-i", loop_wav, "-c:a", "libvorbis", "-q:a", 6, out)

    # how closely it follows the game's own rendering of the tune, beat by beat
    source = work / f"{args.tune}.source.wav"
    render = ["node", "tools/mfi/render.mjs", mld, source, "--passes", 1, "--rate", rate]
    if (ROOT / "web/public/soundfont/gm.json").exists():
        render += ["--soundfont", "web/public/soundfont"]
    sh(*render)
    original, _ = read_wav(source)
    beats = info["bars"] * 4
    a = chroma(original.mean(axis=1), rate, int(seconds * rate / beats))
    b = chroma(joined.mean(axis=1), rate, int(period * rate / beats))
    k = min(len(a), len(b))
    same = float((a[:k] * b[:k]).sum(axis=1).mean())
    control = float((a[:k] * np.roll(b[:k], 17, axis=0)).sum(axis=1).mean())
    (OUT / f"{tag}.json").write_text(json.dumps({
        "tune": args.tune, "method": "yue2 score", "style": style, "seed": args.seed, "score_seconds": seconds,
        "loop_seconds": round(period, 2), "self_repeat": round(repeat, 3), "follows_source": round(same, 3),
        "control": round(control, 3), **info}, indent=1))
    print(f"style: {style}")
    print(f"{tag}: {result['seconds']} s on the server, {len(performance) / rate:.1f} s performed for a "
          f"{seconds * PASSES:.0f} s score; one pass measured {period:.2f} s (score {seconds:.2f} s, repeat match {repeat:.2f}); "
          f"follows the game's rendering {same:.2f} (misaligned control {control:.2f}) -> {out.relative_to(ROOT)}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("tune")
    p.add_argument("--style")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--variant", default="localized")
    perform(p.parse_args())


if __name__ == "__main__":
    main()
