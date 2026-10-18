#!/usr/bin/env python3
"""Count the cells where our render differs from each screenshot in shots.json.

usage: eval_shots.py [--types]     --types: also list the differing cells by tile type
"""
import collections
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.join(TOOLS, "wine"))
import classes  # noqa: E402
import render_room  # noqa: E402
import take_shots  # noqa: E402

ROOT = os.path.dirname(TOOLS)


def main():
    exe = classes.Exe()
    episodes = {}
    total = 0
    by_type = collections.Counter()
    for shot in json.load(open(os.path.join(ROOT, "shots.json"))):
        path = os.path.join(ROOT, shot["file"])
        if not os.path.exists(path):
            continue
        e = shot["episode"]
        if e not in episodes:
            ep, rooms = render_room.load_episode(e, exe)
            episodes[e] = (ep, {r["id"]: r for r in rooms})
        ep, rooms = episodes[e]
        room = rooms[shot["room"]]
        cells = take_shots.differing_cells(open(path, "rb").read(), render_room.render_indices(ep, room))
        total += len(cells)
        for x, y in cells:
            by_type[(e, room["base"][y * 40 + x] & 0xFF, room["over"][y * 40 + x] & 0xFF)] += 1
        print(f"ep {e} room {shot['room']:3d}{' p' if shot.get('patched') else '  '}: {len(cells):4d}")
    print(f"total: {total}")
    if "--types" in sys.argv:
        for (e, base, over), n in by_type.most_common(30):
            print(f"  ep {e} base {base:3d} over {over:3d}: {n}")


if __name__ == "__main__":
    main()
