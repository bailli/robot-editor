#!/usr/bin/env python3
"""Minimal reader for the 16-bit Intel OMF object files stored in SHAPES resources.

Only the record types these files use are handled: THEADR, COMENT, LNAMES, SEGDEF,
GRPDEF, PUBDEF, LEDATA, FIXUPP, MODEND.
"""
import struct
import sys

REC = {0x80: "THEADR", 0x88: "COMENT", 0x8A: "MODEND", 0x8C: "EXTDEF", 0x90: "PUBDEF",
       0x96: "LNAMES", 0x98: "SEGDEF", 0x9A: "GRPDEF", 0x9C: "FIXUPP", 0xA0: "LEDATA"}


def index(b, p):
    """OMF index field: 1 byte, or 2 bytes if the high bit is set."""
    if b[p] & 0x80:
        return ((b[p] & 0x7F) << 8) | b[p + 1], p + 2
    return b[p], p + 1


def records(d):
    pos = 0
    while pos < len(d):
        t = d[pos]
        n, = struct.unpack_from("<H", d, pos + 1)
        yield t, d[pos + 3:pos + 2 + n]  # body without checksum
        pos += 3 + n


class Module:
    def __init__(self, d):
        self.name = None
        self.lnames = [None]
        self.segs = [None]          # (name, length)
        self.publics = []           # (name, seg, offset)
        self.data = {}              # seg index -> bytearray
        self.fixups = []            # (seg, offset, loc, frame, target_kind, target, disp)
        last = None
        for t, b in records(d):
            if t == 0x80:
                self.name = b[1:1 + b[0]].decode("latin-1")
            elif t == 0x96:
                p = 0
                while p < len(b):
                    self.lnames.append(b[p + 1:p + 1 + b[p]].decode("latin-1"))
                    p += 1 + b[p]
            elif t == 0x98:
                length, = struct.unpack_from("<H", b, 1)
                name, _ = index(b, 3)
                self.segs.append((self.lnames[name], length))
                self.data[len(self.segs) - 1] = bytearray(length)
            elif t == 0x90:
                grp, p = index(b, 0)
                seg, p = index(b, p)
                if seg == 0:
                    p += 2
                while p < len(b):
                    name = b[p + 1:p + 1 + b[p]].decode("latin-1")
                    p += 1 + b[p]
                    off, = struct.unpack_from("<H", b, p)
                    _, p = index(b, p + 2)
                    self.publics.append((name, seg, off))
            elif t == 0xA0:
                seg, p = index(b, 0)
                off, = struct.unpack_from("<H", b, p)
                chunk = b[p + 2:]
                self.data[seg][off:off + len(chunk)] = chunk
                last = (seg, off)
            elif t == 0x9C:
                p = 0
                while p < len(b):
                    if not b[p] & 0x80:
                        raise ValueError("THREAD subrecords not supported")
                    locat = (b[p] << 8) | b[p + 1]
                    p += 2
                    loc = (locat >> 10) & 0xF
                    off = locat & 0x3FF
                    fix = b[p]
                    p += 1
                    frame_method = (fix >> 4) & 7
                    target_method = fix & 3
                    if frame_method < 4:
                        frame, p = index(b, p)
                    else:
                        frame = None
                    target, p = index(b, p)
                    disp = 0
                    if not fix & 4:
                        disp, = struct.unpack_from("<H", b, p)
                        p += 2
                    self.fixups.append((last[0], last[1] + off, loc, frame_method,
                                        target_method, target, disp))


if __name__ == "__main__":
    m = Module(open(sys.argv[1], "rb").read())
    print("module", m.name)
    for i, (n, l) in enumerate(m.segs[1:], 1):
        print(f"seg {i} {n} len={l}")
    for p in m.publics:
        print("public", p)
    print(len(m.fixups), "fixups; first:", m.fixups[:8])
