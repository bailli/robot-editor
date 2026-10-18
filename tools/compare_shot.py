#!/usr/bin/env python3
"""Compare an in-game screenshot with our render of a room, cell by cell.

usage: compare_shot.py EPISODE ROOM_ID SHOT.png [--diff OUT.png] [--ignore X0,Y0,X1,Y1 ...]

SHOT.png is a screenshot written by the game (see tools/wine/harness.py): 640x348 with
palette indices as pixel values, so the comparison is exact. Row 0 is skipped because
the game draws its status line there. Prints every differing cell with its base and
overlay values; --diff writes game | render | difference side by side (3x zoom).
--ignore skips a rectangle of cells (inclusive), e.g. the room-name banner.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_room  # noqa: E402
import scene  # noqa: E402
import shapes  # noqa: E402


def compare(episode, room_id, shot_path, ignore=()):
    from PIL import Image
    shot = Image.open(shot_path)
    if shot.size != (render_room.WIDTH, render_room.HEIGHT) or shot.mode != "P":
        sys.exit(f"{shot_path}: expected a {render_room.WIDTH}x{render_room.HEIGHT} palette PNG")
    game = shot.tobytes()
    ep, rooms = render_room.load_episode(episode)
    room = next((r for r in rooms if r["id"] == room_id), None)
    if room is None:
        sys.exit(f"episode {episode} has no room {room_id}")
    ours = render_room.render_indices(ep, room)
    cells = []
    for cy in range(1, scene.H):
        for cx in range(scene.W):
            if any(x0 <= cx <= x1 and y0 <= cy <= y1 for x0, y0, x1, y1 in ignore):
                continue
            n = sum(1 for y in range(render_room.TILE_H) for x in range(render_room.TILE_W)
                    if game[(cy * 12 + y) * 640 + cx * 16 + x] != ours[(cy * 12 + y) * 640 + cx * 16 + x])
            if n:
                i = cy * scene.W + cx
                cells.append((cx, cy, room["base"][i], room["over"][i], n))
    return game, ours, cells


def diff_image(episode, game, ours, out):
    from PIL import Image
    w, h = render_room.WIDTH, render_room.HEIGHT
    pal = [v for rgb in shapes.palette(episode) for v in rgb]
    canvas = Image.new("RGB", (w * 3, h))
    for k, data in enumerate((game, ours)):
        img = Image.frombytes("P", (w, h), data)
        img.putpalette(pal)
        canvas.paste(img.convert("RGB"), (k * w, 0))
    mask = Image.frombytes("L", (w, h), bytes(255 if a != b else 0 for a, b in zip(game, ours)))
    canvas.paste(Image.new("RGB", (w, h), (255, 0, 255)), (2 * w, 0), mask)
    canvas.resize((w * 9, h * 3), Image.NEAREST).save(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("episode", type=int)
    p.add_argument("room", type=int)
    p.add_argument("shot")
    p.add_argument("--diff")
    p.add_argument("--ignore", nargs="*", default=[], metavar="X0,Y0,X1,Y1")
    a = p.parse_args()
    ignore = [tuple(int(v) for v in r.split(",")) for r in a.ignore]
    game, ours, cells = compare(a.episode, a.room, a.shot, ignore)
    skipped = sum((x1 - x0 + 1) * (y1 - y0 + 1) for x0, y0, x1, y1 in ignore)
    total = (scene.H - 1) * scene.W - skipped
    print(f"{len(cells)} of {total} compared cells differ (row 0 and ignored cells skipped)")
    for cx, cy, base, over, n in cells:
        print(f"  ({cx:2d},{cy:2d}) base {base:#06x} overlay {over:#06x}: {n} px")
    if a.diff:
        diff_image(a.episode, game, ours, a.diff)


if __name__ == "__main__":
    main()
