/**
 * Decrypted SCENE data ("SCNV3"): the rooms of one episode (loader at 0x438d10).
 *
 * File:
 *   "SCNV3\x1a\x00"   7-byte signature
 *   per room (at most 200):
 *     u16  room id
 *     u16  tags with bit 15 set: kind = (tag >> 12) & 7, value = tag & 0xfff; the loader
 *          keeps kinds 1-5 in the room record (0x28 bytes, zeroed, so a missing tag is 0;
 *          the jump table 0x439068 picks the field):
 *            kind 1  exits byte (+0x15, see exits.ts)
 *            kind 2  darkness, Night 0-100 on entering (+0x14)
 *            kind 3  episode III flags (+0x16): bit 0 re-links the labyrinth's teleporters
 *                    when entered from room 146 (vtable +0x5c, 0x40ca30), bit 1 makes the
 *                    hero dizzy: message 944 after 15 s, once per game (vtable +0x60,
 *                    0x40ca70); the other episodes ignore it
 *            kind 4  points for the first visit / 10 (u32 at +0x18, 0x4392f5)
 *            kind 5  followed by 8 bytes: the background music, a piece of the episode's
 *                    MUSIC resource (e.g. "BRANDUNG", "LAVA"; +0x1c, started looping on
 *                    entering, 0x4393e8; no tag or an unknown piece: silence)
 *            kind 6  followed by u16 length + payload: value 2 = compiled script (+0x10);
 *                    1 = script source and 3 = a save time (Unix time) are not read
 *          Kinds 1-3 are bytes: higher values are cut to their low byte.
 *     u16  map length (bit 15 clear, includes these 2 bytes), then the map body
 *   The loader reads payloads and map bodies into a stack buffer of 19998 bytes without
 *   checking their length (MAX_ROOM_DATA).
 *
 * Map body (decoder at 0x432460):
 *   4 RLE layers of 40 x 29 cells: layer 0/1 = low/high byte of the base cell,
 *   layer 2/3 = low/high byte of the overlay cell. RLE: bytes > 0x80 add (b - 0x80)
 *   to the run length (they chain), 0x80 escapes the next byte, then one value byte;
 *   run length 0 means 1.
 *   Then 11-byte logic records while at least 11 bytes remain: u8 slot, 10 bytes data.
 *   Slot 0xfe means a u32 follows and the record is an actor (slot 0xff).
 *   A cell with low byte 0x7f places the record whose slot is the cell's high byte.
 *   Bytes left over after the records make the game show a decode error, but it still
 *   loads the room; they are kept in Room.trailing.
 */
import { ByteReader } from "./bytes.ts";

export const ROOM_WIDTH = 40;
export const ROOM_HEIGHT = 29;
export const ROOM_CELLS = ROOM_WIDTH * ROOM_HEIGHT;
export const MAX_ROOMS = 200;
export const LOGIC_CELL = 0x7f;
/** The longest tag payload or map body the game can load (0x438d10's buffer). */
export const MAX_ROOM_DATA = 19998;

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
  /** Bytes after the last complete logic record (empty in all original scenes). */
  trailing: Uint8Array;
}

export class SceneFormatError extends Error {
  override name = "SceneFormatError";
}

function reader(data: Uint8Array, pos = 0): ByteReader {
  return new ByteReader(data, (message) => new SceneFormatError(message), pos);
}

function unpackLayer(r: ByteReader): Uint8Array {
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

export function parseRoomMap(
  body: Uint8Array,
): Pick<Room, "base" | "overlay" | "records" | "trailing"> {
  const r = reader(body);
  const [l0, l1, l2, l3] = [unpackLayer(r), unpackLayer(r), unpackLayer(r), unpackLayer(r)];
  const base = new Uint16Array(ROOM_CELLS);
  const overlay = new Uint16Array(ROOM_CELLS);
  for (let i = 0; i < ROOM_CELLS; i++) {
    base[i] = l0[i] | (l1[i] << 8);
    overlay[i] = l2[i] | (l3[i] << 8);
  }
  const records: LogicRecord[] = [];
  while (r.remaining >= RECORD_SIZE) {
    const slot = r.data[r.pos];
    if (slot === ACTOR_PREFIX) {
      if (r.remaining < RECORD_SIZE + 4) break;
      r.pos++;
      const extra = r.u32();
      records.push({ slot: ACTOR_SLOT, data: r.bytes(10), extra });
    } else {
      r.pos++;
      records.push({ slot, data: r.bytes(10) });
    }
  }
  return { base, overlay, records, trailing: r.rest().slice() };
}

export function parseScene(data: Uint8Array): Room[] {
  if (data.length < HEADER_SIZE || SIGNATURE.some((b, i) => data[i] !== b)) {
    throw new SceneFormatError("missing SCNV3 signature (is the scene still encrypted?)");
  }
  const r = reader(data, HEADER_SIZE);
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

/** Growable little-endian byte buffer for the writers. */
class ByteWriter {
  private buf = new Uint8Array(4096);
  length = 0;

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.reserve(1);
    this.buf[this.length++] = v;
  }

  u16(v: number): void {
    this.u8(v & 0xff);
    this.u8((v >> 8) & 0xff);
  }

  u32(v: number): void {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }

  bytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const MAX_RUN_STEP = 0x7f;

/** RLE as read by unpackLayer: run-length bytes (0x81..0xff, summed), escape 0x80. */
function packLayer(w: ByteWriter, layer: Uint8Array): void {
  for (let i = 0; i < layer.length;) {
    const value = layer[i];
    let run = 1;
    while (i + run < layer.length && layer[i + run] === value) run++;
    i += run;
    if (run > 1) {
      for (let left = run; left > 0; left -= MAX_RUN_STEP)
        w.u8(0x80 + Math.min(left, MAX_RUN_STEP));
    }
    if (value >= 0x80) w.u8(0x80); // escape: a value >= 0x80 would read as a run length
    w.u8(value);
  }
}

/** Encodes a room map body (inverse of parseRoomMap). */
export function encodeRoomMap(
  map: Pick<Room, "base" | "overlay" | "records" | "trailing">,
): Uint8Array {
  if (map.base.length !== ROOM_CELLS || map.overlay.length !== ROOM_CELLS) {
    throw new SceneFormatError(`a room map has ${ROOM_CELLS} cells per layer`);
  }
  const w = new ByteWriter();
  packLayer(
    w,
    Uint8Array.from(map.base, (c) => c & 0xff),
  );
  packLayer(
    w,
    Uint8Array.from(map.base, (c) => c >> 8),
  );
  packLayer(
    w,
    Uint8Array.from(map.overlay, (c) => c & 0xff),
  );
  packLayer(
    w,
    Uint8Array.from(map.overlay, (c) => c >> 8),
  );
  for (const record of map.records) {
    if (record.data.length !== RECORD_SIZE - 1) {
      throw new SceneFormatError(`record data must be ${RECORD_SIZE - 1} bytes`);
    }
    if (record.extra !== undefined) {
      w.u8(ACTOR_PREFIX);
      w.u32(record.extra);
    } else if (record.slot === ACTOR_PREFIX || record.slot === ACTOR_SLOT) {
      throw new SceneFormatError(`slot ${record.slot} is reserved for actor records`);
    } else {
      w.u8(record.slot);
    }
    w.bytes(record.data);
  }
  w.bytes(map.trailing);
  return w.result();
}

/** Serialises rooms to a (decrypted) SCNV3 scene; inverse of parseScene. */
export function serializeScene(rooms: readonly Room[]): Uint8Array {
  if (rooms.length > MAX_ROOMS) throw new SceneFormatError(`more than ${MAX_ROOMS} rooms`);
  const w = new ByteWriter();
  w.bytes(Uint8Array.of(...SIGNATURE, 0));
  for (const room of rooms) {
    w.u16(room.id);
    for (const tag of room.tags) {
      if (tag.kind < 0 || tag.kind > 7 || tag.value < 0 || tag.value > 0xfff) {
        throw new SceneFormatError(`room ${room.id}: invalid tag ${tag.kind}/${tag.value}`);
      }
      w.u16(0x8000 | (tag.kind << 12) | tag.value);
      if (tag.kind === 5) {
        if (tag.data?.length !== 8)
          throw new SceneFormatError(`room ${room.id}: kind 5 tags carry 8 bytes`);
        w.bytes(tag.data);
      } else if (tag.kind === 6) {
        const data = tag.data ?? new Uint8Array();
        if (data.length > MAX_ROOM_DATA) {
          throw new SceneFormatError(
            `room ${room.id}: tag data of ${data.length} bytes, the game loads at most ${MAX_ROOM_DATA}`,
          );
        }
        w.u16(data.length);
        w.bytes(data);
      }
    }
    const body = encodeRoomMap(room);
    if (body.length > MAX_ROOM_DATA) {
      throw new SceneFormatError(
        `room ${room.id}: map of ${body.length} bytes, the game loads at most ${MAX_ROOM_DATA}`,
      );
    }
    w.u16(body.length + 2);
    w.bytes(body);
  }
  return w.result();
}

/** One room as a scene holds it (id, tags, map), without the scene's signature. */
export function serializeRoom(room: Room): Uint8Array {
  return serializeScene([room]).slice(HEADER_SIZE);
}

/** The room serializeRoom wrote. */
export function parseRoom(data: Uint8Array): Room {
  const scene = new Uint8Array(HEADER_SIZE + data.length);
  scene.set(SIGNATURE);
  scene.set(data, HEADER_SIZE);
  const rooms = parseScene(scene);
  if (rooms.length !== 1) throw new SceneFormatError(`${rooms.length} rooms instead of one`);
  return rooms[0];
}

/** Record type whose cell is at data offset 4 (the others: offset 2). */
const CELL_AT_4 = 1;

/** The cell a record holds (type 1: offset 4, the others: offset 2). */
export function recordCell(record: LogicRecord): number {
  const at = record.data[0] === CELL_AT_4 ? 4 : 2;
  return new DataView(record.data.buffer, record.data.byteOffset).getUint16(at, true);
}

/**
 * The cell a logic cell shows: the cell stored in its record (0x433110), followed while
 * that is a logic cell again; 0 if the record is missing. Other cells are returned as
 * they are.
 */
export function resolveCell(room: Pick<Room, "records">, cell: number): number {
  for (let depth = 0; (cell & 0xff) === LOGIC_CELL; depth++) {
    const record = room.records.find((r) => r.slot === cell >> 8);
    if (!record || depth > 8) return 0;
    cell = recordCell(record);
  }
  return cell;
}
