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
 *
 * The game reads bytes until the resource ends and decodes a symbol only while more than
 * 8 bits are left (0x4314b0), so the last symbols of a stream can get lost; the originals
 * lose a trailing line feed or a few letters of their sound tables. It ignores the size
 * and allocates room for `size` characters and `entries` index entries of the texts it
 * reads (0x438710; see countEntries).
 */

export const SYMBOL_TABLE_SIZE = 90;
const HEADER_SIZE = SYMBOL_TABLE_SIZE + 6;
const NEWLINE_SYMBOL = 0x7f;
const LINE_FEED = 0x0a;
const MARKER = 0x5555;
/** Bits the game wants left in the stream before it decodes another symbol. */
const LOOKAHEAD_BITS = 9;

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

class BitWriter {
  private readonly out: number[] = [];
  private buf = 0;
  private count = 0;
  bits = 0;

  /** Writes the n <= 16 low bits of value, LSB first. */
  write(value: number, n: number): void {
    this.buf |= (value & ((1 << n) - 1)) << this.count;
    this.count += n;
    this.bits += n;
    while (this.count >= 8) {
      this.out.push(this.buf & 0xff);
      this.buf >>>= 8;
      this.count -= 8;
    }
  }

  result(): Uint8Array {
    return Uint8Array.from(this.count > 0 ? [...this.out, this.buf & 0xff] : this.out);
  }
}

/** Writes the code of symbol `s` (see the prefix codes above). */
function writeSymbol(bits: BitWriter, index: ReadonlyMap<number, number>, s: number): void {
  const i = index.get(s);
  if (i === undefined) {
    bits.write(0b11, 2);
    bits.write(0, 4);
    bits.write(s, 8);
  } else if (i < 3) {
    bits.write(0, 1);
    bits.write(i + 1, 2);
  } else if (i < 11) {
    bits.write(0b01, 2);
    bits.write(i - 3, 3);
  } else if (i < 26) {
    bits.write(0b11, 2);
    bits.write(i - 10, 4);
  } else {
    bits.write(0, 3);
    bits.write(i - 26, 6);
  }
}

/**
 * The number of entries the text loader indexes (0x438710 via 0x431300): lines that
 * start with digits and a colon ("1043:"). Sound tables are read differently and store
 * other counts.
 */
export function countEntries(text: Uint8Array): number {
  let count = 0;
  let start = 0;
  while (start < text.length) {
    let i = start;
    while (i < text.length && text[i] >= 0x30 && text[i] <= 0x39) i++;
    if (text[i] === 0x3a) count++;
    const end = text.indexOf(LINE_FEED, start);
    start = end < 0 ? text.length : end + 1;
  }
  return count;
}

/**
 * Compresses text (code page 437, "\n" line endings) into a CRUNCHED resource: the 90
 * most frequent characters in the table, the others as literals. Line feeds are added
 * at the end where the game would otherwise lose characters of the text (see above),
 * so uncrunch returns the text with possibly a few more line feeds.
 */
export function crunch(text: Uint8Array, entryCount = countEntries(text)): Uint8Array {
  if (text.includes(NEWLINE_SYMBOL)) {
    throw new CrunchedFormatError("byte 0x7f cannot be stored: it decodes as a line feed");
  }
  const symbols = Array.from(text, (b) => (b === LINE_FEED ? NEWLINE_SYMBOL : b));
  const counts = new Map<number, number>();
  for (const s of symbols) counts.set(s, (counts.get(s) ?? 0) + 1);
  const table = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, SYMBOL_TABLE_SIZE)
    .map(([s]) => s);
  // the rest of the table: distinct unused bytes (never decoded)
  for (let b = 0; table.length < SYMBOL_TABLE_SIZE; b++) if (!counts.has(b)) table.push(b);
  const index = new Map(table.map((s, i) => [s, i]));

  const bits = new BitWriter();
  for (const s of symbols) writeSymbol(bits, index, s);
  const end = bits.bits;
  let size = symbols.length;
  while (Math.ceil(bits.bits / 8) * 8 - end < LOOKAHEAD_BITS) {
    writeSymbol(bits, index, NEWLINE_SYMBOL);
    size++;
  }
  if (size > 0xffff) throw new RangeError(`text too long for CRUNCHED: ${size} bytes`);
  const stream = bits.result();
  const out = new Uint8Array(HEADER_SIZE + stream.length);
  out.set(table);
  const view = new DataView(out.buffer);
  view.setUint16(SYMBOL_TABLE_SIZE, MARKER, true);
  view.setUint16(SYMBOL_TABLE_SIZE + 2, size, true);
  view.setUint16(SYMBOL_TABLE_SIZE + 4, entryCount, true);
  out.set(stream, HEADER_SIZE);
  return out;
}
