#!/usr/bin/env python3
"""Export reference ("golden") outputs of the Python tools for the TypeScript tests.

usage: export_golden.py   (run from anywhere; writes <repo>/golden/)

golden/cp437.json               the 256 CP437 characters as a string
golden/crunched/<id>.json       header fields of each CRUNCHED resource
golden/crunched/<id>.bin        its decompressed bytes
golden/scene/<id>.scn           each decrypted SCENE resource
golden/scene/<id>.rooms.json    its parsed rooms
"""
import glob
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
sys.path.insert(0, TOOLS)
import descene  # noqa: E402
import scene  # noqa: E402
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
    print("golden data written to", out)


if __name__ == "__main__":
    main()
