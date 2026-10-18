/**
 * Decrypted SCENE data ("SCNV3"): the rooms of one episode (loader at 0x438d10).
 *
 * File:
 *   "SCNV3\x1a\x00"   7-byte signature
 *   per room (at most 200):
 *     u16  room id
 *     u16  tags with bit 15 set: kind = (tag >> 12) & 7, value = tag & 0xfff
 *            kind 5  followed by 8 bytes
 *            kind 6  followed by u16 length + payload
 *                    (value 1 = script source, 2 = compiled script, 3 = unknown)
 *     u16  map length (bit 15 clear, includes these 2 bytes), then the map body
 *
 * Map body (decoder at 0x432460):
 *   4 RLE layers of 40 x 29 cells: layer 0/1 = low/high byte of the base cell,
 *   layer 2/3 = low/high byte of the overlay cell. RLE: bytes > 0x80 add (b - 0x80)
 *   to the run length (they chain), 0x80 escapes the next byte, then one value byte;
 *   run length 0 means 1.
 *   Then 11-byte logic records while at least 11 bytes remain: u8 slot, 10 bytes data.
 *   Slot 0xfe means a u32 follows and the record is an actor (slot 0xff).
 *   A cell with low byte 0x7f places the record whose slot is the cell's high byte.
 */

export const ROOM_WIDTH = 40;
export const ROOM_HEIGHT = 29;
export const ROOM_CELLS = ROOM_WIDTH * ROOM_HEIGHT;
export const MAX_ROOMS = 200;
export const LOGIC_CELL = 0x7f;

const SIGNATURE = [0x53, 0x43, 0x4e, 0x56, 0x33, 0x1a] as const; // "SCNV3\x1a"
const HEADER_SIZE = 7;
const RECORD_SIZE = 11;
const ACTOR_PREFIX = 0xfe;
const ACTOR_SLOT = 0xff;

export interface RoomTag {
  kind: number;
  value: number;
  /** Payload of kind 5 (8 bytes) and kind 6 (length-prefixed) tags. */
  data?: Uint8Array;
}

export interface LogicRecord {
  slot: number;
  /** 10 bytes; data[0] is the record type. */
  data: Uint8Array;
  /** Present on actor records (slot 0xff). */
  extra?: number;
}

export interface Room {
  id: number;
  tags: RoomTag[];
  /** ROOM_CELLS cells, row-major; low byte = object type, high byte = variant/state. */
  base: Uint16Array;
  overlay: Uint16Array;
  records: LogicRecord[];
}

export class SceneFormatError extends Error {
  override name = "SceneFormatError";
}

class Reader {
  readonly data: Uint8Array;
  readonly view: DataView;
  pos: number;

  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  need(n: number): void {
    if (this.remaining < n) {
      throw new SceneFormatError(`unexpected end of data at offset ${this.pos} (need ${n} bytes)`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function unpackLayer(r: Reader): Uint8Array {
  const layer = new Uint8Array(ROOM_CELLS);
  let filled = 0;
  while (filled < ROOM_CELLS) {
    let run = 0;
    let b = r.u8();
    while (b > 0x80) {
      run += b - 0x80;
      b = r.u8();
    }
    const value = b === 0x80 ? r.u8() : b;
    const end = Math.min(ROOM_CELLS, filled + Math.max(run, 1));
    layer.fill(value, filled, end);
    filled = end;
  }
  return layer;
}

export function parseRoomMap(body: Uint8Array): Pick<Room, "base" | "overlay" | "records"> {
  const r = new Reader(body);
  const [l0, l1, l2, l3] = [unpackLayer(r), unpackLayer(r), unpackLayer(r), unpackLayer(r)];
  const base = new Uint16Array(ROOM_CELLS);
  const overlay = new Uint16Array(ROOM_CELLS);
  for (let i = 0; i < ROOM_CELLS; i++) {
    base[i] = l0[i] | (l1[i] << 8);
    overlay[i] = l2[i] | (l3[i] << 8);
  }
  const records: LogicRecord[] = [];
  while (r.remaining >= RECORD_SIZE) {
    const slot = r.u8();
    if (slot === ACTOR_PREFIX) {
      const extra = r.u32();
      records.push({ slot: ACTOR_SLOT, data: r.bytes(10), extra });
    } else {
      records.push({ slot, data: r.bytes(10) });
    }
  }
  if (r.remaining !== 0) {
    throw new SceneFormatError(`${r.remaining} stray bytes after the logic records`);
  }
  return { base, overlay, records };
}

export function parseScene(data: Uint8Array): Room[] {
  if (data.length < HEADER_SIZE || SIGNATURE.some((b, i) => data[i] !== b)) {
    throw new SceneFormatError("missing SCNV3 signature (is the scene still encrypted?)");
  }
  const r = new Reader(data, HEADER_SIZE);
  const rooms: Room[] = [];
  while (r.remaining >= 2) {
    if (rooms.length === MAX_ROOMS) {
      throw new SceneFormatError(`more than ${MAX_ROOMS} rooms`);
    }
    const id = r.u16();
    const tags: RoomTag[] = [];
    let word = r.u16();
    while (word & 0x8000) {
      const kind = (word >> 12) & 7;
      const value = word & 0xfff;
      if (kind === 5) {
        tags.push({ kind, value, data: r.bytes(8) });
      } else if (kind === 6) {
        tags.push({ kind, value, data: r.bytes(r.u16()) });
      } else {
        tags.push({ kind, value });
      }
      word = r.u16();
    }
    if (word < 2) {
      throw new SceneFormatError(`room ${id}: invalid map length ${word}`);
    }
    rooms.push({ id, tags, ...parseRoomMap(r.bytes(word - 2)) });
  }
  if (r.remaining !== 0) {
    throw new SceneFormatError("trailing byte after the last room");
  }
  return rooms;
}
