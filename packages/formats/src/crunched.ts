/**
 * CRUNCHED resources: the game's compressed text files (reader at 0x4313b0 / 0x4314b0).
 *
 * Layout:
 *   0x00  90 bytes  symbol table, most frequent character first
 *   0x5a  u16       marker (0x5555 or 0x0501), ignored by the game
 *   0x5c  u16       unpacked size in bytes
 *   0x5e  u16       number of entries the loader expects
 *   0x60  ...       bitstream, read LSB first
 *
 * Prefix codes (bits in stream order):
 *   0 xx         xx != 0  table[xx - 1]        3 bits
 *   0 00 yyyyyy           table[26 + y]        9 bits
 *   1 0 yyy               table[3 + y]         5 bits
 *   1 1 yyyy     y != 0   table[10 + y]        6 bits
 *   1 1 0000 bbbbbbbb     literal byte b      14 bits
 * A decoded 0x7f stands for a line feed.
 */

export const SYMBOL_TABLE_SIZE = 90;
const HEADER_SIZE = SYMBOL_TABLE_SIZE + 6;
const NEWLINE_SYMBOL = 0x7f;

export class CrunchedFormatError extends Error {
  override name = "CrunchedFormatError";
}

export interface Crunched {
  marker: number;
  /** Unpacked size as stored in the header. */
  size: number;
  entryCount: number;
  /**
   * Decoded text in code page 437 with "\n" line endings. Shorter than `size` if the
   * bitstream ends early (all original resources decode completely).
   */
  text: Uint8Array;
}

class BitReader {
  private readonly data: Uint8Array;
  private pos = 0;
  private buf = 0;
  private count = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Reads n <= 24 bits, LSB first; returns undefined at the end of the data. */
  read(n: number): number | undefined {
    while (this.count < n) {
      if (this.pos >= this.data.length) {
        return undefined;
      }
      this.buf |= this.data[this.pos++] << this.count;
      this.count += 8;
    }
    const value = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.count -= n;
    return value;
  }
}

function readSymbol(bits: BitReader, table: Uint8Array): number | undefined {
  if (bits.read(1) === 0) {
    const v = bits.read(2);
    if (v === undefined) return undefined;
    if (v !== 0) return table[v - 1];
    const y = bits.read(6);
    return y === undefined ? undefined : table[26 + y];
  }
  const second = bits.read(1);
  if (second === undefined) return undefined;
  if (second === 0) {
    const y = bits.read(3);
    return y === undefined ? undefined : table[3 + y];
  }
  const v = bits.read(4);
  if (v === undefined) return undefined;
  return v !== 0 ? table[10 + v] : bits.read(8);
}

export function uncrunch(data: Uint8Array): Crunched {
  if (data.length < HEADER_SIZE) {
    throw new CrunchedFormatError(`CRUNCHED data too short: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const table = data.subarray(0, SYMBOL_TABLE_SIZE);
  const marker = view.getUint16(SYMBOL_TABLE_SIZE, true);
  const size = view.getUint16(SYMBOL_TABLE_SIZE + 2, true);
  const entryCount = view.getUint16(SYMBOL_TABLE_SIZE + 4, true);

  const bits = new BitReader(data.subarray(HEADER_SIZE));
  const text = new Uint8Array(size);
  let length = 0;
  while (length < size) {
    const symbol = readSymbol(bits, table);
    if (symbol === undefined) break;
    text[length++] = symbol === NEWLINE_SYMBOL ? 0x0a : symbol;
  }
  return { marker, size, entryCount, text: text.subarray(0, length) };
}
