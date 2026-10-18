#!/usr/bin/env python3
"""Export reference ("golden") outputs of the Python tools for the TypeScript tests.

usage: export_golden.py   (run from anywhere; writes <repo>/golden/)

golden/cp437.json               the 256 CP437 characters as a string
golden/crunched/<id>.json       header fields of each CRUNCHED resource
golden/crunched/<id>.bin        its decompressed bytes
golden/scene/<id>.scn           each decrypted SCENE resource
golden/scene/<id>.rooms.json    its parsed rooms
golden/palettes.json            the 16-colour palette of each episode 0..4
golden/shapes/<id>.json         decoded shape tables of each SHAPES resource (masks as 0/1 strings)
golden/render/<episode>.json    sha256 of the palette-index render of every room

It also writes golden.sha256 (committed): the hash of every golden file, so that a
change to the reference output shows up in review even when the TypeScript code was
changed in step with the Python tools.
"""
import glob
import hashlib
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import descene  # noqa: E402
import render_room  # noqa: E402
import scene  # noqa: E402
import shapes  # noqa: E402
import uncrunch  # noqa: E402


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(path, mode) as f:
        f.write(data)


def room_json(r):
    return {
        "id": r["id"],
        "tags": [{"kind": k, "value": v, **({"data": d.hex()} if d is not None else {})}
                 for k, v, d in r["tags"]],
        "base": r["base"],
        "over": r["over"],
        "objects": [{"slot": s, "data": d.hex(), **({"extra": e} if e is not None else {})}
                    for s, d, e in r["objects"]],
    }


def shape_json(s):
    if s is None:
        return None
    return {
        "width": s.width,
        "height": s.height,
        "bytesPerRow": s.bpr,
        "colours": list(s.colours),
        "unknown": s.unknown,
        "frames": [{"word": word, "masks": [None if m is None else "".join(map(str, m)) for m in masks]}
                   for word, masks in s.frames],
    }


def main():
    out = os.path.join(ROOT, "golden")
    write(f"{out}/cp437.json", json.dumps(bytes(range(256)).decode("cp437")))
    for path in sorted(glob.glob(f"{ROOT}/resources/*/CRUNCHED/*")):
        rid = os.path.basename(path)
        marker, size, count, text = uncrunch.uncrunch(open(path, "rb").read())
        write(f"{out}/crunched/{rid}.json", json.dumps({"marker": marker, "size": size, "count": count}))
        write(f"{out}/crunched/{rid}.bin", text)
    for path in sorted(glob.glob(f"{ROOT}/resources/*/SCENE/*")):
        rid = os.path.basename(path)
        plain = descene.decrypt(open(path, "rb").read())
        write(f"{out}/scene/{rid}.scn", plain)
        write(f"{out}/scene/{rid}.rooms.json", json.dumps([room_json(r) for r in scene.parse_scene(plain)]))
    write(f"{out}/palettes.json", json.dumps({e: shapes.palette(e) for e in range(5)}))
    for path in sorted(glob.glob(f"{ROOT}/resources/*/SHAPES/*")):
        tables = shapes.load(open(path, "rb").read())
        write(f"{out}/shapes/{os.path.basename(path)}.json",
              json.dumps({name: [shape_json(s) for s in t] for name, t in tables.items()}))
    for episode in range(5):
        objs, rooms = render_room.load_episode(episode)
        hashes = {}
        for room in rooms:
            pixels = render_room.render_indices(objs, room)
            hashes[room["id"]] = hashlib.sha256(pixels).hexdigest()
        write(f"{out}/render/{episode}.json", json.dumps(hashes))
    lines = []
    for path in sorted(glob.glob(f"{out}/**/*", recursive=True)):
        if os.path.isfile(path):
            digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
            lines.append(f"{digest}  {os.path.relpath(path, ROOT)}\n")
    write(f"{ROOT}/golden.sha256", "".join(lines))
    print("golden data written to", out)


if __name__ == "__main__":
    main()
