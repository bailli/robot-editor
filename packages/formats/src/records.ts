import { ACTOR_CLASS_NAMES, actorKindClass, recordActorKind } from "./actors.ts";
import type { EpisodeClasses } from "./classes.ts";
import { type PeImage, readVa } from "./pe.ts";
import type { LogicRecord } from "./scene.ts";

/**
 * What logic records do (the 10 data bytes; data[0] is the type). A logic cell shows the
 * cell its record holds (resolveCell) and the record adds behaviour. On loading a room
 * the game converts the cells in it to class ids (offset 2 always, offset 4 of types 1,
 * 3 and 7, offset 8 of type 12, the actor of type 8) and old types: 2 and 10 become
 * teleporters, 6 and 9 oracles. Then every overlay object becomes a type 1 record on
 * its base cell, in a table of 200 records per room (0x4327c4; a logic cell in the
 * overlay is dropped, tried in the game). Type 0 marks a free entry; unknown types only
 * show their cell. Bytes not named below are never read. Byte 1 bit 5, of any type,
 * dissolves the record into its cell (offset 2) when the room is left and stored
 * (0x431f20; the game's own exit teleporters, see type 13; tried with an oracle: after
 * leaving and coming back it was a plain cell, blocking and dead even with its symbol
 * laid); bits 6-7 are a level as
 * type 1's for the other types too (the step-on check's default case, 0x44c8d2).
 *
 *   1   stacked: the object at offset 4 lies on the cell at offset 2 (0x44cd56); taking it
 *       leaves the lower cell (tried in the game). Byte 1 bits 6-7: the object's level,
 *       actors reach it only from that level up (episode IV's bridges: level tiles 0x6c,
 *       state bits 4-6 the level, bit 7 a ramp, bit 0 the axis, 0x41f730; the hero walks
 *       up a ramp and along a bridge over a canal, and across under it, tried)
 *   3   buried (episode III): the object at offset 4 lies under the cell at offset 2 until
 *       the hero uses the shovel standing on it (0x4130b0), then it lies on that cell (a
 *       type 1 record; tried: the first dig's bonus, the gold found); a detector item
 *       senses it nearby (0x417070)
 *   5   spawner (episodes III, IV): while the hero is within sqrt(byte 4) cells, a robot
 *       appears every byte 5 ticks (0x435650; byte 6 counts down, byte 7 animates). Not
 *       while episode IV's StationBOff is 4 or more (both tried in the game)
 *   7   native (episode III): on entering the room the cell at offset 2 is placed and a
 *       friendly native (kind 0x107) appears (tried in the game) and wanders; after a few
 *       chats (texts 300 + byte 7 or 310 + byte 7) he sells the object at offset 4 for
 *       byte 6 gold (0x42b78b, 0x415c10)
 *   8   travelling actor: on entering the room the cell at offset 2 is placed and an
 *       actor appears (byte 8, see recordActorKind: the dealer or the thief) and walks up
 *       to the hero. Walked into, the dealer offers items for gold (cursor keys, Enter
 *       buys, Esc ends) or buys platinum for points (text 507, 0x448440). Once the hero
 *       dealt with it, it wanders and leaves through an edge wall, which stays open for
 *       1-2 s and leads to room (offset 4, bits 0-9) at x (byte 6), y (byte 7) (0x42b81d,
 *       0x420c30; tried: the dealer came, sold, left through the wall)
 *   11  circuit node (episodes I, II, 0x40f700): its input is traced westwards from it
 *       (0x40f9a0): letters 1 and 0 (tile 0x25) are the sources, pieces of tile 0x42 the
 *       wiring by state: 0x0a/0x0b wire across/down, 0x0c/0x0d corners, 0x09 NOT, 0x00-0x08
 *       a gate's operator cell (OR, AND, NOR, NAND, XOR, B or not A, A or not B, B and not
 *       A, A and not B) with 0x0e, its left half, west of it; the inputs come from above
 *       and below the left half. The game evaluates all nodes when such a piece is taken
 *       or put down. A lit node (byte 7) places stairs (up if byte 6, else down) at (byte
 *       4, byte 5), if byte 5 is not 0; a final node (byte 1 bit 0) only once all the
 *       room's nodes are lit, itself included (episode I room 128: the stairs to room
 *       228; byte 1 bit 1 remembers it); a lit node casts a light (byte 8 holds it at
 *       run time). See circuits.ts. Tried: a 1 directly, through a wire, through AND with
 *       1 and 1 lit their nodes, AND with 1 and 0 did not
 *   12  oracle (episodes II, III, tile 0x51): it only works once its symbol lies in the
 *       room, a 2×2 block of tangram pieces (tile 0x50) whose states are pattern n of
 *       readOracleSymbols (n: low 4 bits of the oracle's state, offset 2; 0x412860, which
 *       then shows the pieces as solved and sets bit 4 of the state: with it the symbol
 *       counts as found and is not looked for again, tried: preset, the oracle works
 *       without any pieces laid out; the originals' states are 0-9, n
 *       from 10 on reads past the 10 symbols, pointers no pieces match). Then, walked
 *       into (0x412ae0), northwards it sends to the target (offset 4, byte 6, see
 *       exits.ts), eastwards it shows its hint, message 330 + n (episode II has 331, 332,
 *       334 and 339), westwards it turns into the object at offset 8, southwards it
 *       vanishes and kills (text 945; all tried in the game, without the symbol nothing
 *       happens). After north and east it vanishes only in episode II (episode flags
 *       0x4000, 0x8000, which only II's constructor sets; tried for north). Every use is
 *       event 262 + n (0x42bef0: 3500 points once per game, tried, n from 10 on other events). Byte 7 is never
 *       read (episode III's hold 0, 6 or 7)
 *   13  teleporter (see exits.ts), only the hero steps on it (0x44c6f0, robots are kept
 *       off): offset 2 the cell it shows, offset 4 the target room (bits 0-9) and x (bits
 *       10-15), byte 6 y. Byte 7 a condition (teleporterCondition): 1 lets only a hero
 *       carrying an object of the shown cell's class step on it, 2 only one without; the
 *       game draws them on colour 15 with the teleporter's frame and on black (see
 *       render.ts). Byte 1: bit 0, while byte 7 is 0, lets the hero always step on it and
 *       first act on the shown cell as if it lay there (tried: he takes the item it shows,
 *       then is teleported; without the bit the shown cell stays and decides whether he
 *       may step on it, e.g. a wall does not let him); bit 1 lets a script's Teleport() set the
 *       target (tried in the game); bit 3 makes it a light source in episode III (a
 *       circle around it lit in a dark room, tried; class 0xba's room-entry hook
 *       0x416ef0, which only episode III has, adds the lights, 0x42b230);
 *       bits 6-7 a level as type 1's (a teleporter with a level and no condition is not
 *       drawn); bits 4 and 5 are the game's own (the exit an actor of a type 8 record
 *       leaves open is a teleporter with bits 0, 4 and 5, 0x420c30; loading a room clears
 *       bit 4), bit 2 is never read. Byte 8: message 1200 + it when used, unless a
 *       script redirected it. Byte 9 is never read (episode III's teleporters with a
 *       condition hold 157 or 158 there). A target room that does not exist does nothing
 *       (tried)
 */

/** The tangram pieces oracles' symbols are laid with (class 0x5f, episodes II and III). */
export const TANGRAM_TILE = 0x50;
const ORACLE_SYMBOLS = 0x47be54;
const SYMBOL_COUNT = 10;

/**
 * The oracles' symbols: per n the states of the four tangram pieces of the 2×2 block,
 * top left, top right, bottom left, bottom right.
 */
export function readOracleSymbols(image: PeImage): number[][] {
  const bytes = readVa(image, ORACLE_SYMBOLS, SYMBOL_COUNT * 4);
  return Array.from({ length: SYMBOL_COUNT }, (_, n) => [...bytes.subarray(n * 4, n * 4 + 4)]);
}

/**
 * The data offsets of a record that hold cells (tile values, as maps store them): offset
 * 2 always, 4 of types 1, 3 and 7, 8 of type 12; the ones the game converts on loading
 * a room. Type 8's actor (byte 8) is no cell.
 */
export function recordCellOffsets(type: number): number[] {
  return type === 12 ? [2, 8] : type === 1 || type === 3 || type === 7 ? [2, 4] : [2];
}

/**
 * What a teleporter asks of the hero (byte 7, 0x44c6f0): "carry" lets him step on it only
 * while he carries an object of the class of the cell it shows (offset 2; any state, e.g.
 * a key of any colour; gold: any gold, letters: any letter), "not carry" only while he
 * carries none. Other values than 1 and 2 ask nothing; above 2 also byte 1 bit 0 is
 * ignored.
 */
export type TeleporterCondition = "none" | "carry" | "not carry";

export function teleporterCondition(data: Uint8Array): TeleporterCondition {
  return data[7] === 1 ? "carry" : data[7] === 2 ? "not carry" : "none";
}

export type RecordKind =
  | "stacked"
  | "buried"
  | "spawner"
  | "native"
  | "travelling actor"
  | "circuit"
  | "oracle"
  | "teleporter"
  | "unknown";

const KINDS: Readonly<Partial<Record<number, RecordKind>>> = {
  1: "stacked",
  3: "buried",
  5: "spawner",
  7: "native",
  8: "travelling actor",
  11: "circuit",
  12: "oracle",
  13: "teleporter",
};

export interface RecordInfo {
  kind: RecordKind;
  /** One sentence for people. */
  summary: string;
}

const hex = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

/**
 * `classes` (the record's episode) name the actors of travelling actor records, `symbols`
 * (readOracleSymbols) the symbol an oracle needs.
 */
export function describeRecord(
  record: LogicRecord,
  classes?: EpisodeClasses,
  symbols?: readonly (readonly number[])[],
): RecordInfo {
  const d = record.data;
  const u16 = (at: number) => d[at] | (d[at + 1] << 8);
  const target = () => `room ${u16(4) & 0x3ff} at (${u16(4) >> 10}, ${d[6]})`;
  const kind = KINDS[d[0]] ?? "unknown";
  const summaries: Record<RecordKind, () => string> = {
    stacked: () => `${hex(u16(4))} lies on ${hex(u16(2))}`,
    buried: () => `${hex(u16(4))} is buried under ${hex(u16(2))}; dig to find it`,
    spawner: () =>
      `a robot appears every ${d[5]} ticks while the hero is within ` +
      `${Math.sqrt(d[4]).toFixed(1)} cells`,
    native: () =>
      `a friendly native appears here when the room is entered` +
      (u16(4) ? `; he sells ${hex(u16(4))} for ${Math.min(d[6] & 15, 9)} gold` : ""),
    "travelling actor": () => {
      const kind = classes && recordActorKind(d[8], classes);
      const name = kind === undefined ? undefined : ACTOR_CLASS_NAMES[actorKindClass(kind)];
      const who = name
        ? `the ${name.toLowerCase()}`
        : kind !== undefined
          ? `an actor (kind 0x${kind.toString(16)})`
          : classes
            ? `no actor (byte 8 = 0x${d[8].toString(16)} is past the episode's actors)`
            : `an actor (byte 8 = 0x${d[8].toString(16)})`;
      return (
        `${who} appears here; once the hero dealt with it, it leaves through an edge ` +
        `wall, and following it leads to room ${u16(4) & 0x3ff} at (${d[6]}, ${d[7]})`
      );
    },
    circuit: () =>
      `a node of the logic gate puzzles` +
      (d[5]
        ? `; ${d[1] & 1 ? "once all nodes are lit" : "while lit"} stairs ${d[6] ? "up" : "down"} ` +
          `appear at (${d[4]}, ${d[5]})`
        : ""),
    oracle: () => {
      const symbol = symbols?.[d[3] & 15];
      const pieces = symbol
        ? `its symbol, tangram pieces ${symbol.map((s) => hex(TANGRAM_TILE | (s << 8))).join(" ")} ` +
          `in a 2×2 block (top left to bottom right),`
        : "its symbol";
      return (
        `an oracle; ${d[3] & 0x10 ? "its symbol counts as found" : `once ${pieces} lies in the room`}: walked into northwards it sends to ` +
        `${target()}, eastwards it shows message ${330 + (d[3] & 15)}, westwards it turns ` +
        `into ${hex(u16(8))}, southwards it kills`
      );
    },
    teleporter: () =>
      `a teleporter to ${target()}` +
      (d[1] & 0x02 ? ", or where a script's Teleport() says" : "") +
      {
        none: "",
        carry: `; only for a hero who carries an object like ${hex(u16(2))}`,
        "not carry": `; only for a hero who carries no object like ${hex(u16(2))}`,
      }[teleporterCondition(d)] +
      (d[8] ? `; shows message ${1200 + d[8]}` : ""),
    unknown: () => `record type ${d[0]}`,
  };
  return { kind, summary: summaries[kind]() };
}
