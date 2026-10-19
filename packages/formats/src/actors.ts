import {
  ACTOR_LOAD_METHODS,
  BOMB_LOAD_METHOD,
  type EpisodeClasses,
  HATCHING_LOAD_METHODS,
  SAND_DESCRIBE_METHOD,
  SAND_SCORPION_STATES,
} from "./classes.ts";
import { isConditional } from "./exits.ts";
import { LOGIC_CELL, type LogicRecord, ROOM_CELLS, ROOM_WIDTH, type Room } from "./scene.ts";

/**
 * The moving actors of a room (robots, androids, animals, the bus, …) and where they come
 * from. The game creates actors with 0x44dc60(kind, x, y, …) when a room is entered or
 * later; the map cell is cleared. Kinds 0x100 + n name a class through the table at
 * 0x47ec98 (ACTOR_KIND_CLASSES); a factory registered for that class (0x44d4e0, 20 of
 * them) creates the actor. Robots pick one of their episode's `_Aliens` sprites and three
 * random colours (0x445bd0), so they look different on every visit.
 *
 * Sources:
 *   tile       a cell whose class turns it into an actor on entering (room-load method in
 *              ACTOR_LOAD_METHODS)
 *   hatchery   creatures appear after a while: eggs, snake basket, "something behind the
 *              wall" (HATCHING_LOAD_METHODS)
 *   bomb       its explosion lets robots appear
 *   scorpions  sand heaps (sand states 6, 7) hiding scorpions
 *   spawner    record type 5: robots appear while the hero is near (0x435650)
 *   creature   record type 7: an actor of kind 0x107 appears on entering
 *   travelling record type 8: an actor of kind 0x100 + byte 8 heading for a target
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
  /** The record behind it (spawner, creature, travelling actor). */
  record?: LogicRecord;
  /** Spawners: creatures appear while the hero is within this many cells. */
  radius?: number;
  /** Spawners: ticks between creatures. */
  period?: number;
  /** Travelling actors: where they head. */
  target?: { room: number; x: number; y: number };
}

/** Actor kinds 0x100..0x10a -> class id (0x47ec98, first word of 28-byte entries). */
export const ACTOR_KIND_CLASSES: readonly number[] = [
  0x01, 0x02, 0x03, 0x2c, 0x2d, 0x4a, 0xa0, 0x9f, 0xa3, 0xbd, 0xc0,
];

/**
 * Classes of robots (the actors spawners and bombs let appear: 0x44dd60). Robots are
 * drawn with one of their episode's `_Aliens` sprites (Game.aliens): the n-th actor of
 * the room takes sprite n modulo their number, in three random colours (0x445bd0).
 */
export const ROBOT_CLASSES: readonly number[] = [0x02, 0xbd];

const RECORD_SOURCES: Readonly<Partial<Record<number, ActorSource>>> = {
  5: "spawner",
  7: "creature",
  8: "travelling",
};

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

export function roomActors(room: Room, classes: EpisodeClasses): RoomActor[] {
  const typeOf = (classId: number) => classes.typeOfClass.get(classId);
  const robot = ROBOT_CLASSES.map(typeOf).find((t) => t !== undefined);
  const actors: RoomActor[] = [];
  for (const layer of ["base", "overlay"] as const) {
    for (let cell = 0; cell < ROOM_CELLS; cell++) {
      const value = room[layer][cell] ?? 0;
      if ((value & 0xff) === LOGIC_CELL) {
        const record = room.records.find((r) => r.slot === value >> 8);
        const source = record && RECORD_SOURCES[record.data[0]];
        if (!record || !source) continue;
        const d = record.data;
        if (source === "spawner") {
          const actor = { source, cell, layer, type: robot, record };
          actors.push({ ...actor, radius: Math.sqrt(d[4]), period: d[5] });
        } else if (source === "creature") {
          actors.push({ source, cell, layer, type: typeOf(actorKindClass(0x107)), record });
        } else {
          const target = { room: (d[4] | (d[5] << 8)) & 0x3ff, x: d[6], y: d[7] };
          const type = typeOf(actorKindClass(0x100 | d[8]));
          actors.push({ source, cell, layer, type, record, target });
        }
        continue;
      }
      const source = cellActorSource(value, classes);
      if (source) actors.push({ source, cell, layer, type: value & 0xff });
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

/**
 * Script object names are tile types. The sound tables name the items (Game.objectNames);
 * these others are read from compiled scripts (RandObj's first argument).
 */
const SCRIPT_OBJECTS: Readonly<Record<string, number>> = {
  ALIEN: 0x02,
  ANDROID: 0x2d,
  BOMB: 0x13,
  WORM: 0x37,
  ISOLATE: 0x09,
};

/** The tile type of a script object name ("KEY", "ALIEN"), if known. */
export function scriptObjectType(
  name: string,
  objectNames: ReadonlyMap<number, string>,
): number | undefined {
  for (const [type, known] of objectNames) if (known === name) return type;
  return SCRIPT_OBJECTS[name];
}

/** Classes RandObj places near the hero (0x407588): robots and androids. */
const NEAR_HERO_CLASSES: readonly number[] = [...ROBOT_CLASSES, 0x2d];

export interface RandomPlacement {
  /** The tile type placed, if the name is known. */
  type: number | undefined;
  /** How many the room has already (they count towards min..max). */
  existing: number;
  /**
   * Robots and androids are placed within 10 columns and 5 rows of where the hero enters
   * the room, other objects anywhere.
   */
  nearHero: boolean;
  /** Empty cells (no object, no actor): the only ones RandObj places on. */
  free: number;
}

/**
 * What RandObj(O_NAME, min, max) does in a room (0x4073a0): it counts the room's objects
 * of that tile type (map cells and actors, 0x407650), draws a number between min and max,
 * removes random ones above it and adds new ones below it, each on an empty cell found
 * with up to 20 random tries (0x433230, 0x433420).
 */
export function randomPlacement(
  call: ScriptActors,
  room: Room,
  classes: EpisodeClasses,
  objectNames: ReadonlyMap<number, string>,
): RandomPlacement {
  const type = scriptObjectType(call.name, objectNames);
  let existing = 0;
  let free = 0;
  for (let cell = 0; cell < ROOM_CELLS; cell++) {
    const base = room.base[cell] ?? 0;
    const overlay = room.overlay[cell] ?? 0;
    if (type !== undefined && ((base & 0xff) === type || (overlay & 0xff) === type)) existing++;
    if (base === 0 && overlay === 0 && cell >= ROOM_WIDTH) free++;
  }
  const id = type === undefined ? undefined : classes.classes.get(type)?.id;
  return { type, existing, nearHero: id !== undefined && NEAR_HERO_CLASSES.includes(id), free };
}
