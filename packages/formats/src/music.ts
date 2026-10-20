/**
 * MUSIC resources (1E05): the episode's instruments and pieces, both songs (room music,
 * see room-tags.ts) and sound effects (the sound table 1E06 and the code name them).
 *
 * Layout as far as needed for the piece names (all five resources agree):
 *   0x00  header: 0x8001, an 8-byte name ("ROBJUN", "ROBOT1", …), more not decoded
 *   0x1a  "MUC1"
 *   0x22  u32 number of instruments, 32 bytes each from 0x30 (name first, 8 bytes)
 *   0x2e  u16 number of pieces, 86 bytes each after the instruments: an 8-byte name
 *         (CP437, zero-padded, e.g. "BRANDUNG", "WÜSTE"), the rest not decoded
 *   then the music data.
 * Pieces are sorted by name. Rooms name their music by these names (tag kind 5).
 */
import { ByteReader } from "./bytes.ts";
import { decodeCp437 } from "./cp437.ts";

const SIGNATURE_AT = 0x1a;
const SIGNATURE = "MUC1";
const INSTRUMENTS_AT = 0x22;
const PIECES_AT = 0x2e;
const TABLE_AT = 0x30;
const INSTRUMENT_SIZE = 32;
const PIECE_SIZE = 86;
/** Names of instruments and pieces (and the room music tag) have 8 bytes. */
export const MUSIC_NAME_LENGTH = 8;

export class MusicFormatError extends Error {
  override name = "MusicFormatError";
}

/** A zero-padded 8-byte name. */
export function musicName(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decodeCp437(bytes.subarray(0, end < 0 ? bytes.length : end));
}

/** The names of the pieces in a MUSIC resource, in their order (sorted by name). */
export function musicPieces(data: Uint8Array): string[] {
  const r = new ByteReader(data, (message) => new MusicFormatError(message));
  r.need(TABLE_AT);
  if (decodeCp437(data.subarray(SIGNATURE_AT, SIGNATURE_AT + 4)) !== SIGNATURE) {
    throw new MusicFormatError(`no ${SIGNATURE} signature`);
  }
  const instruments = r.view.getUint32(INSTRUMENTS_AT, true);
  const count = r.view.getUint16(PIECES_AT, true);
  r.pos = TABLE_AT + instruments * INSTRUMENT_SIZE;
  return Array.from({ length: count }, () => {
    const entry = r.bytes(PIECE_SIZE);
    return musicName(entry.subarray(0, MUSIC_NAME_LENGTH));
  });
}
