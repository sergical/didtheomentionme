# Builds one case per ground-truth interval: unique posts gemma read + the caption words around it.
import json, re, sys
gt = json.load(open("data/gt.json"))
sec = lambda s: int(s.split(":")[0]) * 60 + int(s.split(":")[1])
posts, t = {}, None
for line in open("data/gemma.txt", encoding="utf-8"):
    m = re.match(r"== (\d+)s", line)
    if m: t = int(m[1]); continue
    p = [x.strip() for x in line.split("|", 2)]
    if len(p) == 3 and p[0].startswith("@") and len(p[2]) > 3:
        posts.setdefault(t, []).append(p)
words = [(float(a), b) for a, b in (l.rstrip("\n").split("\t") for l in open("data/words.tsv", encoding="utf-8"))]
cases = []
for i, g in enumerate(gt):
    s, e = sec(g["start"]), sec(g["end"])
    seen, uniq = set(), []
    for ts, ps in sorted(posts.items()):
        if s - 4 <= ts <= e + 4:
            for h, n, txt in ps:
                k = (h.lower(), txt[:40].lower())
                if k not in seen and "?" * 3 not in txt[:10]:
                    seen.add(k); uniq.append({"handle": h, "text": txt})
    win = [(ts, w) for ts, w in words if s - 30 <= ts <= e + 30]
    cases.append({"id": i, "start": s, "end": e, "posts": uniq, "words": win})
json.dump(cases, open("data/cases.json", "w"))
for c in cases:
    print(f"#{c['id']} {c['start']}-{c['end']}s posts={len(c['posts'])} words={len(c['words'])}")
    for p in c["posts"]: print("   ", p["handle"], "|", p["text"][:90])
