#!/usr/bin/env python3
"""Decode SHAPES resources (16-bit OMF object files) into sprite frames.

Each SHAPES resource is an OMF .OBJ written by "TOM Productions Shape editor SED93".
The game links it at load time with its own mini linker (0x43a050). _DATA holds tables
of shape descriptors (one table per public symbol, e.g. _Rob_object, _Aliens (the robots), _Hero1);
_TEXT holds 1-bit masks. Pointers are resolved via FIXUPP records.

Shape descriptor, 12 bytes:
  u8  width (pixels)        u8  height
  u16 0                     u8  bytes per row       u8  frame count
  u16 ptr -> frames         u8[3] colours c0 c1 c2  u8 unknown
  An all-zero descriptor is an empty slot. _Rob_object is indexed by object/tile id.

Frame, 18 bytes:
  u16 unknown (0..40)
  4 x far ptr -> 1-bit mask (rows * bytes_per_row bytes, MSB = leftmost pixel); null = empty
Drawing (0x428ea0 / 0x428f70): start from a background colour, then for masks 0..2 XOR
colour c_k into every pixel the mask covers. Mask 3 is not used by the drawing code.
Map tiles start from colour 15 (all four planes set, 0x41fb93), so the visible colour of
a pixel covered only by mask k is 15 ^ c_k; empty floor is white. Pixels covered by no
mask are transparent when drawn as a sprite (0x428f70). Verified against a screenshot
of Episode I room 43. Which frame a map cell shows is decided by its object class (see
render_room.py); walls store their diagonal corner pieces as frames 1-4 in the map.
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from omf import Module  # noqa: E402

EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reference", "GameOfRobot.exe")


def palette(episode, exe=EXE):
    """16 base colours: 0x4827f0 by default, 0x477c10 for episode 3 (vtable +0x48)."""
    d = open(exe, "rb").read()
    va = 0x477C10 if episode == 3 else 0x4827F0
    o = va - 0x474000 + 0x74000
    return [tuple(d[o + 4 * i:o + 4 * i + 3]) for i in range(16)]


class Shape:
    def __init__(self, width, height, bpr, colours, unknown, frames):
        self.width, self.height, self.bpr = width, height, bpr
        self.colours = colours    # (c0, c1, c2)
        self.unknown = unknown
        self.frames = frames      # list of (word, [mask0..mask3]); mask = list of 0/1 or None

    def pixels(self, frame=0, background=15, colours=None):
        """Colour index per pixel, or None where no mask covers the pixel."""
        cols = colours or self.colours
        masks = self.frames[frame][1]
        out = []
        for i in range(self.width * self.height):
            covered = False
            c = background
            for k in range(3):
                if masks[k] and masks[k][i]:
                    c = (c ^ cols[k]) & 0xF
                    covered = True
            out.append(c if covered else None)
        return out


def load(d):
    m = Module(d)
    text, data = m.data[1], m.data[2]
    ptrs = {f[1]: f[6] for f in m.fixups if f[0] == 2}  # offset in DATA -> displacement

    def mask(po, w, h, bpr):
        return [1 if text[po + y * bpr + (x >> 3)] & (0x80 >> (x & 7)) else 0
                for y in range(h) for x in range(w)]

    def frame(e, w, h, bpr):
        word, = struct.unpack_from("<H", data, e)
        masks = []
        for j in range(4):
            if e + 2 + 4 * j in ptrs:
                po, = struct.unpack_from("<H", data, e + 2 + 4 * j)
                masks.append(mask(po + ptrs[e + 2 + 4 * j], w, h, bpr))
            else:
                masks.append(None)
        return word, masks

    tables = {}
    pubs = sorted(m.publics, key=lambda p: p[2])
    ends = [p[2] for p in pubs[1:]] + [len(data)]
    for (name, seg, start), end in zip(pubs, ends):
        table = []
        for p in range(start, end - 11, 12):
            w, h, _, bpr, n, fr = struct.unpack_from("<BBHBBH", data, p)
            if w == 0:
                if any(data[p:p + 12]):
                    break
                table.append(None)
                continue
            if p + 6 not in ptrs:
                break
            frames = [frame(fr + ptrs[p + 6] + 18 * i, w, h, bpr) for i in range(n)]
            table.append(Shape(w, h, bpr, tuple(data[p + 8:p + 11]), data[p + 11], frames))
        while table and table[-1] is None:
            table.pop()
        tables[name] = table
    return tables


def sheet(table, pal, zoom=3, label=True):
    from PIL import Image, ImageDraw
    shapes = [s for s in table if s]
    cw = max(s.width for s in shapes) + 2
    ch = max(s.height for s in shapes) + 2
    maxf = max(len(s.frames) for s in shapes)
    lw = 28 if label else 0
    img = Image.new("RGB", ((lw + cw * maxf) * zoom, ch * len(table) * zoom), (96, 96, 96))
    dr = ImageDraw.Draw(img)
    for row, s in enumerate(table):
        if label:
            dr.text((2, row * ch * zoom + 2), str(row), fill=(0, 0, 0))
        if not s:
            continue
        for k in range(len(s.frames)):
            pix = s.pixels(k)
            ox, oy = lw + k * cw, row * ch
            for y in range(s.height):
                for x in range(s.width):
                    c = pix[y * s.width + x]
                    img.paste(pal[15 if c is None else c], ((ox + x) * zoom, (oy + y) * zoom,
                                                            (ox + x + 1) * zoom, (oy + y + 1) * zoom))
    return img


if __name__ == "__main__":
    src, out, episode = sys.argv[1], sys.argv[2], int(sys.argv[3])
    pal = palette(episode)
    for name, t in load(open(src, "rb").read()).items():
        print(name, len(t), "entries")
        sheet(t, pal).save(f"{out}_{name.strip('_')}.png")
