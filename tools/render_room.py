#!/usr/bin/env python3
"""Render one room of an episode to a PNG at the game's native 640x348.

usage: render_room.py EPISODE ROOM_ID OUT.png [--zoom N]
Reads resources/1033/SHAPES/1E02 and resources/1033/SCENE/1E04 (E = episode 0..4).
Base cells are drawn as tiles on white; overlay cells are drawn as sprites (transparent
where no mask is set). The frame is the low nibble of the cell's high byte, or 0 if the
shape has no such frame: what the wall class (0x41faa0, used for diagonal wall corners)
and most other classes do. Not applied yet: class-specific frame/colour logic and
drawing the cells stored in logic records (cells with type 0x7f stay empty).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import descene  # noqa: E402
import scene  # noqa: E402
import shapes  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TILE_W, TILE_H = 16, 12
WIDTH, HEIGHT = scene.W * TILE_W, scene.H * TILE_H


def load_episode(episode):
    objs = shapes.load(open(f"{ROOT}/resources/1033/SHAPES/1{episode}02", "rb").read())["_Rob_object"]
    encrypted = open(f"{ROOT}/resources/1033/SCENE/1{episode}04", "rb").read()
    return objs, scene.parse_scene(descene.decrypt(encrypted))


def cell_frame(shape, cell):
    """Low nibble of the high byte, 0 if out of range, None if the shape has no frames."""
    if not shape.frames:
        return None
    frame = (cell >> 8) & 0xF
    return frame if frame < len(shape.frames) else 0


def render_indices(objs, room):
    """Palette index per pixel, row-major, WIDTH x HEIGHT bytes."""
    out = bytearray([15]) * (WIDTH * HEIGHT)
    for layer, sprite in ((room["base"], False), (room["over"], True)):
        for i, cell in enumerate(layer):
            t = cell & 0xFF
            if t in (0, scene.LOGIC_CELL):
                continue
            s = objs[t] if t < len(objs) else None
            frame = cell_frame(s, cell) if s else None
            if frame is None:
                continue
            pix = s.pixels(frame)
            x0, y0 = (i % scene.W) * TILE_W, (i // scene.W) * TILE_H
            for y in range(min(s.height, HEIGHT - y0)):
                row = (y0 + y) * WIDTH + x0
                for x in range(min(s.width, WIDTH - x0)):
                    c = pix[y * s.width + x]
                    if c is None and sprite:
                        continue
                    out[row + x] = 15 if c is None else c
    return bytes(out)


def render(episode, room_id):
    from PIL import Image
    objs, rooms = load_episode(episode)
    room = next(r for r in rooms if r["id"] == room_id)
    img = Image.frombytes("P", (WIDTH, HEIGHT), render_indices(objs, room))
    img.putpalette([v for rgb in shapes.palette(episode) for v in rgb])
    return img.convert("RGB")


if __name__ == "__main__":
    episode, room_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    zoom = int(sys.argv[sys.argv.index("--zoom") + 1]) if "--zoom" in sys.argv else 1
    img = render(episode, room_id)
    if zoom > 1:
        img = img.resize((img.width * zoom, img.height * zoom), 0)
    img.save(out)
