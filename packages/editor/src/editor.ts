import {
  type Direction,
  type EpisodeStart,
  type ExitMode,
  Game,
  LOGIC_CELL,
  type LogicRecord,
  MAX_ROOMS,
  NAMED_ROOMS,
  ROOM_CELLS,
  ROOM_NAME_ENTRY,
  type Room,
  type RoomName,
  type RoomTag,
  type Texts,
  encodeCp437,
  exitMode,
  nameRoom,
  parsePe,
  parseTexts,
  readEpisodeStart,
  recordCell,
  roomName,
  roomNameText,
  roomNamesId,
  roomScript,
  withEpisodeStart,
  withExitMode,
  withRoomScript,
  withTextEntry,
} from "@robot/formats";

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
  /** The room's tags before and after (script edits only). */
  tags?: { before: readonly RoomTag[]; after: readonly RoomTag[] };
  /** The room was added (undo removes it). */
  added?: Room;
  /** A text resource before and after (room names). */
  text?: { id: number; before: string; after: string };
}

/** Logic record slots the game can address (0x432fd0 looks up slots below 200). */
export const MAX_RECORD_SLOTS = 200;

/** The highest room id records can lead to (their targets have 10 bits). */
export const MAX_ROOM_ID = 1023;

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
  /** Edited text resources by id, and the last one parsed. */
  private readonly texts = new Map<number, string>();
  private readonly parsed = new Map<number, { source: string; texts: Texts }>();
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

  /** Whether a room or its name differs from the one in the loaded exe (or is new). */
  isEdited(episode: number, id: number): boolean {
    const room = this.room(episode, id);
    const original = this.original(episode, id);
    if (!original) return true;
    const changed =
      room !== original &&
      (!sameCells(room.base, original.base) ||
        !sameCells(room.overlay, original.overlay) ||
        !sameRecords(room.records, original.records) ||
        !sameTags(room.tags, original.tags));
    const resource = roomNamesId(episode);
    const entry = (texts: Texts | undefined) => texts?.entries.get(ROOM_NAME_ENTRY + id)?.join("|");
    const renamed =
      this.texts.has(resource) &&
      entry(this.textEntries(resource)) !== entry(this.game.texts(resource));
    return changed || renamed;
  }

  /** A text resource as edited (see texts.ts), undefined if the exe has none. */
  textSource(id: number): string | undefined {
    return this.texts.get(id) ?? this.game.textSource(id);
  }

  /** The name the game shows for a room, with the edited names. */
  roomName(episode: number, id: number): RoomName | undefined {
    const rooms = this.rooms(episode);
    const resource = roomNamesId(episode);
    if (!this.texts.has(resource)) return this.game.roomName(episode, id, rooms);
    const classes = this.game.episode(episode).classes;
    return roomName(this.textEntries(resource), episode, id, rooms, classes);
  }

  /** The room whose name entry names room `id`, undefined if the game shows no name. */
  nameRoom(episode: number, id: number): number | undefined {
    const room = nameRoom(id, this.rooms(episode), this.game.episode(episode).classes);
    return room < (NAMED_ROOMS[episode] ?? Infinity) ? room : undefined;
  }

  /**
   * Gives room `id` the name `name` (empty: none, the game shows "Szene <id>") in the
   * episode's style (roomNameText); rooms that show the name of a room below change
   * that room's name. One undo step. Throws a RangeError for names the game cannot
   * store or rooms without names.
   */
  setRoomName(episode: number, id: number, name: string): Edit | undefined {
    this.endStroke();
    const named = this.nameRoom(episode, id);
    if (named === undefined)
      throw new RangeError(`rooms from ${NAMED_ROOMS[episode]} on have no name`);
    const resource = roomNamesId(episode);
    const before = this.textSource(resource);
    if (before === undefined) throw new RangeError("the exe has no room names");
    const entry = ROOM_NAME_ENTRY + named;
    const old = this.textEntries(resource)?.entries.get(entry)?.[0];
    const text = name.trim() === "" ? undefined : roomNameText(name, episode, old);
    if (text !== undefined) encodeCp437(text);
    const renamed = withTextEntry(before, entry, text === undefined ? undefined : [text]);
    if (renamed === before) return undefined;
    const step: Edit = {
      episode,
      room: id,
      layer: "base",
      changes: [],
      text: { id: resource, before, after: renamed },
    };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /**
   * Adds room `id` to the episode: a copy of room `from` (cells, records and tags, the
   * script too) or an empty one; one undo step. Throws a RangeError if the id is taken
   * or out of range, or the episode is full.
   */
  addRoom(episode: number, id: number, from?: number): Edit {
    this.endStroke();
    const rooms = this.rooms(episode);
    if (!Number.isInteger(id) || id < 1 || id > MAX_ROOM_ID) {
      throw new RangeError(`room ids go from 1 to ${MAX_ROOM_ID}`);
    }
    if (rooms.some((r) => r.id === id)) throw new RangeError(`room ${id} exists`);
    if (rooms.length >= MAX_ROOMS)
      throw new RangeError(`an episode has at most ${MAX_ROOMS} rooms`);
    const source = from === undefined ? undefined : this.room(episode, from);
    const room: Room = source
      ? {
          id,
          tags: source.tags.map((t) => ({ ...t, ...(t.data ? { data: t.data.slice() } : {}) })),
          base: source.base.slice(),
          overlay: source.overlay.slice(),
          records: source.records.map((r) => ({ ...r, data: r.data.slice() })),
          trailing: source.trailing.slice(),
        }
      : {
          id,
          tags: [],
          base: new Uint16Array(ROOM_CELLS),
          overlay: new Uint16Array(ROOM_CELLS),
          records: [],
          trailing: new Uint8Array(),
        };
    const step: Edit = { episode, room: id, layer: "base", changes: [], added: room };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /** A free room id: the first after `near`, else the first one. */
  freeRoomId(episode: number, near = 0): number | undefined {
    const used = new Set(this.rooms(episode).map((r) => r.id));
    const ids = Array.from({ length: MAX_ROOM_ID }, (_, k) => k + 1);
    return ids.find((k) => k > near && !used.has(k)) ?? ids.find((k) => !used.has(k));
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

  /**
   * Gives the room the script `source` (empty: no script), compiled with the episode's
   * constants and checked against the game's keywords; one undo step. Throws a
   * ScriptError if it does not compile.
   */
  setScript(episode: number, roomId: number, source: string): Edit | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    if (source === roomScript(room)) return undefined;
    const options = {
      constants: this.game.scriptConstants(episode),
      keywords: this.game.scriptKeywords(),
    };
    return this.commitTags(episode, room, withRoomScript(room, source, options).tags);
  }

  /** Sets what the room's exits byte says for one direction; one undo step. */
  setExitMode(
    episode: number,
    roomId: number,
    direction: Direction,
    mode: ExitMode,
  ): Edit | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    if (exitMode(room, direction) === mode) return undefined;
    return this.commitTags(episode, room, withExitMode(room, direction, mode).tags);
  }

  /** Gives a room new tags as one undo step. */
  private commitTags(episode: number, room: Room, tags: readonly RoomTag[]): Edit {
    const step: Edit = {
      episode,
      room: room.id,
      layer: "base",
      changes: [],
      tags: { before: room.tags, after: tags },
    };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  private push(step: Edit): void {
    this.undoStack.push(step);
    this.redoStack.length = 0;
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

  /** The loaded exe with every edited episode's scene and text replaced. */
  save(): Uint8Array {
    const exe = this.build();
    this.saved = this.undoStack.at(-1);
    return exe;
  }

  /**
   * The edited exe in which `episode` starts in room `room`, the hero at `at` (else
   * where the episode puts it), to try the room out in the game.
   */
  testExe(episode: number, room: number, at?: { x: number; y: number }): Uint8Array {
    this.room(episode, room);
    const start: EpisodeStart = { ...(at ?? readEpisodeStart(this.game.image, episode)), room };
    return withEpisodeStart(parsePe(this.build()), episode, start);
  }

  private build(): Uint8Array {
    this.endStroke();
    let exe = this.game.image.data;
    for (const [episode, rooms] of this.edited) {
      exe = new Game(exe).withScene(episode, rooms);
    }
    for (const [id, text] of this.texts) {
      if (text !== this.game.textSource(id)) exe = new Game(exe).withText(id, text);
    }
    return exe;
  }

  /** The parsed entries of a text resource as edited. */
  private textEntries(id: number): Texts | undefined {
    const source = this.textSource(id);
    if (source === undefined) return undefined;
    let known = this.parsed.get(id);
    if (known?.source !== source) {
      known = { source, texts: parseTexts(source) };
      this.parsed.set(id, known);
    }
    return known.texts;
  }

  private apply(edit: Edit, value: (change: CellChange) => number): void {
    if (edit.text) {
      this.texts.set(edit.text.id, value === before ? edit.text.before : edit.text.after);
      return;
    }
    if (edit.added) {
      const rooms = this.writableList(edit.episode).filter((r) => r.id !== edit.room);
      if (value === after) rooms.push(edit.added);
      this.edited.set(
        edit.episode,
        rooms.sort((a, b) => a.id - b.id),
      );
      return;
    }
    const room = this.writable(edit.episode, edit.room);
    for (const change of edit.changes) room[edit.layer][change.index] = value(change);
    if (edit.records) {
      room.records = [...(value === before ? edit.records.before : edit.records.after)];
    }
    if (edit.tags) room.tags = [...(value === before ? edit.tags.before : edit.tags.after)];
  }

  /** Applies a record edit as one undo step. */
  private commit(edit: Edit, room: Room, records: readonly LogicRecord[]): Edit {
    this.endStroke();
    const step = { ...edit, records: { before: room.records, after: records } };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /** The room in the loaded exe, undefined for added rooms. */
  private original(episode: number, id: number): Room | undefined {
    return this.game.episode(episode).rooms.find((r) => r.id === id);
  }

  /** The episode's rooms as an editable list (made on first use). */
  private writableList(episode: number): Room[] {
    let rooms = this.edited.get(episode);
    if (!rooms) {
      rooms = [...this.game.episode(episode).rooms];
      this.edited.set(episode, rooms);
    }
    return rooms;
  }

  /** The room as an editable copy (made on first use). */
  private writable(episode: number, id: number): Room {
    const rooms = this.writableList(episode);
    const i = rooms.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`episode ${episode} has no room ${id}`);
    const room = rooms[i];
    if (room !== this.original(episode, id)) return room;
    const copy = {
      ...room,
      base: room.base.slice(),
      overlay: room.overlay.slice(),
      records: [...room.records],
      tags: [...room.tags],
    };
    rooms[i] = copy;
    return copy;
  }
}

const before = (change: CellChange) => change.before;
const after = (change: CellChange) => change.after;

/** The cell a record shows (what its logic cell looks like). */
export const shownCell = recordCell;

function sameRecords(a: readonly LogicRecord[], b: readonly LogicRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.slot === b[i]?.slot && r.data.every((v, k) => v === b[i]?.data[k]))
  );
}

function sameTags(a: readonly RoomTag[], b: readonly RoomTag[]): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => {
      const u = b[i];
      if (u.kind !== t.kind || u.value !== t.value) return false;
      return (
        (t.data ?? []).length === (u.data ?? []).length &&
        (t.data ?? []).every((v, k) => v === u.data?.[k])
      );
    })
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
