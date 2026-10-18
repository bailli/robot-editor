#!/usr/bin/env python3
"""Object classes of each episode, read from GameOfRobot.exe.

Every episode passes a table of 128 entries (8 bytes: class object, unknown) to the
episode constructor (0x43b2e0); entry t handles map tile type t. Class objects are
static instances whose vtable is set at startup by `mov dword ptr [object], vtable`
(C7 05 imm32 imm32). Interesting vtable slots:
  +0x00  class id (a constant: `mov eax, id; ret`)
  +0x08  prepares a map cell for drawing (frame selection etc.); see FRAME_METHODS

usage: classes.py [EPISODE]   prints type -> class id, vtable, frame method
"""
import os
import struct
import sys

EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reference", "GameOfRobot.exe")
CLASS_TABLES = {0: 0x479AD8, 1: 0x475838, 2: 0x476E00, 3: 0x477CA0, 4: 0x478C40}
# Underlay tables (episode constructor argument 6, episode +0x10): 2-byte entries
# (class id, state) of the tile drawn below a cell whose state selects entry k (1-based).
UNDERLAY_TABLES = {0: None, 1: 0x466434, 2: 0x466524, 3: 0x466678, 4: 0x466C08}
UNDERLAY_ENTRIES = 23  # highest index used: (0xff >> 5) + 0xf = 22, (0xff >> 4) = 15
TYPES = 128

# Known frame selection methods (vtable +0x08) and what they do.
FRAME_METHODS = {
    0x41FAD0: "nibble",   # -> 0x41faa0: frame = high byte & 0xf, 0 if out of range
    0x4200A0: "nibble",   # walls: as above (plus an overlay when the state's high nibble is set)
    0x41FAF0: "nibble",   # as above, colour 0 cleared when state bit 7 is set
    0x41FB20: "zero",     # frame 0
    0x41FB50: "state",    # frame = whole high byte
}


class Exe:
    def __init__(self, path=EXE):
        self.d = open(path, "rb").read()
        pe, = struct.unpack_from("<I", self.d, 0x3C)
        count, = struct.unpack_from("<H", self.d, pe + 6)
        opt_size, = struct.unpack_from("<H", self.d, pe + 20)
        self.base, = struct.unpack_from("<I", self.d, pe + 24 + 28)
        self.sections = []
        for i in range(count):
            h = pe + 24 + opt_size + i * 40
            vsize, va, raw_size, raw_off = struct.unpack_from("<IIII", self.d, h + 8)
            self.sections.append((self.base + va, raw_size, raw_off))

    def read(self, va, n):
        for start, size, raw in self.sections:
            if start <= va and va + n <= start + size:
                return self.d[raw + va - start:raw + va - start + n]
        raise ValueError(f"no initialised data at {va:#x}")

    def u32(self, va):
        return struct.unpack("<I", self.read(va, 4))[0]


def vtables(exe):
    """Class object address -> vtable address, from `mov dword ptr [obj], vtable` in code."""
    out = {}
    d = exe.d
    pos = d.find(b"\xC7\x05")
    while pos != -1:
        obj, vt = struct.unpack_from("<II", d, pos + 2)
        if 0x4C0000 <= obj < 0x520000 and 0x466000 <= vt < 0x474000:
            out.setdefault(obj, vt)
        pos = d.find(b"\xC7\x05", pos + 1)
    return out


def class_id(exe, vt):
    code = exe.read(exe.u32(vt), 6)
    return struct.unpack_from("<I", code, 1)[0] if code[0] == 0xB8 and code[5] == 0xC3 else None


def episode_classes(episode, exe=None):
    """{type: dict(object, vtable, id, frame_method, frame_rule)} for the types with a class."""
    exe = exe or Exe()
    vts = vtables(exe)
    out = {}
    for t in range(TYPES):
        obj, _ = struct.unpack("<II", exe.read(CLASS_TABLES[episode] + 8 * t, 8))
        vt = vts.get(obj)
        if not vt:
            continue
        method = exe.u32(vt + 8)
        out[t] = dict(object=obj, vtable=vt, id=class_id(exe, vt), frame_method=method,
                      frame_rule=FRAME_METHODS.get(method))
    return out


def underlays(episode, exe=None):
    """[(class id, state)] of the episode's underlay table, index k-1 for entry k."""
    va = UNDERLAY_TABLES[episode]
    if va is None:
        return []
    exe = exe or Exe()
    data = exe.read(va, 2 * UNDERLAY_ENTRIES)
    return [(data[2 * i], data[2 * i + 1]) for i in range(UNDERLAY_ENTRIES)]


def type_of_class(classes):
    """Class id -> tile type (the game's 0x4c70e0 table: the last type registering the id)."""
    out = {}
    for t, c in sorted(classes.items()):
        if c["id"] is not None:
            out[c["id"]] = t
    return out


if __name__ == "__main__":
    episodes = [int(a) for a in sys.argv[1:]] or list(range(5))
    exe = Exe()
    for ep in episodes:
        print(f"episode {ep}")
        for t, c in episode_classes(ep, exe).items():
            cid = f"{c['id']:#04x}" if c["id"] is not None else "?"
            print(f"  type {t:3d}: class {cid} vtable {c['vtable']:#x} "
                  f"frame {c['frame_method']:#x} {c['frame_rule'] or 'custom'}")
