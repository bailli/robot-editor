"""Research script (event entries): per episode, its entries from 128 on by who raises
their id or plays their sound, from out/table.txt (trace.py table) and out/dump.json (dump.ts). Code only:
the scripts' Enigma calls (entries, see README.md) are not included here."""
import json, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
dump = json.load(open(os.path.join(OUT, "dump.json")))
raised = {}
for line in open(os.path.join(OUT, "table.txt")):
    kind, *r = line.split()
    if not r[0].startswith("0x"):
        continue  # computed ids: Enigma, oracle 262 + n, console
    eps = r[4].split("=")[1]
    unresolved = not line.rstrip().endswith("[]")
    raised.setdefault(int(r[0], 16), []).append((eps, unresolved, r[3][2:] + ("(sound)" if kind == "sound" else "")))
for ep in dump:
    e = ep["episode"]
    events = ep["events"]
    groups = {"none": [], "own": [], "other": []}
    for n in range(128, len(events)):
        i = events[n]["id"]
        rs = raised.get(i, [])
        if not rs:
            groups["none"].append(f"{n}:{i}")
        elif any(str(e) in eps or "ep" in eps for eps, _, _ in rs):
            groups["own"].append(f"{n}:{i}")
        else:
            how = "/".join(f + ("?" if u else "") + "@" + (eps or "-") for eps, u, f in rs)
            groups["other"].append(f"{n}:{i}[{how}]")
    print(f"ep {e}")
    print(f"  no code raiser: {' '.join(groups['none'])}")
    print(f"  only other episodes' classes or unresolved (?): {' '.join(groups['other'])}")
    print(f"  raised by own classes or engine: {' '.join(groups['own'])}")
