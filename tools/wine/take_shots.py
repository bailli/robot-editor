#!/usr/bin/env python3
"""Take reference screenshots of every episode's start room and record them in shots.json.

usage: take_shots.py [EPISODE ...]      (default: all episodes 0..4)

For each episode this runs the Wine harness, finds the room the screenshot shows (the
best-matching render), and writes
  shots/ep<E>.png   the game's screenshot (palette PNG, for viewing)
  shots/ep<E>.bin   its palette indices, 640x348 bytes (read by the TypeScript test)
shots/ holds game imagery and is not committed. shots.json (committed) lists every
screenshot with its hash and the cells where our renderer currently differs from the
game (row 0, the status line, is not compared). The test in packages/formats fails when
that set changes, in either direction, so improvements and regressions both show up
in review as a diff of shots.json.
"""
import hashlib
import json
import os
import sys

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.join(TOOLS, "wine"))
import harness  # noqa: E402
import render_room  # noqa: E402
import scene  # noqa: E402

ROOT = os.path.dirname(TOOLS)
SHOTS = os.path.join(ROOT, "shots")
MANIFEST = os.path.join(ROOT, "shots.json")
W, TW, TH = render_room.WIDTH, render_room.TILE_W, render_room.TILE_H


def differing_cells(game, ours):
    cells = []
    for cy in range(1, scene.H):
        for cx in range(scene.W):
            if any(game[(cy * TH + y) * W + cx * TW + x] != ours[(cy * TH + y) * W + cx * TW + x]
                   for y in range(TH) for x in range(TW)):
                cells.append([cx, cy])
    return cells


def take(episode):
    from PIL import Image
    os.makedirs(SHOTS, exist_ok=True)
    png = os.path.join(SHOTS, f"ep{episode}.png")
    harness.shot(episode, png)
    game = Image.open(png).tobytes()
    open(os.path.join(SHOTS, f"ep{episode}.bin"), "wb").write(game)
    objs, rooms = render_room.load_episode(episode)
    best = None
    for room in rooms:
        cells = differing_cells(game, render_room.render_indices(objs, room))
        if best is None or len(cells) < len(best[1]):
            best = (room["id"], cells)
    room_id, cells = best
    print(f"episode {episode}: room {room_id}, {len(cells)} differing cells")
    return {
        "episode": episode,
        "room": room_id,
        "file": f"shots/ep{episode}.bin",
        "sha256": hashlib.sha256(game).hexdigest(),
        "differingCells": cells,
    }


def main():
    episodes = [int(e) for e in sys.argv[1:]] or list(range(5))
    entries = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else []
    for episode in episodes:
        entries = [e for e in entries if e["episode"] != episode] + [take(episode)]
    entries.sort(key=lambda e: e["episode"])
    with open(MANIFEST, "w") as f:
        f.write("[\n" + ",\n".join("  " + json.dumps(e) for e in entries) + "\n]\n")


if __name__ == "__main__":
    main()
