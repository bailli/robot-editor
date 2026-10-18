#!/usr/bin/env python3
"""Decode a CRUNCHED resource from GameOfRobot.exe into plain text.

Format (reimplemented from the reader at 0x4313b0 / 0x4314b0):
  0x00  90 bytes   symbol table, most frequent character first
  0x5a  u16        marker / flags (0x5555 or 0x0501), ignored by the reader
  0x5c  u16        unpacked size in bytes
  0x5e  u16        number of entries (records the loader expects)
  0x60  ...        bitstream, read LSB-first

Prefix codes (bits listed in stream order):
  0 xx         xx != 0   -> table[xx - 1]           (3 symbols,  3 bits)
  0 00 yyyyyy            -> table[26 + y]           (64 symbols, 9 bits)
  1 0 yyy                -> table[3 + y]            (8 symbols,  5 bits)
  1 1 yyyy     y != 0    -> table[10 + y]           (15 symbols, 6 bits)
  1 1 0000 bbbbbbbb      -> literal byte b          (14 bits)
Symbol 0x7f decodes to '\\n'. The first decoded line is a header that the
loader skips.
"""
import struct
import sys


class BitReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0
        self.buf = 0
        self.nbits = 0

    def bits(self, n):
        while self.nbits < n:
            if self.pos >= len(self.data):
                raise EOFError
            self.buf |= self.data[self.pos] << self.nbits
            self.pos += 1
            self.nbits += 8
        v = self.buf & ((1 << n) - 1)
        self.buf >>= n
        self.nbits -= n
        return v


def uncrunch(data):
    table = data[:90]
    marker, size, count = struct.unpack_from("<HHH", data, 90)
    br = BitReader(data[96:])
    out = bytearray()
    try:
        while len(out) < size:
            if br.bits(1) == 0:
                v = br.bits(2)
                c = table[v - 1] if v else table[26 + br.bits(6)]
            elif br.bits(1) == 0:
                c = table[3 + br.bits(3)]
            else:
                v = br.bits(4)
                c = table[10 + v] if v else br.bits(8)
            out.append(0x0A if c == 0x7F else c)
    except EOFError:
        pass
    return marker, size, count, bytes(out)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        marker, size, count, text = uncrunch(open(path, "rb").read())
        sys.stderr.write(f"{path}: marker={marker:#06x} size={size} entries={count} decoded={len(text)}\n")
        sys.stdout.buffer.write(text)
