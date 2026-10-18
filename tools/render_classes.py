#!/usr/bin/env python3
"""Class-aware rendering of map cells (used by render_room.py).

How the game draws a map cell (0x4328f0): a context is filled from the cell word
(+0x0c state = high byte, +0x10 frame = state & 0xf, +0x14 type) and the colours of the
type's shape; then the class's vtable +0x08 method prepares it. Most methods select a
frame and let the generic code draw it as a tile (on white) or, when the context's
sprite flag is set, transparently over what is already there. Implemented here:

  nibble   0x41fad0, 0x41faf0: frame = state & 0xf (0 if out of range)
  wall     0x4200a0: as nibble; state >> 4 selects an underlay (see below)
  zero     0x41fb20: frame 0
  state    0x41fb50: frame = state
  type18   0x4273d0 -> 0x4201e0: as nibble; state >> 5 selects an underlay if frame < 6
  terrain  0x41fd20: underlay (state >> 5) + 15; state & 0x10: frame (state & 0xf) + 4;
           otherwise four 8x6 quarters taken from the frames named by the pattern word
           0x47f238[state & 0xf] (bits 0-3 top left, 4-7 top right, 12-15 bottom left,
           8-11 bottom right)
  masked   0x41fb80: four quarters built from frames (pattern 0x47f20c[state & 0x1f],
           3-bit fields, frame - 1, ^3 if state & 0x20) cut by mask frames base+0..3;
           class 0xde: mask base 7, frame + (state >> 6); class 0xdf: mask base 16,
           frame + ((state >> 4) & 0xc)
  door     0x41ff50: frame 0, colour 0 = state & 0xf (15 if 0); with the "door numbers"
           option the number is drawn instead (not implemented)
  addons   0x426bf0: state < 0x20: frame state & 7 as tile, then frames 8 and 9 XORed on
           top for state bits 3 and 4; state 0x21: frame 9, frame 10 XORed on top;
           other states: frame 10
  cut      0x426dc0: state < 8: frame state; state >= 0x28: frame 12; otherwise planes 0
           and 1 of frame state & 7, cut by plane 0 of mask frame (state >> 3) + 7
  letter   0x40e8f0: frame 0 (colour 0 cleared if state bit 7 is set), then the glyph of
           character state & 0x7f from the 8x8 font at 0x481170 (bits 7..1 of each row,
           each doubled to 2 pixels) in rows 3..10, in colour 1 (0x4291e0)

Underlays: entry k of the episode's underlay table (classes.underlays) is a (class id,
state) pair; that tile is drawn first (on white, frame = state), then the cell's own
shape transparently over it. Other methods fall back to the nibble rule.
"""
import struct

import classes
import scene

W, H = 16, 12
TERRAIN_PATTERNS = 0x47F238
MASKED_PATTERNS = 0x47F20C
FONT = 0x481170


class Episode:
    def __init__(self, episode, objs, exe=None):
        exe = exe or classes.Exe()
        self.objs = objs
        self.classes = classes.episode_classes(episode, exe)
        self.underlays = classes.underlays(episode, exe)
        self.type_of_class = classes.type_of_class(self.classes)
        self.terrain = struct.unpack("<16H", exe.read(TERRAIN_PATTERNS, 32))
        self.masked = struct.unpack("<32H", exe.read(MASKED_PATTERNS, 64))
        self.font = exe.read(FONT, 128 * 8)

    def shape(self, t):
        return self.objs[t] if 0 < t < len(self.objs) else None


def frame_masks(shape, frame):
    return shape.frames[frame][1] if 0 <= frame < len(shape.frames) else [None] * 4


def colourise(shape, masks, background=15):
    """Like Shape.pixels, for explicit plane masks: colour per pixel or None."""
    out = []
    for i in range(shape.width * shape.height):
        c, covered = background, False
        for k in range(3):
            if masks[k] and masks[k][i]:
                c = (c ^ shape.colours[k]) & 0xF
                covered = True
        out.append(c if covered else None)
    return out


def quarters(shape, frames_by_quarter):
    """Planes 0..2 assembled from 8x6 quarters of the given frames (None: empty)."""
    masks = []
    for j in range(3):
        plane = [0] * (W * H)
        for q, frame in enumerate(frames_by_quarter):
            src = frame_masks(shape, frame)[j] if frame is not None else None
            if not src:
                continue
            x0, y0 = (q % 2) * 8, (q // 2) * 6
            for y in range(y0, y0 + 6):
                for x in range(x0, x0 + 8):
                    plane[y * W + x] = src[y * W + x]
        masks.append(plane)
    return masks + [None]


def glyph_row(byte):
    """16-pixel row (MSB = left) for a font byte, exactly as 0x4291e0 builds it."""
    dx = 0
    for k, bit in enumerate(range(1, 8)):
        bx = ((byte >> bit) & 1) << 15
        dx |= bx
        dx >>= 1
        dx |= bx
        dx >>= 2 if k == 6 else 1
    return dx & 0xFFFF


def letter(ep, shape, state):
    colours = shape.colours if not state & 0x80 else (0,) + tuple(shape.colours[1:])
    pix = [15 if p is None else p for p in shape.pixels(0, colours=colours)]
    char = state & 0x7F
    if char > 0x20:
        for row in range(8):
            bits = glyph_row(ep.font[char * 8 + row])
            for x in range(16):
                if bits & (0x8000 >> x):
                    pix[(3 + row) * W + x] = colours[1]
    return pix


def xor_frame(pix, shape, frame, planes=3):
    """XOR a frame's plane colours onto existing pixels (428ea0 without background fill)."""
    masks = frame_masks(shape, frame)
    for k in range(planes):
        if masks[k]:
            for i, bit in enumerate(masks[k]):
                if bit:
                    pix[i] = (pix[i] ^ shape.colours[k]) & 0xF
    return pix


def addons(shape, state):
    if state >= 0x20:
        if state == 0x21:
            return xor_frame(xor_frame([15] * (W * H), shape, 9), shape, 10)
        return xor_frame([15] * (W * H), shape, 10)
    pix = xor_frame([15] * (W * H), shape, state & 7)
    for f, bit in ((8, 0x08), (9, 0x10)):
        if state & bit:
            xor_frame(pix, shape, f)
    return pix


def cut(shape, state):
    if state < 8:
        return xor_frame([15] * (W * H), shape, state)
    if state >= 0x28:
        return xor_frame([15] * (W * H), shape, 12)
    src, mask = frame_masks(shape, state & 7), frame_masks(shape, (state >> 3) + 7)[0]
    planes = [[b & m for b, m in zip(src[j], mask)] if src[j] and mask else None for j in range(2)]
    pix = [15] * (W * H)
    for k, plane in enumerate(planes):
        if plane:
            for i, bit in enumerate(plane):
                if bit:
                    pix[i] = (pix[i] ^ shape.colours[k]) & 0xF
    return pix


def nibble(shape, state):
    f = state & 0xF
    return f if f < len(shape.frames) else 0


def cell_pixels(ep, cell, sprite=False):
    """16x12 pixels for a map cell: colour indices, None = leave as is (transparent)."""
    t, state = cell & 0xFF, cell >> 8
    shape = ep.shape(t)
    if t in (0, scene.LOGIC_CELL) or not shape or not shape.frames or (shape.width, shape.height) != (W, H):
        return None
    cls = ep.classes.get(t, {})
    method = cls.get("frame_method")
    underlay = None
    if ep.underlays:
        if method == 0x4200A0 and state & 0xF0:
            underlay = state >> 4
        elif method == 0x4273D0 and state & 0xE0 and (state & 0xF) < 6:
            underlay = state >> 5
        elif method == 0x41FD20 and state & 0xE0:
            underlay = (state >> 5) + 0xF

    if method == 0x41FB20:
        pix = shape.pixels(0)
    elif method == 0x41FB50:
        pix = shape.pixels(state if state < len(shape.frames) else 0)
    elif method == 0x41FD20 and not state & 0x10:
        p = ep.terrain[state & 0xF]
        pix = colourise(shape, quarters(shape, [p & 0xF, (p >> 4) & 0xF, (p >> 12) & 0xF, (p >> 8) & 0xF]))
    elif method == 0x41FD20:
        f = (state & 0xF) + 4
        pix = shape.pixels(f if f < len(shape.frames) else 0)
    elif method == 0x41FB80:
        pix = colourise(shape, masked_planes(ep, shape, cls, state))
    elif method == 0x426BF0:
        pix = addons(shape, state)
    elif method == 0x426DC0:
        pix = cut(shape, state)
    elif method == 0x40E8F0:
        pix = letter(ep, shape, state)
    elif method == 0x41FF50:
        pix = shape.pixels(0, colours=((state & 0xF) or 15, shape.colours[1], shape.colours[2]))
    else:
        pix = shape.pixels(nibble(shape, state))

    if underlay:
        uid, ustate = ep.underlays[underlay - 1]
        ushape = ep.shape(ep.type_of_class.get(uid, 0))
        if ushape and ushape.frames:
            under = ushape.pixels(ustate if ustate < len(ushape.frames) else 0)
            return [p if p is not None else u if u is not None else 15 for u, p in zip(under, pix)]
    if sprite:
        return pix
    return [15 if p is None else p for p in pix]


def masked_planes(ep, shape, cls, state):
    pattern = ep.masked[state & 0x1F]
    planes = [[0] * (W * H) for _ in range(3)]
    mask_base, extra = 0, 0
    if cls.get("id") == 0xDE:
        mask_base, extra = 7, state >> 6
    elif cls.get("id") == 0xDF:
        mask_base, extra = 0x10, (state >> 4) & 0xC
    for k in range(4):
        f = (pattern >> (4 * k)) & 7
        if not f:
            continue
        frame = f - 1
        if state & 0x20:
            frame ^= 3
        frame += extra
        mask = frame_masks(shape, mask_base + k)[0]
        src = frame_masks(shape, frame)
        for j in range(3):
            if src[j] and mask:
                planes[j] = [a | (b & m) for a, b, m in zip(planes[j], src[j], mask)]
    return planes + [None]


def render_indices(ep, room):
    out = bytearray([15]) * (scene.W * W * scene.H * H)
    width = scene.W * W
    for layer, sprite in ((room["base"], False), (room["over"], True)):
        for i, cell in enumerate(layer):
            pix = cell_pixels(ep, cell, sprite)
            if pix is None:
                continue
            x0, y0 = (i % scene.W) * W, (i // scene.W) * H
            for y in range(H):
                for x in range(W):
                    c = pix[y * W + x]
                    if c is not None:
                        out[(y0 + y) * width + x0 + x] = c
    return bytes(out)
