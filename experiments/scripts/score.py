# Scores each detection method against the hand-labelled intervals in gt.json.
import json, math, sys
from pathlib import Path

d = Path(sys.argv[1])
def sec(m): a, b = m.split(":"); return int(a) * 60 + int(b)
gt = [(sec(g["start"]), sec(g["end"]) + 3) for g in json.loads((d / "gt.json").read_text())]  # +3: labels sampled every 4 s
pos = {s for a, b in gt for s in range(a, b + 1)}
load = lambda f: [json.loads(l) for l in (d / f).read_text().splitlines()]
flash = {n: {r["t"]: r["p"] for r in load(f"flash{n}.jsonl")} for n in (1280, 640)}
omni = {r["clip"]: r["p"] for r in load("omni.jsonl")}
scenes = [(float(t), float(s)) for t, s in (l.split() for l in (d / "scenes.tsv").read_text().splitlines())]
dur = max(flash[1280]) + 1
PRICE = {"flash": 0.038, "omni": 0.15}

def report(name, checked, p, th):
    hits = {t for t in checked if p.get(t, 0) >= th}
    found = sum(any(a <= t <= b for t in hits) for a, b in gt)
    fp = len(hits - pos)
    print(f"{name:<44} frames={len(checked):>5}  intervals {found}/{len(gt)}  false+ frames={fp}")

for th in (0.5, 0.8):
    print(f"--- clef-flash threshold {th}")
    for n in (1280, 640):
        report(f"brute force 1 fps @{n}px", set(range(dur)), flash[n], th)
    for sth in (0.1, 0.2, 0.3):
        cuts = {min(math.ceil(t), dur - 1) for t, s in scenes if s >= sth} | {0}
        report(f"scene>={sth} @640px", cuts, flash[640], th)
        # Also keep one frame every 10 s so a post that slides in without a hard cut is still sampled.
        report(f"scene>={sth} + every 10 s @640px", cuts | set(range(0, dur, 10)), flash[640], th)
    for oth in (0.3, 0.5):
        clips = {c for c, p in omni.items() if p is not None and p >= oth}
        inside = {t for t in range(dur) if t // 60 in clips}
        report(f"omni>={oth} ({len(clips)}/{len(omni)} clips) then 1 fps @640", inside, flash[640], th)

# Which intervals does brute force miss, and what does the model say there?
print("--- per-interval max p (640px brute force) and omni clip p")
for a, b in gt:
    mp = max(flash[640].get(t, 0) for t in range(a, b + 1))
    print(f"{a//60}:{a%60:02d}-{b//60}:{b%60:02d}  max_p={mp:.2f}  omni={omni.get(a//60)}")
print("--- cost for this 41 min video")
print(f"flash 1280 brute: ${sum(r['tokens'] for r in load('flash1280.jsonl'))*PRICE['flash']/1e6:.3f}")
print(f"flash 640 brute:  ${sum(r['tokens'] for r in load('flash640.jsonl'))*PRICE['flash']/1e6:.3f}")
print(f"omni all clips:   ${sum(r['tokens'] for r in load('omni.jsonl'))*PRICE['omni']/1e6:.3f}")
