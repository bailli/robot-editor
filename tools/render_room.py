#!/usr/bin/env python3
"""Render one room of an episode to a PNG at the game's native 640x348.

usage: render_room.py EPISODE ROOM_ID OUT.png [--zoom N]
Reads resources/1033/SHAPES/1E02 and scenes/1E04.scn (E = episode 0..4).
Base cells are drawn as tiles on white; overlay cells are drawn as sprites (transparent
where no mask is set). Wall auto-tiling and object state are not applied yet.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scene  # noqa: E402
import shapes  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def render(episode, room_id):
    from PIL import Image
    pal = shapes.palette(episode)
    objs = shapes.load(open(f"{ROOT}/resources/1033/SHAPES/1{episode}02", "rb").read())["_Rob_object"]
    room = next(r for r in scene.parse_scene(open(f"{ROOT}/scenes/1{episode}04.scn", "rb").read())
                if r["id"] == room_id)
    img = Image.new("RGB", (scene.W * 16, scene.H * 12), pal[15])
    px = img.load()
    for layer, sprite in ((room["base"], False), (room["over"], True)):
        for i, cell in enumerate(layer):
            t = cell & 0xFF
            s = objs[t] if 0 < t < len(objs) else None
            if not s:
                continue
            pix = s.pixels(0)
            x0, y0 = (i % scene.W) * 16, (i // scene.W) * 12
            for y in range(s.height):
                for x in range(s.width):
                    c = pix[y * s.width + x]
                    if c is None and sprite:
                        continue
                    px[x0 + x, y0 + y] = pal[15 if c is None else c]
    return img


if __name__ == "__main__":
    episode, room_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    zoom = int(sys.argv[sys.argv.index("--zoom") + 1]) if "--zoom" in sys.argv else 1
    img = render(episode, room_id)
    if zoom > 1:
        img = img.resize((img.width * zoom, img.height * zoom), 0)
    img.save(out)
