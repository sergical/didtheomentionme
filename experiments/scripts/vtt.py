# Turns a YouTube auto-caption VTT into "SECONDS<TAB>word" lines using the inline word timings.
import re, sys
words, seen = [], set()
cue_start = None
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r"(\d+):(\d+):([\d.]+) -->", line)
    if m:
        cue_start = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
        continue
    if "<c>" not in line:
        continue
    parts = re.split(r"<(\d+:\d+:[\d.]+)>", line.strip())
    t = cue_start
    for i, chunk in enumerate(parts):
        if i % 2 == 1:
            h, mi, s = chunk.split(":"); t = int(h) * 3600 + int(mi) * 60 + float(s); continue
        for w in re.sub(r"</?c>", "", chunk).split():
            key = (round(t, 2), w)
            if key not in seen:
                seen.add(key); words.append((t, w))
for t, w in words:
    print(f"{t:.2f}\t{w}")
