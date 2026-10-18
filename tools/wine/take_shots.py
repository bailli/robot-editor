#!/usr/bin/env python3
"""Take reference screenshots of every episode's start room and record them in shots.json.

usage: take_shots.py [EPISODE ...]            start rooms (default: all episodes 0..4)
       take_shots.py --room EPISODE ROOM ...  any room, via a patched copy of the exe

For each episode this runs the Wine harness, finds the room the screenshot shows (the
best-matching render), and writes
  shots/ep<E>.png   the game's screenshot (palette PNG, for viewing)
  shots/ep<E>.bin   its palette indices, 640x348 bytes (read by the TypeScript test)
shots/ holds game imagery and is not committed. shots.json (committed) lists every
screenshot with its hash and the cells where our renderer currently differs from the
game (row 0, the status line, is not compared). Pixels are compared by their low 4 bits:
dark rooms use the same 16 colours shifted into another part of the game's 224-entry
palette; that shift is recorded as paletteOffset. The test in packages/formats fails when
that set changes, in either direction, so improvements and regressions both show up
in review as a diff of shots.json.

--room takes rooms the game cannot start in: a copy of the exe gets a scene that only
holds rooms 1 and 2 (title screens) and, in the slot of the episode's start room, the
map and tags of the wanted room, without its scripts (they evaluate game state and
could change the room). Such entries are marked "patched".
"""
import hashlib
import json
import os
import sys

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TOOLS)
sys.path.insert(0, os.path.join(TOOLS, "wine"))
import descene  # noqa: E402
import harness  # noqa: E402
import pe_resources  # noqa: E402
import render_room  # noqa: E402
import scene  # noqa: E402

ROOT = os.path.dirname(TOOLS)
SHOTS = os.path.join(ROOT, "shots")
MANIFEST = os.path.join(ROOT, "shots.json")
W, TW, TH = render_room.WIDTH, render_room.TILE_W, render_room.TILE_H
START_ROOMS = {0: 43, 1: 43, 2: 43, 3: 41, 4: 53}  # measured with the unpatched game
SCRIPT_TAGS = {(6, 1), (6, 2)}  # script source and compiled script


def patched_exe(episode, room_id):
    """A copy of the exe whose episode starts in a room with the content of room_id."""
    exe = open(harness.EXE, "rb").read()
    name = int(f"1{episode}04")
    _, offset, size = pe_resources.find_resource(exe, "SCENE", name)
    rooms = scene.parse_scene(descene.decrypt(exe[offset:offset + size]))
    by_id = {r["id"]: r for r in rooms}
    target = dict(by_id[room_id])
    target["id"] = START_ROOMS[episode]
    target["tags"] = [t for t in target["tags"] if (t[0], t[1]) not in SCRIPT_TAGS]
    keep = [by_id[i] for i in (1, 2) if i in by_id and i != START_ROOMS[episode]]
    data = descene.decrypt(scene.serialize_scene(sorted(keep + [target], key=lambda r: r["id"])))
    path = os.path.join(harness.BASE, f"GameOfRobot-ep{episode}-room{room_id}.exe")
    open(path, "wb").write(pe_resources.replace_resource(exe, "SCENE", name, data))
    return path


def palette_offset(game):
    """Most common 16-colour group of the playfield (row 0 is the status line)."""
    counts = {}
    for b in game[W * TH:]:
        counts[b & 0xF0] = counts.get(b & 0xF0, 0) + 1
    return max(counts, key=counts.get)


def differing_cells(game, ours):
    """Cells whose pixels differ in their low 4 bits (the colour within a palette group)."""
    cells = []
    for cy in range(1, scene.H):
        for cx in range(scene.W):
            if any((game[(cy * TH + y) * W + cx * TW + x] ^ ours[(cy * TH + y) * W + cx * TW + x]) & 0x0F
                   for y in range(TH) for x in range(TW)):
                cells.append([cx, cy])
    return cells


def take(episode, room_id=None):
    """Screenshot the start room (room_id None) or a given room via a patched exe."""
    from PIL import Image
    os.makedirs(SHOTS, exist_ok=True)
    stem = f"ep{episode}" if room_id is None else f"ep{episode}-room{room_id}"
    png = os.path.join(SHOTS, f"{stem}.png")
    exe = harness.EXE if room_id is None else patched_exe(episode, room_id)
    harness.shot(episode, png, exe=exe)
    game = Image.open(png).tobytes()
    open(os.path.join(SHOTS, f"{stem}.bin"), "wb").write(game)
    ep, rooms = render_room.load_episode(episode)
    if room_id is None:  # the start room: the room that matches best
        candidates = rooms
    else:
        candidates = [r for r in rooms if r["id"] == room_id]
    best = None
    for room in candidates:
        cells = differing_cells(game, render_room.render_indices(ep, room))
        if best is None or len(cells) < len(best[1]):
            best = (room["id"], cells)
    found, cells = best
    print(f"episode {episode}: room {found}, {len(cells)} differing cells")
    entry = {
        "episode": episode,
        "room": found,
        "file": f"shots/{stem}.bin",
        "sha256": hashlib.sha256(game).hexdigest(),
        "paletteOffset": palette_offset(game),
        "differingCells": cells,
    }
    if room_id is not None:
        entry["patched"] = True
    return entry


def main():
    args = sys.argv[1:]
    if args[:1] == ["--room"]:
        if len(args) < 3:
            sys.exit("usage: take_shots.py --room EPISODE ROOM ...")
        jobs = [(int(args[1]), int(r)) for r in args[2:]]
    else:
        jobs = [(int(e), None) for e in args] or [(e, None) for e in range(5)]
    entries = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else []
    for episode, room_id in jobs:
        entry = take(episode, room_id)
        entries = [e for e in entries if e["file"] != entry["file"]] + [entry]
    entries.sort(key=lambda e: (e["episode"], e.get("patched", False), e["room"]))
    with open(MANIFEST, "w") as f:
        f.write("[\n" + ",\n".join("  " + json.dumps(e) for e in entries) + "\n]\n")


if __name__ == "__main__":
    main()
