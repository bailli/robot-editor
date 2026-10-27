import {
  ACTOR_LOAD_METHODS,
  BOMB_LOAD_METHOD,
  type EpisodeClasses,
  HATCHING_LOAD_METHODS,
  SAND_DESCRIBE_METHOD,
  SAND_SCORPION_STATES,
} from "./classes.ts";
import { isConditional } from "./exits.ts";
import {
  LOGIC_CELL,
  type LogicRecord,
  ROOM_CELLS,
  ROOM_WIDTH,
  type Room,
  resolveCell,
} from "./scene.ts";

/**
 * The moving actors of a room (robots, androids, animals, the bus, …) and where they come
 * from. The game creates actors with 0x44dc60(kind, x, y, …) when a room is entered or
 * later; the map cell is cleared. Kinds 0x100 + n name a class through the table at
 * 0x47ec98 (ACTOR_KIND_CLASSES); a factory registered for that class (0x44d4e0, 20 of
 * them) creates the actor. Every actor but the hero joins the room's actor list
 * (0x53e9a8, 0x44c140); robots take their `_Aliens` sprite from its length (robotSprite),
 * and in Junior, I and II three random colours (0x445bd0), so they look different on
 * every visit. The other actors are drawn with their class's tile shape (`_Rob_object`,
 * episode vtable +0xc; the registry option AltShapes, off by default, swaps some for those
 * of SHAPES 1003 in Junior and 1903 in I and II).
 *
 * Entering a room (0x42b6f0) goes through rows 1-28 cell by cell: a native or travelling
 * actor record lets its actor appear, then the cell's class gets its room-load method,
 * from the top of the cell down (0x433110: an overlay object lies on the base cell) for
 * as long as the method clears the cell. Row 0, under the status line, is not loaded.
 *
 * Sources:
 *   tile       a cell whose class turns it into an actor on entering (room-load method in
 *              ACTOR_LOAD_METHODS)
 *   hatchery   creatures appear after a while: eggs, snake basket, "something behind the
 *              wall" (HATCHING_LOAD_METHODS)
 *   bomb       its explosion lets robots appear
 *   scorpions  sand heaps (sand states 6, 7) hiding scorpions
 *   spawner    record type 5: robots appear while the hero is near (0x435650)
 *   creature   record type 7: a friendly native (kind 0x107) appears on entering
 *   travelling record type 8: an actor (recordActorKind), in the originals the dealer
 *              or the thief. It walks towards the hero; once the hero dealt with it (a
 *              trade, a theft) it wanders off and, stepping into an edge wall, leaves a
 *              teleporter there for 1-2 s (0x420c30) to the record's room at (x, y): the
 *              hero can follow it. It is not moved into that room.
 * Scripts keep a random number of them (RandObj, see randomPlacement).
 */

export type ActorSource =
  "tile" | "hatchery" | "bomb" | "scorpions" | "spawner" | "creature" | "travelling";

export interface RoomActor {
  source: ActorSource;
  cell: number;
  layer: "base" | "overlay";
  /** The tile type that names the actor (its description, its tile graphic), if known. */
  type: number | undefined;
  /**
   * How many actors the game creates on entering the room before this one (tiles,
   * natives, travelling actors); undefined for actors that appear later.
   */
  order?: number;
  /** The record behind it (spawner, creature, travelling actor). */
  record?: LogicRecord;
  /** Spawners: robots appear while the hero is within this many cells. */
  radius?: number;
  /** Spawners: ticks between robots. */
  period?: number;
  /** Travelling actors: where they head. */
  target?: { room: number; x: number; y: number };
}

/**
 * Actor kinds 0x100..0x10a -> class id (0x47ec98, first dword of 28-byte entries; the code
 * reads nothing else of them, 0x407412 and 0x44c0e2, the other six dwords are unused).
 */
export const ACTOR_KIND_CLASSES: readonly number[] = [
  0x01, 0x02, 0x03, 0x2c, 0x2d, 0x4a, 0xa0, 0x9f, 0xa3, 0xbd, 0xc0,
];

/** Names of the actor kinds 0x100..0x10a (episode III's android is a snake). */
export function actorKindName(kind: number, episode: number): string | undefined {
  const names = [
    "Hero",
    episode === 3 ? "Creature" : "Robot",
    "Hero's double",
    "Dealer",
    episode === 3 ? "Snake" : "Android",
    "Thief",
    "Turtle",
    "Friendly native",
    "Wild boar",
    "Robot",
    "Unknown (tile 0x0c)",
  ];
  return kind & 0x100 ? names[kind & 0xff] : undefined;
}

/**
 * Classes of robots (the actors spawners and bombs let appear: 0x44dd60). Robots are
 * drawn with one of their episode's `_Aliens` sprites (Game.aliens, see robotSprite).
 */
export const ROBOT_CLASSES: readonly number[] = [0x02, 0xbd];

/**
 * How many `_Aliens` sprites robots take in turn (episode +0x2c, the sprites before the
 * one with frame count 0xff): Junior to III leave out the last one (their constructors
 * decrement the count, e.g. 0x408ca6), the sprite of scorpions (robots from sand heaps,
 * 0x44dcf0, which take sprite number count in their own colours).
 */
export function robotSpriteCount(episode: number, aliens: number): number {
  return episode < 4 ? Math.max(1, aliens - 1) : aliens;
}

/**
 * The `_Aliens` sprite of a robot created on entering the room: the length of the room's
 * actor list, itself included, modulo robotSpriteCount (0x445c15, 0x445b60; episode IV
 * 0x44ac9e), so a room's first actor, if a robot, takes sprite 1.
 */
export function robotSprite(actor: RoomActor, count: number): number | undefined {
  return actor.order === undefined ? undefined : (actor.order + 1) % count;
}

const RECORD_SOURCES: Readonly<Partial<Record<number, ActorSource>>> = {
  5: "spawner",
  7: "creature",
  8: "travelling",
};

/** The dealer's class: buys platinum for points, sells items for gold (0x448440, dealer.ts). */
export const DEALER_CLASS = 0x2c;

/** Names of actors whose tiles do not say what they are. */
export const ACTOR_CLASS_NAMES: Readonly<Partial<Record<number, string>>> = {
  [DEALER_CLASS]: "Dealer",
  0x4a: "Thief", // takes about half of the hero's items (0x41f470)
};

/**
 * The actor kind a travelling actor record names with its byte 8 (converted when the
 * scene is loaded, 0x432728): with bit 0x80 an index into the episode's actor kinds
 * (originals: 0x83 the dealer, 0x85 the thief), else a tile type (its class).
 */
export function recordActorKind(byte: number, classes: EpisodeClasses): number | undefined {
  // an index past the episode's table names no actor
  const low =
    byte & 0x80 ? classes.actorKinds.at(byte & 0x7f) : (classes.classes.get(byte)?.id ?? byte);
  return low === undefined ? undefined : 0x100 | (low & 0xff);
}

/** The class an actor kind names (kinds below 0x10c through ACTOR_KIND_CLASSES). */
export function actorKindClass(kind: number): number {
  const n = kind & 0xff;
  return kind & 0x100 && n < 0x0c ? (ACTOR_KIND_CLASSES[n & 0x7f] ?? n) : n;
}

/** The source a cell is for an actor, if it is one (logic cells: see their records). */
export function cellActorSource(cell: number, classes: EpisodeClasses): ActorSource | undefined {
  const cls = classes.classes.get(cell & 0xff);
  if (!cls) return undefined;
  if (ACTOR_LOAD_METHODS.has(cls.loadMethod)) return "tile";
  if (HATCHING_LOAD_METHODS.has(cls.loadMethod)) return "hatchery";
  if (cls.loadMethod === BOMB_LOAD_METHOD) return "bomb";
  if (cls.describeMethod === SAND_DESCRIBE_METHOD && SAND_SCORPION_STATES.has(cell >> 8)) {
    return "scorpions";
  }
  return undefined;
}

/**
 * The room's actors in the order the game meets them on entering the room (see above).
 * Records count in the base layer only (the game drops logic cells in the overlay); a
 * cell's tiles count from the top down while they turn into actors, so nothing appears
 * from under an object that stays.
 */
export function roomActors(room: Room, classes: EpisodeClasses): RoomActor[] {
  const typeOf = (classId: number) => classes.typeOfClass.get(classId);
  const robot = ROBOT_CLASSES.map(typeOf).find((t) => t !== undefined);
  const actors: RoomActor[] = [];
  let order = 0;
  for (let cell = ROOM_WIDTH; cell < ROOM_CELLS; cell++) {
    const base = room.base[cell] ?? 0;
    let shown = base;
    if ((base & 0xff) === LOGIC_CELL) {
      const record = room.records.find((r) => r.slot === base >> 8);
      const source = record && RECORD_SOURCES[record.data[0]];
      if (record && source) {
        const d = record.data;
        const actor = { source, cell, layer: "base" as const, record };
        if (source === "spawner") {
          actors.push({ ...actor, type: robot, radius: Math.sqrt(d[4]), period: d[5] });
        } else if (source === "creature") {
          actors.push({ ...actor, type: typeOf(actorKindClass(0x107)), order: order++ });
        } else {
          const target = { room: (d[4] | (d[5] << 8)) & 0x3ff, x: d[6], y: d[7] };
          const kind = recordActorKind(d[8], classes);
          const type = kind === undefined ? undefined : typeOf(actorKindClass(kind));
          actors.push({ ...actor, type, target, order: order++ });
        }
      }
      // the cell the record shows takes the logic cell's place (natives and travelling
      // actors leave theirs in the map, 0x42b7fc)
      shown = resolveCell(room, base);
    }
    const overlay = room.overlay[cell] ?? 0;
    const tiles = [
      ...((overlay & 0xff) === LOGIC_CELL || overlay === 0 ? [] : [["overlay", overlay] as const]),
      ["base", shown] as const,
    ];
    for (const [layer, value] of tiles) {
      const source = cellActorSource(value, classes);
      if (!source) break;
      const type = value & 0xff;
      if (source !== "tile") {
        actors.push({ source, cell, layer, type });
        break;
      }
      actors.push({ source, cell, layer, type, order: order++ });
    }
  }
  return actors;
}

export interface ScriptActors {
  /** The script's object name, e.g. "ALIEN" for O_ALIEN. */
  name: string;
  min: number;
  max: number;
  conditional: boolean;
}

/**
 * Objects a room script keeps at a random number: RandObj(O_NAME, min, max), e.g.
 * RandObj(O_ALIEN, 8, 15) for 8 to 15 robots (see isConditional).
 */
export function scriptActors(source: string): ScriptActors[] {
  return [...source.matchAll(/\bRandObj\s*\(\s*O_(\w+)[^,]*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)].map(
    (m) => ({
      name: m[1],
      min: Number(m[2]),
      max: Number(m[3]),
      conditional: isConditional(source, m.index),
    }),
  );
}

/** Classes RandObj places in an area away from the hero (0x407588): robots, androids. */
const AWAY_FROM_HERO_CLASSES: readonly number[] = [...ROBOT_CLASSES, 0x2d];

export interface PlacementArea {
  /** The edge the hero enters the room through. */
  entering: "west" | "east" | "north" | "south";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where RandObj places robots and androids: within 10 columns and 5 rows of a reference
 * point (0x4fe30b/0x4fe30c) on the far side of the room from where the hero entered. The
 * game sets it when the hero walks off an edge (0x44c5a0); teleporters and stairs keep the
 * previous one, the bus sets the middle (20, 14).
 */
export const PLACEMENT_AREAS: readonly PlacementArea[] = (
  [
    ["west", 25, 14],
    ["east", 15, 14],
    ["north", 20, 22],
    ["south", 20, 7],
  ] as const
).map(([entering, x, y]) => ({
  entering,
  x0: Math.max(0, x - 10),
  y0: Math.max(1, y - 5),
  x1: Math.min(ROOM_WIDTH - 1, x + 10),
  y1: Math.min(28, y + 5),
}));

export interface RandomPlacement {
  /** The tile type placed, if the name is known. */
  type: number | undefined;
  /** How many the room has already (they count towards min..max). */
  existing: number;
  /** Robots and androids go into one of PLACEMENT_AREAS, other objects anywhere. */
  awayFromHero: boolean;
  /** Empty cells (no object, no actor): the only ones RandObj places on. */
  free: number;
}

/** The class of an actor created on entering the room (what stands on its cell then). */
function actorClass(actor: RoomActor, classes: EpisodeClasses): number | undefined {
  if (actor.source === "creature") return actorKindClass(0x107);
  if (actor.source === "travelling") {
    const kind = actor.record && recordActorKind(actor.record.data[8], classes);
    return kind === undefined ? undefined : actorKindClass(kind);
  }
  return actor.type === undefined ? undefined : classes.classes.get(actor.type)?.id;
}

/**
 * What RandObj(O_NAME, min, max) does in a room (0x4073a0): it counts the room's objects
 * of that class in rows 1-28 (0x407650: per cell the actor standing there, else the top of
 * the cell, 0x433230; scripts run once the room's actors are there, so natives, the dealer
 * and the thief count as well), draws a number between min and max, removes random ones
 * above it and adds new ones below it, each on an empty cell found with up to 20 random
 * tries (0x433230, 0x433420). `constants` are the episode's script constants
 * (Game.scriptConstants).
 */
export function randomPlacement(
  call: ScriptActors,
  room: Room,
  classes: EpisodeClasses,
  constants: ReadonlyMap<string, number>,
): RandomPlacement {
  const type = constants.get(`O_${call.name}`);
  const id = type === undefined ? undefined : classes.classes.get(type)?.id;
  // the actor on each cell: the last one created there
  const standing = new Map(
    roomActors(room, classes).flatMap((a) =>
      a.order === undefined ? [] : [[a.cell, actorClass(a, classes)] as const],
    ),
  );
  let existing = 0;
  let free = 0;
  for (let cell = ROOM_WIDTH; cell < ROOM_CELLS; cell++) {
    const base = room.base[cell] ?? 0;
    const overlay = room.overlay[cell] ?? 0;
    const top =
      (overlay & 0xff) === LOGIC_CELL || overlay === 0 ? resolveCell(room, base) : overlay;
    const at = standing.has(cell) ? standing.get(cell) : classes.classes.get(top & 0xff)?.id;
    if (id !== undefined && at === id) existing++;
    if (base === 0 && overlay === 0) free++;
  }
  const awayFromHero = id !== undefined && AWAY_FROM_HERO_CLASSES.includes(id);
  return { type, existing, awayFromHero, free };
}
