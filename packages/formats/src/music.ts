/**
 * MUSIC resources (1E05): the episode's instruments and pieces, both songs (room music,
 * see room-tags.ts) and sound effects (the sound table 1E06 and the code name them).
 * The game plays them on an OPL2 (AdLib) emulation (clock 3579545 Hz, 0x444870).
 *
 * Layout (all five resources agree; the loader 0x4447d0 checks the first word and hands
 * the rest from 0x1a to the parser 0x444490, so offsets below count from 0x1a):
 *   0x00  0x8001, an 8-byte name ("ROBJUN", "ROBOT1", …), more the loader ignores
 *   0x1a  "MUC1" (the parser takes "MUC3" too, without pieces)
 *   +0x04 u32 offset of the instruments, u16 their number (+0x08)
 *   +0x10 u32 offset of the pieces, u16 their number (+0x14)
 *   instruments: 32 bytes each, an 8-byte name, then the two FM operators and more
 *   pieces: 86 bytes each:
 *     +0x00 an 8-byte name (CP437, zero-padded, e.g. "BRANDUNG", "WÜSTE")
 *     +0x08 u32 offset of the data, u32 its length (+0x0c)
 *     +0x10 u16, +0x54 u16: timing (not traced)
 *     +0x14 16 channel slots of 4 bytes: bit 0 of byte 0 plays the channel, byte 2 its
 *           instrument (an index into the instruments); channel 15 is the PC speaker's
 *           part (0x443dd7), which reads only the instrument's transpose
 *   the data: each piece a MIDI track (delta times, running status, notes, controllers,
 *   pitch bend, tempo meta events); program changes do nothing (0x4440ee), so the
 *   instruments come from the slots alone. In all five the data follows the pieces
 *   without gaps, in their order (episode I has 5 bytes after it).
 * Pieces are sorted by name, but the game finds them by a linear search (0x444820:
 * the number from 1, which a sound keeps in 7 bits, bit 7 being its `!`). Rooms name
 * their music by these names (tag kind 5).
 */
import { ByteReader, u32le } from "./bytes.ts";
import { decodeCp437 } from "./cp437.ts";

const BASE = 0x1a;
const SIGNATURE = "MUC1";
const INSTRUMENTS_AT = 0x04;
const INSTRUMENT_COUNT_AT = 0x08;
const PIECES_AT = 0x10;
const PIECE_COUNT_AT = 0x14;
const HEADER_SIZE = 0x16;
const INSTRUMENT_SIZE = 32;
const PIECE_SIZE = 86;
const DATA_AT = 0x08;
const LENGTH_AT = 0x0c;
const SLOTS_AT = 0x14;
const SLOTS = 16;
/** Names of instruments and pieces (and the room music tag) have 8 bytes. */
export const MUSIC_NAME_LENGTH = 8;
/** The most pieces: a sound keeps the number in 7 bits (0x438ac3). */
export const MAX_MUSIC_PIECES = 0x7f;
/** The most instruments: a channel slot names one in a byte. */
const MAX_INSTRUMENTS = 0x100;

export class MusicFormatError extends Error {
  override name = "MusicFormatError";
}

/** A zero-padded 8-byte name. */
export function musicName(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decodeCp437(bytes.subarray(0, end < 0 ? bytes.length : end));
}

export interface Music {
  /** The 32-byte entries. */
  instruments: Uint8Array[];
  /** The 86-byte entries and their data. */
  pieces: { name: string; entry: Uint8Array; data: Uint8Array }[];
}

/** The instruments and pieces of a MUSIC resource, as copies. */
export function readMusic(data: Uint8Array): Music {
  const r = new ByteReader(data, (message) => new MusicFormatError(message));
  r.need(BASE + HEADER_SIZE);
  if (decodeCp437(data.subarray(BASE, BASE + 4)) !== SIGNATURE) {
    throw new MusicFormatError(`no ${SIGNATURE} signature`);
  }
  const at = (offset: number) => r.view.getUint32(BASE + offset, true);
  const count = (offset: number) => r.view.getUint16(BASE + offset, true);
  r.pos = BASE + at(INSTRUMENTS_AT);
  // copies (a Node Buffer's slice is a view of it)
  const instruments = Array.from({ length: count(INSTRUMENT_COUNT_AT) }, () =>
    Uint8Array.from(r.bytes(INSTRUMENT_SIZE)),
  );
  r.pos = BASE + at(PIECES_AT);
  const entries = Array.from({ length: count(PIECE_COUNT_AT) }, () =>
    Uint8Array.from(r.bytes(PIECE_SIZE)),
  );
  const pieces = entries.map((entry) => {
    r.pos = BASE + u32le(entry, DATA_AT);
    const name = musicName(entry.subarray(0, MUSIC_NAME_LENGTH));
    return { name, entry, data: Uint8Array.from(r.bytes(u32le(entry, LENGTH_AT))) };
  });
  return { instruments, pieces };
}

/** The names of the pieces in a MUSIC resource, in their order (sorted by name). */
export function musicPieces(data: Uint8Array): string[] {
  return readMusic(data).pieces.map((p) => p.name);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The MUSIC resource `data` with the pieces `names` of the MUSIC resource `source` added
 * at the end, each with the instruments its channels play (one the resource has byte for
 * byte is shared, others are added at the end): the numbers of the pieces it has stay,
 * which sounds and the code may hold. Everything else keeps its bytes; the tables grow
 * and the data moves behind them. Throws a RangeError for a piece `source` lacks or
 * `data` has, or where the pieces or instruments would be too many.
 */
export function withMusicPieces(
  data: Uint8Array,
  source: Uint8Array,
  names: readonly string[],
): Uint8Array {
  const music = readMusic(data);
  const from = readMusic(source);
  const instruments = [...music.instruments];
  const added = names.map((name) => {
    const piece = from.pieces.find((p) => p.name === name);
    if (!piece) throw new RangeError(`the source has no piece ${name}`);
    if (music.pieces.some((p) => p.name === name)) throw new RangeError(`it has ${name} already`);
    const entry = piece.entry.slice();
    for (let slot = 0; slot < SLOTS; slot++) {
      const at = SLOTS_AT + slot * 4;
      const instrument = from.instruments[entry[at + 2]] as Uint8Array | undefined;
      // a slot past the instruments (episode I's speaker parts) points past them anyway
      if ((entry[at] & 1) === 0 || !instrument) continue;
      let index = instruments.findIndex((i) => sameBytes(i, instrument));
      if (index < 0) index = instruments.push(instrument) - 1;
      entry[at + 2] = index;
    }
    return { name, entry, data: piece.data };
  });
  const pieces = [...music.pieces, ...added];
  if (pieces.length > MAX_MUSIC_PIECES)
    throw new RangeError(`${pieces.length} pieces, at most ${MAX_MUSIC_PIECES}`);
  if (instruments.length > MAX_INSTRUMENTS)
    throw new RangeError(`${instruments.length} instruments, at most ${MAX_INSTRUMENTS}`);

  // what lies behind the old tables (the data and anything after it) moves as one
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const oldEnd = BASE + view.getUint32(BASE + PIECES_AT, true) + music.pieces.length * PIECE_SIZE;
  const instrumentsAt = BASE + view.getUint32(BASE + INSTRUMENTS_AT, true);
  if (
    oldEnd !==
    instrumentsAt + (music.instruments.length * INSTRUMENT_SIZE + music.pieces.length * PIECE_SIZE)
  )
    throw new MusicFormatError("the pieces do not follow the instruments");
  const piecesAt = instrumentsAt + instruments.length * INSTRUMENT_SIZE;
  const dataAt = piecesAt + pieces.length * PIECE_SIZE;
  const shift = dataAt - oldEnd;
  const tail = data.subarray(oldEnd);
  const out = new Uint8Array(dataAt + tail.length + added.reduce((n, p) => n + p.data.length, 0));
  const put = new DataView(out.buffer);
  out.set(data.subarray(0, instrumentsAt));
  put.setUint16(BASE + INSTRUMENT_COUNT_AT, instruments.length, true);
  put.setUint32(BASE + PIECES_AT, piecesAt - BASE, true);
  put.setUint16(BASE + PIECE_COUNT_AT, pieces.length, true);
  instruments.forEach((i, n) => {
    out.set(i, instrumentsAt + n * INSTRUMENT_SIZE);
  });
  out.set(tail, dataAt);
  let end = dataAt + tail.length;
  pieces.forEach((piece, n) => {
    const at = piecesAt + n * PIECE_SIZE;
    out.set(piece.entry, at);
    if (n < music.pieces.length) {
      put.setUint32(at + DATA_AT, put.getUint32(at + DATA_AT, true) + shift, true);
    } else {
      out.set(piece.data, end);
      put.setUint32(at + DATA_AT, end - BASE, true);
      end += piece.data.length;
    }
  });
  return out;
}
