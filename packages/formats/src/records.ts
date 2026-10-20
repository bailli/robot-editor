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
 * show their cell. Bytes not named below are never read.
 *
 *   1   stacked: the object at offset 4 lies on the cell at offset 2 (0x44cd56); taking it
 *       leaves the lower cell (tried in the game). Byte 1 bits 6-7: the object's level,
 *       actors reach it only from that level up (episode IV's bridges; level tiles 0x6c)
 *   3   buried (episode III): the object at offset 4 lies under the cell at offset 2 until
 *       dug up with the shovel (0x4130b0), then it lies on that cell (a type 1 record);
 *       a detector item senses it nearby (0x417070)
 *   5   spawner (episodes III, IV): while the hero is within sqrt(byte 4) cells, a robot
 *       appears every byte 5 ticks (0x435650; byte 6 counts down, byte 7 animates). Not
 *       while episode IV's StationBOff is 4 or more (both tried in the game)
 *   7   native (episode III): on entering the room the cell at offset 2 is placed and a
 *       friendly native (kind 0x107) appears (tried in the game) and wanders; after a few
 *       chats (texts 300 + byte 7 or 310 + byte 7) he sells the object at offset 4 for
 *       byte 6 gold (0x42b78b, 0x415c10)
 *   8   travelling actor: on entering the room the cell at offset 2 is placed and an
 *       actor appears (byte 8, see recordActorKind: the dealer or the thief). Once the
 *       hero dealt with it, it leaves through an edge wall, which leads to room (offset
 *       4, bits 0-9) at x (byte 6), y (byte 7) for 1-2 s (0x42b81d, 0x420c30)
 *   11  circuit node (episodes I, II): lit by a signal through the wires west of it
 *       (0x40f700, byte 7). While lit it places stairs (up if byte 6, else down) at
 *       (byte 4, byte 5), if byte 5 is not 0; a final node (byte 1 bit 0) only once all
 *       the room's nodes are lit (episode I room 128: the stairs to room 228)
 *   12  oracle (episodes II, III, tile 0x51): it only works once its symbol lies in the
 *       room, a 2×2 block of tangram pieces (tile 0x50) whose states are pattern n of
 *       readOracleSymbols (n: low 4 bits of the oracle's state; 0x412860, which then shows
 *       the pieces as solved). Then, walked into (0x412ae0), northwards it sends to the
 *       target (see exits.ts), eastwards it shows its hint, message 330 + n (episode II has
 *       331, 332, 334 and 339), and vanishes, westwards it turns into the object at offset
 *       8, southwards it kills (all but south tried in the game; without the symbol
 *       nothing happens)
 *   13  teleporter (see exits.ts): byte 1 bit 1 lets a script's Teleport() set the target
 *       (tried in the game), bit 0 lets the shown cell act first while byte 7 is 0, bit 3
 *       adds a visual effect; message 1200 + byte 8 when used. A target room that does
 *       not exist does nothing (tried)
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
        `an oracle; once ${pieces} lies in the room: walked into northwards it sends to ` +
        `${target()}, eastwards it shows message ${330 + (d[3] & 15)}, westwards it turns ` +
        `into ${hex(u16(8))}, southwards it kills`
      );
    },
    teleporter: () =>
      `a teleporter to ${target()}` +
      (d[1] & 0x02 ? ", or where a script's Teleport() says" : "") +
      (d[8] ? `; shows message ${1200 + d[8]}` : ""),
    unknown: () => `record type ${d[0]}`,
  };
  return { kind, summary: summaries[kind]() };
}
