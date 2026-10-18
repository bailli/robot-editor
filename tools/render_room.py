#!/usr/bin/env python3
"""Render one room of an episode to a PNG at the game's native 640x348.

usage: render_room.py EPISODE ROOM_ID OUT.png [--zoom N]
Reads resources/1033/SHAPES/1E02 and resources/1033/SCENE/1E04 (E = episode 0..4) and
the class data from reference/GameOfRobot.exe. Base cells are drawn as tiles on white,
overlay cells as sprites (transparent where no plane is set); how a cell is drawn depends
on its object class, see render_classes.py. Not drawn: actors and the cells stored in
logic records (cells with type 0x7f stay empty).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import descene  # noqa: E402
import render_classes  # noqa: E402
import scene  # noqa: E402
import shapes  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TILE_W, TILE_H = render_classes.W, render_classes.H
WIDTH, HEIGHT = scene.W * TILE_W, scene.H * TILE_H


def load_episode(episode, exe=None):
    """(render_classes.Episode, rooms) of an episode."""
    objs = shapes.load(open(f"{ROOT}/resources/1033/SHAPES/1{episode}02", "rb").read())["_Rob_object"]
    encrypted = open(f"{ROOT}/resources/1033/SCENE/1{episode}04", "rb").read()
    return render_classes.Episode(episode, objs, exe), scene.parse_scene(descene.decrypt(encrypted))


def render_indices(ep, room):
    """Palette index per pixel, row-major, WIDTH x HEIGHT bytes."""
    return render_classes.render_indices(ep, room)


def render(episode, room_id):
    from PIL import Image
    ep, rooms = load_episode(episode)
    room = next(r for r in rooms if r["id"] == room_id)
    img = Image.frombytes("P", (WIDTH, HEIGHT), render_indices(ep, room))
    img.putpalette([v for rgb in shapes.palette(episode) for v in rgb])
    return img.convert("RGB")


if __name__ == "__main__":
    episode, room_id, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    zoom = int(sys.argv[sys.argv.index("--zoom") + 1]) if "--zoom" in sys.argv else 1
    img = render(episode, room_id)
    if zoom > 1:
        img = img.resize((img.width * zoom, img.height * zoom), 0)
    img.save(out)
