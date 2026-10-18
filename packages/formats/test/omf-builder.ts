/** Builds small synthetic OMF object files for tests. */

function u16(v: number): number[] {
  return [v & 0xff, v >> 8];
}

function name(s: string): number[] {
  return [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
}

export function record(type: number, body: number[]): number[] {
  return [type, ...u16(body.length + 1), ...body, 0]; // checksum byte is not verified
}

export const lnames = (...names: string[]) => record(0x96, names.flatMap(name));

/** SEGDEF with ACBP 0x48 (paragraph-aligned, public), or a custom ACBP prefix. */
export const segdef = (length: number, nameIndex: number, acbp: number[] = [0x48]) =>
  record(0x98, [...acbp, ...u16(length), nameIndex, 0, 0]);

export const pubdef = (segment: number, symbol: string, offset: number) =>
  record(0x90, [0, segment, ...name(symbol), ...u16(offset), 0]);

export const ledata = (segment: number, offset: number, data: number[]) =>
  record(0xa0, [segment, ...u16(offset), ...data]);

/**
 * One FIXUP subrecord: segment-relative fixup at `offset` (within the last LEDATA) of
 * location type `location`, target = segment `target` (frame method 5 = target).
 */
export function fixup(offset: number, location: number, target: number, displacement?: number) {
  const locat = 0x8000 | 0x4000 | (location << 10) | offset;
  const fixData = 0x50 | (displacement === undefined ? 0x04 : 0);
  return [
    locat >> 8,
    locat & 0xff,
    fixData,
    target,
    ...(displacement === undefined ? [] : u16(displacement)),
  ];
}

export const fixupp = (...subrecords: number[][]) => record(0x9c, subrecords.flat());

export function omf(...records: number[][]): Uint8Array {
  return Uint8Array.from([...record(0x80, name("TEST")), ...records.flat(), ...record(0x8a, [0])]);
}
