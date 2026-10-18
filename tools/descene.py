#!/usr/bin/env python3
"""Decrypt a SCENE resource from GameOfRobot.exe (XOR with a 25-byte key).

The key is 25 calls of the Borland-style rand() at 0x436870 after srand(0xC40C),
taking the low byte of each result (set up at 0x4310d0, applied at 0x431120).
Byte i of the resource is XORed with key[i % 25].
"""
import sys


def make_key(seed=0xC40C, n=25):
    key = bytearray()
    for _ in range(n):
        seed = (seed * 0x015A4E35 + 1) & 0xFFFFFFFF
        key.append((seed >> 16) & 0xFF)
    return bytes(key)


KEY = make_key()


def decrypt(data):
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))


if __name__ == "__main__":
    src, dst = sys.argv[1:3]
    open(dst, "wb").write(decrypt(open(src, "rb").read()))
