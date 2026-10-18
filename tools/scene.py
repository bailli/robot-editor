#!/usr/bin/env python3
"""Parse a decrypted SCNV3 scene (see descene.py) into rooms.

Scene file (loader at 0x438d10):
  "SCNV3\\x1a\\x00"                7-byte signature
  repeated per room (up to 200):
    u16  room id
    u16  tags with bit 15 set:  kind = (tag >> 12) & 7, value = tag & 0xfff
           kind 1/2/3   byte room properties    (stored at room +0x15/+0x14/+0x16)
           kind 4       word room property      (room +0x18)
           kind 5       + 8 bytes               (room +0x1c)
           kind 6       + u16 length + payload; value 1 = script source,
                        2 = compiled script (the one the game uses), 3 = unknown 4-byte blob
    u16  map length (bit 15 clear, counts these 2 bytes), then the map body

Map body (decoder at 0x432460):
  4 layers of 40 x 29 = 1160 cells, each RLE-packed separately:
    bytes > 0x80 add (b - 0x80) to the run length (they chain: ff cb = 127 + 75),
    0x80 escapes the next byte so values >= 0x80 can be literals,
    then one value byte; run length 0 means 1.
  layer 0 / 1 = low / high byte of the base cell   (low = object type, high = variant/state)
  layer 2 / 3 = low / high byte of an overlay cell, merged onto the base when non-zero
  then object records while >= 11 bytes remain:
    u8 tag; if tag == 0xfe: u32 extra follows and the tag becomes 0xff
    10 bytes data; tag 0xff spawns an actor, other tags are placed objects (type in data[0])
"""
import struct
import sys

W, H = 40, 29
CELLS = W * H


def unrle(m, pos, n=CELLS):
    out = bytearray()
    while len(out) < n:
        run = 0
        while m[pos] > 0x80:
            run += m[pos] - 0x80
            pos += 1
        if m[pos] == 0x80:
            pos += 1
        out += bytes([m[pos]]) * max(run, 1)
        pos += 1
    return out, pos


def parse_map(m):
    pos = 0
    layers = []
    for _ in range(4):
        layer, pos = unrle(m, pos)
        layers.append(layer)
    base = [layers[0][i] | layers[1][i] << 8 for i in range(CELLS)]
    over = [layers[2][i] | layers[3][i] << 8 for i in range(CELLS)]
    objects = []
    while len(m) - pos >= 11:
        tag = m[pos]
        pos += 1
        extra = None
        if tag == 0xFE:
            extra, = struct.unpack_from("<I", m, pos)
            pos += 4
            tag = 0xFF
        objects.append((tag, bytes(m[pos:pos + 10]), extra))
        pos += 10
    return base, over, objects, len(m) - pos


def parse_scene(d):
    assert d[:6] == b"SCNV3\x1a", d[:8]
    pos = 7
    rooms = []
    while pos + 2 <= len(d):
        rid, = struct.unpack_from("<H", d, pos)
        pos += 2
        props, blobs, tags = {}, {}, []
        while True:
            w, = struct.unpack_from("<H", d, pos)
            pos += 2
            if not w & 0x8000:
                break
            kind, val = (w >> 12) & 7, w & 0xFFF
            data = None
            if kind == 5:
                data = props[5] = d[pos:pos + 8]
                pos += 8
            elif kind == 6:
                n, = struct.unpack_from("<H", d, pos)
                data = blobs[val] = d[pos + 2:pos + 2 + n]
                pos += 2 + n
            else:
                props[kind] = val
            tags.append((kind, val, data))
        body = d[pos:pos + w - 2]
        pos += w - 2
        base, over, objects, leftover = parse_map(body)
        rooms.append(dict(id=rid, tags=tags, props=props, blobs=blobs, base=base, over=over,
                          objects=objects, leftover=leftover))
    return rooms


def grid(cells, f):
    return "\n".join(" ".join(f(cells[y * W + x]) for x in range(W)) for y in range(H))


def dump(rooms, out):
    for r in rooms:
        blobs = {k: len(v) for k, v in r["blobs"].items()}
        out.write(f"=== room {r['id']}  props={r['props']}  blobs={blobs}\n")
        out.write("-- base type (low byte, hex; tile 7f = logic record, high byte = slot)\n")
        out.write(grid(r["base"], lambda c: f"{c & 0xff:02x}") + "\n")
        if any(c >> 8 for c in r["base"]):
            out.write("-- base variant (high byte)\n")
            out.write(grid(r["base"], lambda c: f"{c >> 8:02x}" if c >> 8 else "..") + "\n")
        if any(r["over"]):
            out.write("-- overlay (low:high)\n")
            out.write(grid(r["over"], lambda c: f"{c:04x}" if c else "....") + "\n")
        for slot, data, extra in r["objects"]:
            out.write(f"-- record slot {slot:3d} type {data[0]:2d}: {data[1:].hex(' ')}"
                      + (f" extra={extra:#x}" if extra is not None else "") + "\n")
        if 1 in r["blobs"]:
            out.write("-- script source\n")
            out.write(r["blobs"][1].rstrip(b"\0").decode("cp437") + "\n")
        out.write("\n")


if __name__ == "__main__":
    if sys.argv[1] == "--dump":
        dump(parse_scene(open(sys.argv[2], "rb").read()), sys.stdout)
        sys.exit()
    for path in sys.argv[1:]:
        rooms = parse_scene(open(path, "rb").read())
        bad = [r["id"] for r in rooms if r["leftover"]]
        nobj = sum(len(r["objects"]) for r in rooms)
        print(f"{path}: {len(rooms)} rooms, {nobj} objects, rooms with leftover bytes: {bad}")
