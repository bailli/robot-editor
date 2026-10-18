#!/usr/bin/env python3
"""Find and replace resources in GameOfRobot.exe (a copy of it), without rebuilding the PE.

replace_resource() writes new data over the old data in place and updates the size in
the resource data entry, so the new data must not be larger than the old.
"""
import struct


def _sections(d):
    pe, = struct.unpack_from("<I", d, 0x3C)
    count, = struct.unpack_from("<H", d, pe + 6)
    opt_size, = struct.unpack_from("<H", d, pe + 20)
    opt = pe + 24
    rsrc_rva, rsrc_size = struct.unpack_from("<II", d, opt + 96 + 2 * 8)
    sections = []
    for i in range(count):
        h = opt + opt_size + i * 40
        vsize, va, raw_size, raw_off = struct.unpack_from("<IIII", d, h + 8)
        sections.append((va, max(vsize, raw_size), raw_off))
    return sections, rsrc_rva


def _rva_to_offset(sections, rva):
    for va, size, raw in sections:
        if va <= rva < va + size:
            return raw + rva - va
    raise ValueError(f"RVA {rva:#x} not in any section")


def _name(d, base, field):
    if field & 0x80000000:
        p = base + (field & 0x7FFFFFFF)
        n, = struct.unpack_from("<H", d, p)
        return d[p + 2:p + 2 + 2 * n].decode("utf-16le")
    return field


def find_resource(d, rtype, name):
    """(offset of the data entry, offset of the data, size) of the first language."""
    sections, rsrc_rva = _sections(d)
    base = _rva_to_offset(sections, rsrc_rva)

    def entries(offset):
        named, ids = struct.unpack_from("<HH", d, base + offset + 12)
        for i in range(named + ids):
            field, target = struct.unpack_from("<II", d, base + offset + 16 + 8 * i)
            yield _name(d, base, field), target

    for t, tdir in entries(0):
        if t != rtype:
            continue
        for n, ndir in entries(tdir & 0x7FFFFFFF):
            if n != name:
                continue
            for _lang, entry in entries(ndir & 0x7FFFFFFF):
                entry_off = base + entry
                rva, size = struct.unpack_from("<II", d, entry_off)
                return entry_off, _rva_to_offset(sections, rva), size
    raise KeyError(f"resource {rtype}/{name} not found")


def replace_resource(d, rtype, name, data):
    """Return a copy of the exe bytes `d` with resource rtype/name replaced by `data`."""
    entry_off, data_off, size = find_resource(d, rtype, name)
    if len(data) > size:
        raise ValueError(f"{rtype}/{name}: new data ({len(data)} bytes) larger than old ({size})")
    out = bytearray(d)
    out[data_off:data_off + size] = data + bytes(size - len(data))
    struct.pack_into("<I", out, entry_off + 4, len(data))
    return bytes(out)
