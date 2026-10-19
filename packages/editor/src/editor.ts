import { Game, LOGIC_CELL, type LogicRecord, ROOM_CELLS, type Room } from "@robot/formats";

export type Layer = "base" | "overlay";

export interface CellChange {
  index: number;
  before: number;
  after: number;
}

/** One step to undo: a stroke's cells in one layer of one room, and record changes. */
export interface Edit {
  episode: number;
  room: number;
  layer: Layer;
  changes: CellChange[];
  /** The room's logic records before and after (record edits only). */
  records?: { before: readonly LogicRecord[]; after: readonly LogicRecord[] };
}

/** Logic record slots the game can address (0x432fd0 looks up slots below 200). */
export const MAX_RECORD_SLOTS = 200;

/** Record type whose shown cell is at offset 4 (the others: offset 2). */
const CELL_AT_4 = 1;

const isLogicCell = (cell: number) => (cell & 0xff) === LOGIC_CELL;
const inRoom = (index: number) => Number.isInteger(index) && index >= 0 && index < ROOM_CELLS;

/**
 * The editing model: the rooms of a loaded exe with the user's changes (rooms are
 * copied when first painted, the exe's own stay untouched), undo/redo by stroke, and
 * saving back into a copy of the exe.
 *
 * Logic cells (type 0x7f) point to the room's logic records: painting skips them; records
 * are added, changed and removed with the record operations, each one undo step.
 */
export class Editor {
  private readonly edited = new Map<number, Room[]>();
  private readonly undoStack: Edit[] = [];
  private readonly redoStack: Edit[] = [];
  private stroke: Edit | undefined;
  /** The last stroke applied when saved (state identity: strokes are unique). */
  private saved: Edit | undefined;

  readonly game: Game;

  constructor(game: Game) {
    this.game = game;
  }

  rooms(episode: number): readonly Room[] {
    return this.edited.get(episode) ?? this.game.episode(episode).rooms;
  }

  room(episode: number, id: number): Room {
    const room = this.rooms(episode).find((r) => r.id === id);
    if (!room) throw new Error(`episode ${episode} has no room ${id}`);
    return room;
  }

  /** Whether a room differs from the one in the loaded exe. */
  isEdited(episode: number, id: number): boolean {
    const room = this.room(episode, id);
    const original = this.game.room(episode, id);
    return (
      room !== original &&
      (!sameCells(room.base, original.base) ||
        !sameCells(room.overlay, original.overlay) ||
        !sameRecords(room.records, original.records))
    );
  }

  /** Changes since loading or the last save. */
  get dirty(): boolean {
    return this.undoStack.at(-1) !== this.saved;
  }

  canPaint(room: Room, layer: Layer, index: number, value: number): boolean {
    if (!inRoom(index)) return false;
    return !isLogicCell(room[layer][index] ?? 0) && !isLogicCell(value);
  }

  beginStroke(episode: number, room: number, layer: Layer): void {
    this.endStroke();
    this.stroke = { episode, room, layer, changes: [] };
  }

  /** Paints one cell in the current stroke; returns whether it changed. */
  paint(index: number, value: number): boolean {
    const stroke = this.stroke;
    if (!stroke) throw new Error("paint outside a stroke");
    const room = this.room(stroke.episode, stroke.room);
    if (!this.canPaint(room, stroke.layer, index, value)) return false;
    const before = room[stroke.layer][index] ?? 0;
    if (before === value) return false;
    this.writable(stroke.episode, stroke.room)[stroke.layer][index] = value;
    const earlier = stroke.changes.find((c) => c.index === index);
    if (earlier) earlier.after = value;
    else stroke.changes.push({ index, before, after: value });
    return true;
  }

  endStroke(): Edit | undefined {
    const stroke = this.stroke;
    this.stroke = undefined;
    if (!stroke || stroke.changes.length === 0) return undefined;
    this.undoStack.push(stroke);
    this.redoStack.length = 0;
    return stroke;
  }

  /** Replaces the data of the record in `slot`. */
  setRecord(episode: number, roomId: number, slot: number, data: Uint8Array): Edit | undefined {
    const room = this.room(episode, roomId);
    const i = room.records.findIndex((r) => r.slot === slot);
    if (i < 0) return undefined;
    const old = room.records[i];
    if (data.length !== old.data.length) return undefined;
    if (old.data.every((b, k) => b === data[k])) return undefined;
    const records = room.records.with(i, { ...old, data: data.slice() });
    return this.commit({ episode, room: roomId, layer: "base", changes: [] }, room, records);
  }

  /**
   * Turns a cell into a logic cell with a new record of `type` that shows the former cell
   * (fields other than the cell are zero). Returns the slot, or undefined if the cell is a
   * logic cell already or the room has no free slot.
   */
  addRecord(
    episode: number,
    roomId: number,
    layer: Layer,
    index: number,
    type: number,
  ): number | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    if (!inRoom(index)) return undefined;
    const cell = room[layer][index];
    if (isLogicCell(cell)) return undefined;
    const used = new Set(room.records.map((r) => r.slot));
    const slot = Array.from({ length: MAX_RECORD_SLOTS }, (_, k) => k).find((k) => !used.has(k));
    if (slot === undefined) return undefined;
    const data = new Uint8Array(10);
    data[0] = type;
    new DataView(data.buffer).setUint16(type === CELL_AT_4 ? 4 : 2, cell, true);
    const records = [...room.records, { slot, data }];
    const changes = [{ index, before: cell, after: LOGIC_CELL | (slot << 8) }];
    this.commit({ episode, room: roomId, layer, changes }, room, records);
    return slot;
  }

  /** Removes the record of a logic cell; the cell becomes the cell the record showed. */
  removeRecord(episode: number, roomId: number, layer: Layer, index: number): Edit | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    if (!inRoom(index)) return undefined;
    const cell = room[layer][index];
    if (!isLogicCell(cell)) return undefined;
    const record = room.records.find((r) => r.slot === cell >> 8);
    const shown = record ? shownCell(record) : 0;
    const stillUsed = [room.base, room.overlay].some((l) =>
      l.some((c, k) => c === cell && !(l === room[layer] && k === index)),
    );
    const records = stillUsed ? room.records : room.records.filter((r) => r !== record);
    const changes = [{ index, before: cell, after: shown }];
    return this.commit({ episode, room: roomId, layer, changes }, room, records);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Reverts the last stroke and returns it (to show where it happened). */
  undo(): Edit | undefined {
    this.endStroke();
    const edit = this.undoStack.pop();
    if (!edit) return undefined;
    this.apply(edit, before);
    this.redoStack.push(edit);
    return edit;
  }

  redo(): Edit | undefined {
    this.endStroke();
    const edit = this.redoStack.pop();
    if (!edit) return undefined;
    this.apply(edit, after);
    this.undoStack.push(edit);
    return edit;
  }

  /** The loaded exe with every edited episode's scene replaced. */
  save(): Uint8Array {
    this.endStroke();
    let exe = this.game.image.data;
    for (const [episode, rooms] of this.edited) {
      exe = new Game(exe).withScene(episode, rooms);
    }
    this.saved = this.undoStack.at(-1);
    return exe;
  }

  private apply(edit: Edit, value: (change: CellChange) => number): void {
    const room = this.writable(edit.episode, edit.room);
    for (const change of edit.changes) room[edit.layer][change.index] = value(change);
    if (edit.records) {
      room.records = [...(value === before ? edit.records.before : edit.records.after)];
    }
  }

  /** Applies a record edit as one undo step. */
  private commit(edit: Edit, room: Room, records: readonly LogicRecord[]): Edit {
    this.endStroke();
    const step = { ...edit, records: { before: room.records, after: records } };
    this.apply(step, after);
    this.undoStack.push(step);
    this.redoStack.length = 0;
    return step;
  }

  /** The room as an editable copy (made on first use). */
  private writable(episode: number, id: number): Room {
    let rooms = this.edited.get(episode);
    if (!rooms) {
      rooms = [...this.game.episode(episode).rooms];
      this.edited.set(episode, rooms);
    }
    const i = rooms.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`episode ${episode} has no room ${id}`);
    const room = rooms[i];
    if (room !== this.game.room(episode, id)) return room;
    const copy = {
      ...room,
      base: room.base.slice(),
      overlay: room.overlay.slice(),
      records: [...room.records],
    };
    rooms[i] = copy;
    return copy;
  }
}

const before = (change: CellChange) => change.before;
const after = (change: CellChange) => change.after;

/** The cell a record shows (what its logic cell looks like). */
export function shownCell(record: LogicRecord): number {
  const at = record.data[0] === CELL_AT_4 ? 4 : 2;
  return new DataView(record.data.buffer, record.data.byteOffset).getUint16(at, true);
}

function sameRecords(a: readonly LogicRecord[], b: readonly LogicRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.slot === b[i]?.slot && r.data.every((v, k) => v === b[i]?.data[k]))
  );
}

function sameCells(a: Uint16Array, b: Uint16Array): boolean {
  return a.every((v, i) => v === b[i]);
}

/** The distinct cell values of a layer over all rooms of an episode, logic cells excluded. */
export function tilesOf(rooms: readonly Room[], layer: Layer): number[] {
  const values = new Set<number>([0]);
  for (const room of rooms)
    for (const cell of room[layer]) if (!isLogicCell(cell)) values.add(cell);
  return [...values].sort((a, b) => (a & 0xff) - (b & 0xff) || a - b);
}
