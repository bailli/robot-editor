import { Game, LOGIC_CELL, ROOM_CELLS, type Room } from "@robot/formats";

export type Layer = "base" | "overlay";

export interface CellChange {
  index: number;
  before: number;
  after: number;
}

/** One stroke: the cells it changed in one layer of one room. */
export interface Edit {
  episode: number;
  room: number;
  layer: Layer;
  changes: CellChange[];
}

const isLogicCell = (cell: number) => (cell & 0xff) === LOGIC_CELL;

/**
 * The editing model: the rooms of a loaded exe with the user's changes (rooms are
 * copied when first painted, the exe's own stay untouched), undo/redo by stroke, and
 * saving back into a copy of the exe.
 *
 * Logic cells (type 0x7f) point to the room's logic records; they can be neither painted
 * over nor painted, until the editor understands the records.
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
      (!sameCells(room.base, original.base) || !sameCells(room.overlay, original.overlay))
    );
  }

  /** Changes since loading or the last save. */
  get dirty(): boolean {
    return this.undoStack.at(-1) !== this.saved;
  }

  canPaint(room: Room, layer: Layer, index: number, value: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= ROOM_CELLS) return false;
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
    this.apply(edit, (c) => c.before);
    this.redoStack.push(edit);
    return edit;
  }

  redo(): Edit | undefined {
    this.endStroke();
    const edit = this.redoStack.pop();
    if (!edit) return undefined;
    this.apply(edit, (c) => c.after);
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
    const layer = this.writable(edit.episode, edit.room)[edit.layer];
    for (const change of edit.changes) layer[change.index] = value(change);
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
    const copy = { ...room, base: room.base.slice(), overlay: room.overlay.slice() };
    rooms[i] = copy;
    return copy;
  }
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
