import {
  BACKDROP_CLASS,
  DIRECTIONS,
  DOOR_IN_CLASS,
  DOOR_OUT_CLASS,
  type Dealer,
  type Direction,
  EXIT_CELL,
  type EpisodeClasses,
  type EpisodeStart,
  type ExitMode,
  GRID_STEP,
  Game,
  LOGIC_CELL,
  type LogicRecord,
  MAX_ROOMS,
  type Mod,
  type ModChanges,
  NAMED_ROOMS,
  NO_CHANGES,
  OPPOSITE,
  ROOM_CELLS,
  ROOM_HEIGHT,
  ROOM_NAME_ENTRY,
  ROOM_TEXT_SIZE,
  ROOM_WIDTH,
  type Room,
  type RoomName,
  type RoomSettings,
  type RoomTag,
  STAIRS_CLASS,
  type Texts,
  applyMod,
  backdropRoom,
  checkMod,
  dealerCapacity,
  encodeCp437,
  exitMode,
  nameRoom,
  parsePe,
  parseTexts,
  readDealer,
  readEpisodeStart,
  recordCell,
  recordCellOffsets,
  roomChanges,
  roomDescriptionText,
  roomName,
  roomNameText,
  roomNamesId,
  roomScript,
  roomSettings,
  roomTextLength,
  sameDealer,
  sha256,
  textChanges,
  withDealer,
  withEpisodeStart,
  withExitMode,
  withRoomChanges,
  withRoomScript,
  withRoomSettings,
  withTextChanges,
  withTextEntry,
} from "@robot/formats";

export type Layer = "base" | "overlay";

export interface CellChange {
  index: number;
  before: number;
  after: number;
  /** The layer of this cell, if not the edit's (area edits change both). */
  layer?: Layer;
}

/** A rectangle of cells: column, row, width and height. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cells copied from a room (both layers, row by row), with the records of its logic
 * cells, which keep their slots in the room they come from.
 */
export interface Clip {
  episode: number;
  w: number;
  h: number;
  base: Uint16Array;
  overlay: Uint16Array;
  records: LogicRecord[];
}

/** One step to undo: a stroke's cells in one layer of one room, and record changes. */
export interface Edit {
  episode: number;
  room: number;
  layer: Layer;
  changes: CellChange[];
  /** The room's logic records before and after (record edits only). */
  records?: { before: readonly LogicRecord[]; after: readonly LogicRecord[] };
  /** The room's tags before and after (script, exits and settings edits). */
  tags?: { before: readonly RoomTag[]; after: readonly RoomTag[] };
  /** The room was added (undo removes it). */
  added?: Room;
  /** The room was removed (undo puts it back). */
  removed?: Room;
  /** A text resource before and after (room names). */
  text?: { id: number; before: string; after: string };
  /** The episode's dealer before and after (its goods). */
  dealer?: { before: Dealer; after: Dealer };
  /** Steps done and undone together, in this order (the edit's own fields: the first's). */
  parts?: Edit[];
}

/** A room next to a room id on the grid, and how its exit towards that id stands. */
export interface GridNeighbour {
  direction: Direction;
  room: number;
  /** The neighbour's exits byte towards the id ("neighbour": it leads there). */
  mode: ExitMode;
}

/** Logic record slots the game can address (0x432fd0 looks up slots below 200). */
export const MAX_RECORD_SLOTS = 200;

/** What a new room holds (Editor.addRoom). */
export type NewRoomContent =
  | "empty"
  | "interior"
  | { interior: { stairs: number } }
  | { walls: number; exits: number }
  | { copy: number };

/** What Editor.interiorOf finds for a new room's interior. */
export interface Interior {
  /** The room 100 below, whose doors and stairs lead in. */
  above: number;
  /** The room the game draws around it (backdropRoom), if any. */
  backdrop: number | undefined;
  doors: number;
  stairs: number;
}

/** The class of barriers (tile 0x55: "Eine Barriere für unvorsichtige Abenteurer"). */
export const BARRIER_CLASS = 100;

/**
 * Classes of walls, by the episodes' descriptions: walls (6: "Diese Mauer kann keiner
 * überwinden", 199: "ein Stück Mauer"), rock (93: "Gestein, Fels, Gemäuer"), episode IV's
 * walls (215, 216: "Mauern aus einer Art Kunststoff").
 */
export const WALL_CLASSES: readonly number[] = [6, 93, 199, 215, 216];

/**
 * The cells of a room's walls: the top two rows (row 0 lies under the status line), the
 * bottom row and the outer columns.
 */
const RING: readonly number[] = Array.from({ length: ROOM_CELLS }, (_, i) => i).filter((i) => {
  const [x, y] = [i % ROOM_WIDTH, Math.floor(i / ROOM_WIDTH)];
  return y <= 1 || y === ROOM_HEIGHT - 1 || x === 0 || x === ROOM_WIDTH - 1;
});

/** The exits of a walled room, as most Junior and I rooms have them: five cells per edge. */
const EXIT_GAPS: readonly number[] = [
  ...[17, 18, 19, 20, 21].flatMap((x) => [ROOM_WIDTH + x, (ROOM_HEIGHT - 1) * ROOM_WIDTH + x]),
  ...[12, 13, 14, 15, 16].flatMap((y) => [y * ROOM_WIDTH, y * ROOM_WIDTH + ROOM_WIDTH - 1]),
];

/** The cells whose class 99 gives a room its backdrop: (0, 1) and (39, 1). */
const BACKDROP_MARKS: readonly number[] = [ROOM_WIDTH, 2 * ROOM_WIDTH - 1];

/** A room filled with the class 99 tile (state 0). */
function interiorFiller(classes: EpisodeClasses): Uint16Array {
  return new Uint16Array(ROOM_CELLS).fill(classes.typeOfClass.get(BACKDROP_CLASS) ?? 0);
}

/** Stairs down (class 71, state 0). */
function stairsDown(classes: EpisodeClasses): number {
  return classes.typeOfClass.get(STAIRS_CLASS) ?? 0;
}

/** A way into an interior: a building's door or stairs down, at a cell of room id - 100. */
interface InteriorPassage {
  kind: "door" | "stairs";
  cell: number;
  layer: Layer;
  value: number;
  /** Rows the hero walks on through a door: -1 north (state 6), 1 south (state 7). */
  dy: number;
}

/** The doors into buildings (class 98, states 6 and 7) and stairs down of a room. */
function interiorPassages(room: Room, classes: EpisodeClasses): InteriorPassage[] {
  const found: InteriorPassage[] = [];
  for (const layer of ["base", "overlay"] as const) {
    room[layer].forEach((value, cell) => {
      const id = classes.classes.get(value & 0xff)?.id;
      const state = (value >> 8) & 0xf;
      if (id === DOOR_IN_CLASS && (state === 6 || state === 7)) {
        found.push({ kind: "door", cell, layer, value, dy: state === 6 ? -1 : 1 });
      } else if (id === STAIRS_CLASS && !((value >> 8) & 1)) {
        found.push({ kind: "stairs", cell, layer, value, dy: 0 });
      }
    });
  }
  return found;
}

/** The title screen; its script is the episode's global one. */
const TITLE_ROOM = 1;

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
 *
 * With a mod (mod.ts), the editor works on its base: the pristine exe with the changes
 * it does not edit (tile types, events, code, text copies, the start) applied. The
 * mod's rooms, texts and dealers are where editing starts; saveMod gives them back with
 * the edits, as the differences to the base.
 */
export class Editor {
  private readonly edited = new Map<number, Room[]>();
  /** Edited text resources by id, and the last one parsed. */
  private readonly texts = new Map<number, string>();
  private readonly parsed = new Map<number, { source: string; texts: Texts }>();
  /** Edited dealers by episode. */
  private readonly dealers = new Map<number, Dealer>();
  private readonly undoStack: Edit[] = [];
  private readonly redoStack: Edit[] = [];
  private stroke: Edit | undefined;
  /** The last stroke applied when saved (state identity: strokes are unique). */
  private saved: Edit | undefined;

  /** The exe as edited: the loaded one, or with a mod its base (see above). */
  readonly game: Game;
  /** The exe as loaded, which mods apply to. */
  readonly pristine: Game;
  /** The loaded mod's name, author, description and the changes the editor keeps. */
  private readonly mod: Omit<Mod, "base">;

  constructor(game: Game, mod?: Mod) {
    this.pristine = game;
    if (!mod) {
      this.game = game;
      this.mod = { name: "", author: "", description: "", changes: NO_CHANGES };
      return;
    }
    const { tileTypes, events, code, copyTexts, start, rooms, texts, dealer } = mod.changes;
    const kept: ModChanges = { ...NO_CHANGES, tileTypes, events, code, copyTexts, start };
    this.game = new Game(applyMod(game.image, { ...mod, changes: kept }));
    this.mod = { ...mod, changes: kept };
    for (const episode of new Set(rooms.map((c) => c.episode))) {
      const set = rooms.filter((c) => c.episode === episode);
      this.edited.set(episode, withRoomChanges(this.game.episode(episode).rooms, set));
    }
    for (const resource of new Set(texts.map((c) => c.resource))) {
      const source = this.game.textSource(resource);
      if (source === undefined) throw new RangeError(`the exe has no text resource ${resource}`);
      const set = texts.filter((c) => c.resource === resource);
      this.texts.set(resource, withTextChanges(source, set));
    }
    for (const { episode, goods, most } of dealer) {
      const problem = this.dealerProblem(episode, { goods, most });
      if (problem) throw new RangeError(`episode ${episode}'s dealer: ${problem}`);
      this.dealers.set(episode, { goods, most });
    }
  }

  rooms(episode: number): readonly Room[] {
    return this.edited.get(episode) ?? this.game.episode(episode).rooms;
  }

  hasRoom(episode: number, id: number): boolean {
    return this.rooms(episode).some((r) => r.id === id);
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

  /** The episode's dealer as edited, undefined if the episode has none (episode III). */
  dealer(episode: number): Dealer | undefined {
    return this.dealers.get(episode) ?? readDealer(this.game.image, episode);
  }

  /** How many goods the episode's dealer can sell (dealerCapacity; 0: no dealer). */
  dealerCapacity(episode: number): number {
    return dealerCapacity(this.game.image, episode);
  }

  /** Why the episode's dealer cannot sell `dealer` (dealerProblem), undefined if it can. */
  dealerProblem(episode: number, dealer: Dealer): string | undefined {
    try {
      withDealer(this.game.image, episode, dealer, this.game.episode(episode).classes);
    } catch (error) {
      return error instanceof RangeError ? error.message : String(error);
    }
    return undefined;
  }

  /**
   * Gives the episode's dealer other goods or another number shown at once; one undo
   * step (shown in room `room`). Throws a RangeError for what the game's table cannot
   * hold (dealerProblem).
   */
  setDealer(episode: number, room: number, dealer: Dealer): Edit | undefined {
    this.endStroke();
    const old = this.dealer(episode);
    const problem = this.dealerProblem(episode, dealer);
    if (!old || problem) throw new RangeError(problem ?? "the episode has no dealer");
    if (sameDealer(old, dealer)) return undefined;
    const step: Edit = {
      episode,
      room,
      layer: "base",
      changes: [],
      dealer: {
        before: old,
        after: { goods: dealer.goods.map((g) => ({ ...g })), most: dealer.most },
      },
    };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /** Whether the episode's dealer differs from the base's. */
  isDealerEdited(episode: number): boolean {
    const dealer = this.dealers.get(episode);
    return dealer !== undefined && !sameDealer(dealer, readDealer(this.game.image, episode));
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
    return this.setRoomText(episode, id, (old) =>
      name.trim() === "" ? undefined : roomNameText(name, episode, old),
    );
  }

  /**
   * Gives the name of room `id` the description `description` (lines joined by "\n",
   * empty: none), which the banner shows below the name (roomDescriptionText). One undo
   * step. Throws a RangeError for rooms without a name and texts the game cannot store.
   */
  setRoomDescription(episode: number, id: number, description: string): Edit | undefined {
    return this.setRoomText(episode, id, (old) => {
      if (old === undefined) throw new RangeError("the room has no name to describe");
      return roomDescriptionText(description, episode, old);
    });
  }

  /** Sets the name entry room `id` shows to what `text` makes of the old one. */
  private setRoomText(
    episode: number,
    id: number,
    text: (old: string | undefined) => string | undefined,
  ): Edit | undefined {
    this.endStroke();
    const named = this.nameRoom(episode, id);
    if (named === undefined)
      throw new RangeError(`rooms from ${NAMED_ROOMS[episode]} on have no name`);
    const resource = roomNamesId(episode);
    const before = this.textSource(resource);
    if (before === undefined) throw new RangeError("the exe has no room names");
    const entry = ROOM_NAME_ENTRY + named;
    const set = text(this.textEntries(resource)?.entries.get(entry)?.[0]);
    if (set !== undefined) {
      encodeCp437(set);
      if (roomTextLength(set) >= ROOM_TEXT_SIZE)
        throw new RangeError(`the game reads at most ${ROOM_TEXT_SIZE - 1} characters`);
    }
    const changed = withTextEntry(before, entry, set === undefined ? undefined : [set]);
    if (changed === before) return undefined;
    const step: Edit = {
      episode,
      room: id,
      layer: "base",
      changes: [],
      text: { id: resource, before, after: changed },
    };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /**
   * The rooms next to room id `id` on the grid (where walking off an edge leads, also
   * across floors and rows: id ± 1, ± 10) and their exits towards it.
   */
  gridNeighbours(episode: number, id: number): GridNeighbour[] {
    const rooms = this.rooms(episode);
    return DIRECTIONS.flatMap((direction) => {
      const room = rooms.find((r) => r.id === id + GRID_STEP[direction]);
      return room ? [{ direction, room: room.id, mode: exitMode(room, OPPOSITE[direction]) }] : [];
    });
  }

  /** Why room `id` cannot be added (RangeError messages of addRoom), undefined if it can. */
  roomIdProblem(episode: number, id: number): string | undefined {
    const rooms = this.rooms(episode);
    if (!Number.isInteger(id) || id < 1 || id > MAX_ROOM_ID)
      return `room ids go from 1 to ${MAX_ROOM_ID}`;
    if (this.hasRoom(episode, id)) return `room ${id} exists`;
    if (rooms.length >= MAX_ROOMS) return `an episode has at most ${MAX_ROOMS} rooms`;
    return undefined;
  }

  /**
   * The episode's walls for new rooms, most used first: the wall cells (WALL_CLASSES) on
   * the original rooms' outer ring, e.g. 0x0006 in Junior and I, 0x0026 in II, rock 0x0a4e
   * in IV; at most `count`.
   */
  wallCells(episode: number, count = 6): number[] {
    const { rooms, classes } = this.game.episode(episode);
    const counts = new Map<number, number>();
    for (const room of rooms) {
      for (const i of RING) {
        const cell = room.base[i] ?? 0;
        const id = classes.classes.get(cell & 0xff)?.id;
        if (id !== undefined && WALL_CLASSES.includes(id))
          counts.set(cell, (counts.get(cell) ?? 0) + 1);
      }
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, count)
      .map(([cell]) => cell);
  }

  /**
   * The cells for a new room's exits, the default first: the exit tile (closed until the
   * room's robots are gone) and the barriers (BARRIER_CLASS) the original rooms have on
   * their edges, most used first; barriers come first where the originals use no exit
   * tiles (episode III: the open barrier 0x0055, as at room 141's exit).
   */
  exitCells(episode: number): number[] {
    const { rooms, classes } = this.game.episode(episode);
    let exitTiles = 0;
    const barriers = new Map<number, number>();
    for (const room of rooms) {
      for (const i of RING) {
        const cell = room.base[i] ?? 0;
        if (cell === EXIT_CELL) exitTiles++;
        else if (classes.classes.get(cell & 0xff)?.id === BARRIER_CLASS)
          barriers.set(cell, (barriers.get(cell) ?? 0) + 1);
      }
    }
    const found = [...barriers].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
    return exitTiles > 0 || found.length === 0 ? [EXIT_CELL, ...found] : [...found, EXIT_CELL];
  }

  /**
   * What an interior with id `id` would be (see interiorCells); throws a RangeError if the
   * episode has no class 99 tile (Junior and I) or no room id - 100.
   */
  interiorOf(episode: number, id: number): Interior {
    const { classes } = this.game.episode(episode);
    if (!classes.typeOfClass.has(BACKDROP_CLASS)) {
      throw new RangeError("the episode has no tile that shows the room behind (class 99)");
    }
    const rooms = this.rooms(episode);
    const above = rooms.find((r) => r.id === id - 100);
    if (!above) throw new RangeError(`there is no room ${id - 100} to lead in from`);
    const passages = interiorPassages(above, classes);
    const room = { ...above, id, base: interiorFiller(classes), records: [] };
    return {
      above: above.id,
      backdrop: backdropRoom(episode, room, rooms, classes)?.id,
      doors: passages.filter((p) => p.kind === "door").length,
      stairs: passages.filter((p) => p.kind === "stairs").length,
    };
  }

  /**
   * Why new stairs down cannot go at `cell` of room id - 100 to lead into interior `id`
   * (interiorCells), undefined if they can.
   */
  interiorStairsProblem(episode: number, id: number, cell: number): string | undefined {
    const below = this.rooms(episode).find((r) => r.id === id - 100);
    if (!below) return `there is no room ${id - 100}`;
    if (!inRoom(cell) || cell < ROOM_WIDTH) return "stairs cannot go under the status line";
    if (BACKDROP_MARKS.includes(cell))
      return "(0, 1) and (39, 1) must stay class 99 in the interior";
    if (isLogicCell(below.base[cell]) || isLogicCell(below.overlay[cell]))
      return "the cell belongs to a logic record";
    if (!this.game.episode(episode).classes.typeOfClass.has(STAIRS_CLASS))
      return "the episode has no stairs";
    return undefined;
  }

  /**
   * The cells of a new interior `id`: class 99 everywhere, so the room the game draws
   * behind it shows (backdropRoom) and the hero cannot walk there; at each door into a
   * building in room id - 100 a door out at the same cell, walls beside it and two cells
   * of floor in the direction the hero walks on (doors move him two cells further, as in
   * the originals of episodes II and III); at each of its stairs down, stairs up with
   * floor around them, also at `stairs`, a cell where new stairs down go (addRoom).
   */
  interiorCells(
    episode: number,
    id: number,
    stairs?: number,
  ): { base: Uint16Array; overlay: Uint16Array } {
    this.interiorOf(episode, id);
    const { classes } = this.game.episode(episode);
    const above = this.room(episode, id - 100);
    const base = interiorFiller(classes);
    const overlay = new Uint16Array(ROOM_CELLS);
    const filler = base[0];
    const doorOut = classes.typeOfClass.get(DOOR_OUT_CLASS) ?? 0;
    const wall = this.wallCells(episode, 1).at(0) ?? filler;
    const added: InteriorPassage[] =
      stairs === undefined
        ? []
        : [{ kind: "stairs", cell: stairs, layer: "base", value: stairsDown(classes), dy: 0 }];
    const passages = [...interiorPassages(above, classes), ...added].filter(
      (p) => !BACKDROP_MARKS.includes(p.cell),
    );
    // the passages first: doors side by side keep each other
    for (const p of passages) {
      if (p.kind === "door") base[p.cell] = doorOut;
      else if (p.layer === "base") base[p.cell] = p.value | 0x100;
      else {
        base[p.cell] = 0;
        overlay[p.cell] = p.value | 0x100;
      }
    }
    const set = (x: number, y: number, value: number) => {
      const i = y * ROOM_WIDTH + x;
      if (x < 0 || x >= ROOM_WIDTH || y < 1 || y >= ROOM_HEIGHT) return;
      if (base[i] === filler && !BACKDROP_MARKS.includes(i)) base[i] = value;
    };
    for (const p of passages) {
      const [x, y] = [p.cell % ROOM_WIDTH, Math.floor(p.cell / ROOM_WIDTH)];
      if (p.kind === "door") {
        set(x - 1, y, wall);
        set(x + 1, y, wall);
        set(x, y + p.dy, 0);
        set(x, y + 2 * p.dy, 0);
      } else {
        for (const [dx, dy] of [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ] as const)
          set(x + dx, y + dy, 0);
      }
    }
    return { base, overlay };
  }

  /**
   * Adds room `id` to the episode: empty, walled (the cell `content.walls` all around with
   * five cells `content.exits` in the middle of each edge, like most rooms of Junior and I:
   * there exit tiles, see exitCells), an interior of room id - 100 (interiorCells; with
   * `interior.stairs` new stairs down at that cell of room id - 100, in the same step)
   * or a copy of room `content.copy` (cells, records and tags, the script too); with `openNeighbours`
   * the grid neighbours whose exits towards it are closed ("none") open them. One undo
   * step. Throws a RangeError if the id is taken or out of range, or the episode is full.
   */
  addRoom(
    episode: number,
    id: number,
    content: NewRoomContent = "empty",
    openNeighbours = false,
  ): Edit {
    this.endStroke();
    const problem = this.roomIdProblem(episode, id);
    if (problem) throw new RangeError(problem);
    const source =
      typeof content === "object" && "copy" in content
        ? this.room(episode, content.copy)
        : undefined;
    const stairs =
      typeof content === "object" && "interior" in content ? content.interior.stairs : undefined;
    if (stairs !== undefined) {
      const stairsProblem = this.interiorStairsProblem(episode, id, stairs);
      if (stairsProblem) throw new RangeError(stairsProblem);
    }
    const interior =
      content === "interior" || stairs !== undefined
        ? this.interiorCells(episode, id, stairs)
        : undefined;
    const base = interior?.base ?? new Uint16Array(ROOM_CELLS);
    if (typeof content === "object" && "walls" in content) {
      if (isLogicCell(content.walls)) throw new RangeError("walls cannot be logic cells");
      for (const i of RING) base[i] = content.walls;
      if (isLogicCell(content.exits)) throw new RangeError("exits cannot be logic cells");
      for (const i of EXIT_GAPS) base[i] = content.exits;
    }
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
          base,
          overlay: interior?.overlay ?? new Uint16Array(ROOM_CELLS),
          records: [],
          trailing: new Uint8Array(),
        };
    const step: Edit = { episode, room: id, layer: "base", changes: [], added: room };
    this.apply(step, after);
    const parts = [step];
    if (stairs !== undefined) {
      const below = this.room(episode, id - 100);
      const down: Edit = {
        episode,
        room: below.id,
        layer: "base",
        changes: [
          {
            index: stairs,
            before: below.base[stairs],
            after: stairsDown(this.game.episode(episode).classes),
          },
        ],
      };
      this.apply(down, after);
      parts.push(down);
    }
    for (const n of openNeighbours ? this.gridNeighbours(episode, id) : []) {
      if (n.mode !== "none") continue;
      const neighbour = this.room(episode, n.room);
      const tags = withExitMode(neighbour, OPPOSITE[n.direction], "neighbour").tags;
      const open: Edit = {
        episode,
        room: n.room,
        layer: "base",
        changes: [],
        tags: { before: neighbour.tags, after: tags },
      };
      this.apply(open, after);
      parts.push(open);
    }
    const edit = parts.length > 1 ? { ...step, parts } : step;
    this.push(edit);
    return edit;
  }

  /**
   * Removes room `id` from the episode; one undo step. Its name and whatever leads to it
   * stay. Throws a RangeError for room 1 (the title screen, its script runs throughout
   * the episode) and the room the episode starts in.
   */
  removeRoom(episode: number, id: number): Edit {
    this.endStroke();
    const room = this.room(episode, id);
    if (id === TITLE_ROOM) throw new RangeError("room 1 is the title screen");
    if (id === readEpisodeStart(this.game.image, episode).room) {
      throw new RangeError(`the episode starts in room ${id}`);
    }
    const step: Edit = { episode, room: id, layer: "base", changes: [], removed: room };
    this.apply(step, after);
    this.push(step);
    return step;
  }

  /**
   * A free room id: the first after `near`, else the first one. Ids ending in 0 are left
   * out, like in the originals (see wrapsRow).
   */
  freeRoomId(episode: number, near = 0): number | undefined {
    const used = new Set(this.rooms(episode).map((r) => r.id));
    const ids = Array.from({ length: MAX_ROOM_ID }, (_, k) => k + 1).filter((k) => !wrapsRow(k));
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

  /** Whether a stroke is open (undo, saving and other edits end it). */
  get stroking(): boolean {
    return this.stroke !== undefined;
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

  /** The cells of an area (cut to the room) with the records their logic cells use. */
  copyArea(episode: number, roomId: number, area: Area): Clip {
    const room = this.room(episode, roomId);
    const { x, y, w, h } = clipArea(area);
    const cells = areaCells({ x, y, w, h });
    const pick = (layer: Uint16Array) => Uint16Array.from(cells, (i) => layer[i] ?? 0);
    const base = pick(room.base);
    const overlay = pick(room.overlay);
    const slots = new Set([...base, ...overlay].filter(isLogicCell).map((c) => c >> 8));
    const records = room.records
      .filter((r) => slots.has(r.slot))
      .map((r) => ({ ...r, data: r.data.slice() }));
    return { episode, w, h, base, overlay, records };
  }

  /** Empties an area in both layers (records of its logic cells go too); one undo step. */
  clearArea(episode: number, roomId: number, area: Area): Edit | undefined {
    const cells = areaCells(clipArea(area));
    return this.writeArea(
      episode,
      roomId,
      cells.map((index) => ({ index, base: 0, overlay: 0 })),
      [],
    );
  }

  /**
   * Puts a clip into a room with its top left cell at (x, y), both layers (cells outside
   * the room are dropped); its logic cells get new records in free slots, the records
   * of logic cells it covers go. One undo step. Throws a RangeError if the records and
   * overlay objects would not fit into the game's table (recordCapacity).
   */
  pasteArea(episode: number, roomId: number, x: number, y: number, clip: Clip): Edit | undefined {
    const writes: { index: number; base: number; overlay: number }[] = [];
    for (let row = 0; row < clip.h; row++) {
      for (let col = 0; col < clip.w; col++) {
        const [cx, cy] = [x + col, y + row];
        if (cx < 0 || cy < 0 || cx >= ROOM_WIDTH || cy >= ROOM_HEIGHT) continue;
        const k = row * clip.w + col;
        writes.push({
          index: cy * ROOM_WIDTH + cx,
          base: clip.base[k] ?? 0,
          overlay: clip.overlay[k] ?? 0,
        });
      }
    }
    return this.writeArea(episode, roomId, writes, clip.records);
  }

  /**
   * Writes cells of both layers as one undo step. Logic cells written refer to the slots
   * of `incoming` and get the records' copies in free slots; records only the overwritten
   * cells used are removed (records no cell refers to, e.g. actors, stay).
   */
  private writeArea(
    episode: number,
    roomId: number,
    writes: readonly { index: number; base: number; overlay: number }[],
    incoming: readonly LogicRecord[],
  ): Edit | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    const written = new Set(writes.map((w) => w.index));
    const remaining = new Set<number>();
    const covered = new Set<number>();
    for (const layer of [room.base, room.overlay]) {
      layer.forEach((cell, i) => {
        if (isLogicCell(cell)) (written.has(i) ? covered : remaining).add(cell >> 8);
      });
    }
    const records = room.records.filter((r) => remaining.has(r.slot) || !covered.has(r.slot));
    // the slots the written logic cells use, in the order they appear
    const wanted = new Set(
      writes
        .flatMap((w) => [w.base, w.overlay])
        .filter(isLogicCell)
        .map((c) => c >> 8),
    );
    const used = new Set(records.map((r) => r.slot));
    const free = Array.from({ length: MAX_RECORD_SLOTS }, (_, k) => k).filter((k) => !used.has(k));
    const slots = new Map<number, number>();
    const added = new Map<number, LogicRecord>();
    for (const slot of wanted) {
      const record = incoming.find((r) => r.slot === slot);
      // the same slot if it is free (pasting where the cells came from changes nothing)
      if (!record || free.length === 0) continue;
      const at = Math.max(0, free.indexOf(slot));
      const to = free[at];
      free.splice(at, 1);
      slots.set(slot, to);
      added.set(to, { ...record, slot: to, data: record.data.slice() });
    }
    // the room's order stays (an unchanged area is no edit): a new record in a slot an
    // overwritten one had takes its place, the others follow
    const kept = new Set(records);
    const inPlace = room.records.flatMap((r) => {
      if (kept.has(r)) return [r];
      const again = added.get(r.slot);
      added.delete(r.slot);
      return again ? [again] : [];
    });
    const appended = [...added.values()].sort((a, b) => a.slot - b.slot);
    records.splice(0, Infinity, ...inPlace, ...appended);
    // a logic cell without its record becomes an empty cell
    const remap = (cell: number) => {
      if (!isLogicCell(cell)) return cell;
      const slot = slots.get(cell >> 8);
      return slot === undefined ? 0 : LOGIC_CELL | (slot << 8);
    };
    const changes: CellChange[] = [];
    const overlay = room.overlay.slice();
    for (const w of writes) {
      for (const layer of ["base", "overlay"] as const) {
        const before = room[layer][w.index] ?? 0;
        const after = remap(w[layer]);
        if (layer === "overlay") overlay[w.index] = after;
        if (before !== after) changes.push({ index: w.index, before, after, layer });
      }
    }
    if (changes.length === 0 && sameRecords(records, room.records)) return undefined;
    if (recordCapacity({ ...room, overlay, records }) < 0) {
      throw new RangeError(
        `the game holds ${MAX_RECORD_SLOTS} records and overlay objects per room`,
      );
    }
    return this.commit({ episode, room: roomId, layer: "base", changes }, room, records);
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
   * logic cell already, the layer is the overlay (the game drops logic cells there, see
   * recordCapacity) or the room has no room for another record.
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
    if (!inRoom(index) || layer === "overlay") return undefined;
    const cell = room[layer][index];
    if (isLogicCell(cell) || recordCapacity(room) < 1) return undefined;
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

  /**
   * Changes the room's darkness, points for the first visit, music or flags (see
   * room-tags.ts); one undo step. Throws a RangeError for values the tags cannot hold.
   */
  setRoomSettings(
    episode: number,
    roomId: number,
    settings: Partial<RoomSettings>,
  ): Edit | undefined {
    this.endStroke();
    const room = this.room(episode, roomId);
    const old = roomSettings(room);
    const changed = (Object.keys(settings) as (keyof RoomSettings)[]).some(
      (key) => settings[key] !== undefined && settings[key] !== old[key],
    );
    if (!changed) return undefined;
    return this.commitTags(episode, room, withRoomSettings(room, settings).tags);
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

  /**
   * The mod: the loaded one's changes the editor does not edit, and the rooms and text
   * entries that differ from the base. A text entry written here replaces its copy.
   */
  saveMod(): Mod {
    this.endStroke();
    const rooms = [...this.edited].flatMap(([episode, list]) =>
      roomChanges(episode, this.game.episode(episode).rooms, list),
    );
    const texts = [...this.texts].flatMap(([id, source]) =>
      textChanges(id, this.game.textSource(id) ?? "", source),
    );
    const written = new Set(texts.map((t) => `${t.resource} ${t.entry}`));
    const copyTexts = this.mod.changes.copyTexts
      .map((c) => ({
        ...c,
        entries: c.entries.filter(([to]) => !written.has(`${c.resource} ${to}`)),
      }))
      .filter((c) => c.entries.length > 0);
    const dealer = [...this.dealers]
      .filter(([episode]) => this.isDealerEdited(episode))
      .map(([episode, { goods, most }]) => ({ episode, goods, most }));
    const mod: Mod = {
      ...this.mod,
      base: sha256(this.pristine.image.data),
      changes: { ...this.mod.changes, dealer, copyTexts, texts, rooms },
    };
    checkMod(mod);
    this.saved = this.undoStack.at(-1);
    return mod;
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
    for (const [episode, dealer] of this.dealers) {
      if (this.isDealerEdited(episode)) exe = withDealer(parsePe(exe), episode, dealer);
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
    if (edit.parts) {
      for (const part of value === after ? edit.parts : edit.parts.toReversed()) {
        this.apply(part, value);
      }
      return;
    }
    if (edit.text) {
      this.texts.set(edit.text.id, value === before ? edit.text.before : edit.text.after);
      return;
    }
    if (edit.dealer) {
      this.dealers.set(edit.episode, value === before ? edit.dealer.before : edit.dealer.after);
      return;
    }
    const present = value === after ? edit.added : edit.removed;
    if (edit.added || edit.removed) {
      const rooms = this.writableList(edit.episode).filter((r) => r.id !== edit.room);
      if (present) rooms.push(present);
      this.edited.set(
        edit.episode,
        rooms.sort((a, b) => a.id - b.id),
      );
      return;
    }
    const room = this.writable(edit.episode, edit.room);
    for (const change of edit.changes) {
      room[change.layer ?? edit.layer][change.index] = value(change);
    }
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

/**
 * How many more records fit into the room in the game: on loading it the game turns
 * every overlay object into a record of its own on the base cell (0x4327c4; a logic
 * cell in the overlay is dropped), in a table of MAX_RECORD_SLOTS entries.
 */
export function recordCapacity(room: Room): number {
  const objects = room.overlay.reduce((n, cell) => n + Number(cell !== 0), 0);
  return MAX_RECORD_SLOTS - room.records.length - objects;
}

/**
 * Whether a room id ends in 0. Walking off an edge adds ±1 or ±10 to the id, rows or not:
 * west of room 50 is room 49, at the end of the row above (tried in the game), and east
 * of 49 is 50. No original room id ends in 0 (but for episode II's 600, which no grid
 * exit reaches), so rows never connect at their ends.
 */
export function wrapsRow(id: number): boolean {
  return id % 10 === 0;
}

/** An area cut to the room (empty if it lies outside). */
export function clipArea(area: Area): Area {
  const x = Math.max(0, area.x);
  const y = Math.max(0, area.y);
  const w = Math.max(0, Math.min(ROOM_WIDTH, area.x + area.w) - x);
  const h = Math.max(0, Math.min(ROOM_HEIGHT, area.y + area.h) - y);
  return { x, y, w, h };
}

/** The cell indices of an area inside the room, row by row. */
export function areaCells(area: Area): number[] {
  const cells: number[] = [];
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) cells.push(y * ROOM_WIDTH + x);
  }
  return cells;
}

/** The area spanned by two cells (both included). */
export function areaBetween(a: number, b: number): Area {
  const [ax, ay] = [a % ROOM_WIDTH, Math.floor(a / ROOM_WIDTH)];
  const [bx, by] = [b % ROOM_WIDTH, Math.floor(b / ROOM_WIDTH)];
  const [x, y] = [Math.min(ax, bx), Math.min(ay, by)];
  return { x, y, w: Math.abs(ax - bx) + 1, h: Math.abs(ay - by) + 1 };
}

/**
 * The cells a fill starting at `index` changes: the cell and its neighbours (up, down,
 * left, right) of the same value in that layer, within `within` if given. Logic cells are
 * never filled.
 */
export function fillRegion(room: Room, layer: Layer, index: number, within?: Area): number[] {
  const cells = room[layer];
  if (!inRoom(index) || isLogicCell(cells[index])) return [];
  const value = cells[index];
  const inside = (i: number) => {
    if (!within) return true;
    const [x, y] = [i % ROOM_WIDTH, Math.floor(i / ROOM_WIDTH)];
    return x >= within.x && x < within.x + within.w && y >= within.y && y < within.y + within.h;
  };
  if (!inside(index)) return [];
  const seen = new Set([index]);
  const todo = [index];
  for (let i = todo.pop(); i !== undefined; i = todo.pop()) {
    const x = i % ROOM_WIDTH;
    const next = [
      i - ROOM_WIDTH,
      i + ROOM_WIDTH,
      x > 0 ? i - 1 : -1,
      x < ROOM_WIDTH - 1 ? i + 1 : -1,
    ];
    for (const n of next) {
      if (n < 0 || n >= ROOM_CELLS || seen.has(n) || cells[n] !== value || !inside(n)) continue;
      seen.add(n);
      todo.push(n);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

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

/**
 * The distinct cell values of a layer over all rooms of an episode, logic cells excluded;
 * the base layer adds the cells its logic records hold (recordCellOffsets), e.g. what a
 * teleporter shows, which may lie nowhere else.
 */
export function tilesOf(rooms: readonly Room[], layer: Layer): number[] {
  const values = new Set<number>([0]);
  for (const room of rooms) {
    for (const cell of room[layer]) if (!isLogicCell(cell)) values.add(cell);
    if (layer !== "base") continue;
    for (const { data } of room.records) {
      for (const at of recordCellOffsets(data[0])) {
        const cell = data[at] | (data[at + 1] << 8);
        if (!isLogicCell(cell)) values.add(cell);
      }
    }
  }
  return [...values].sort((a, b) => (a & 0xff) - (b & 0xff) || a - b);
}
