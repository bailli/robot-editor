import { ACTOR_CLASS_NAMES, actorKindClass, recordActorKind } from "./actors.ts";
import type { EpisodeClasses } from "./classes.ts";
import type { LogicRecord } from "./scene.ts";

/**
 * What logic records do (the 10 data bytes; data[0] is the type). A logic cell shows the
 * cell its record holds (resolveCell) and the record adds behaviour:
 *
 *   1   stacked: the cell at offset 4 lies on top of the one at offset 2 (0x44cd56); when
 *       it is taken, the record turns into the lower cell. Byte 1 bits 6-7: compared with
 *       the stepping actor (e.g. episode IV's drawbridges)
 *   3   buried (episode III): the cell at offset 4 lies under the one at offset 2 until
 *       dug up with the shovel (0x4130b0), then it is a type 1 record
 *   5   spawner (episodes III, IV): while the hero is within sqrt(byte 4) cells, a
 *       creature appears every byte 5 ticks (0x435650; byte 6 counts down)
 *   7   creature (episode III): on entering the room the cell at offset 2 is placed and
 *       a creature of kind 0x107 appears (0x42b78b; parameters at offsets 4, 6, 7)
 *   8   travelling actor: on entering the room the cell at offset 2 is placed and an
 *       actor appears (byte 8, see recordActorKind: the dealer or the thief). Once the
 *       hero dealt with it, it leaves through an edge wall, which leads to room (offset
 *       4, bits 0-9) at x (byte 6), y (byte 7) for 1-2 s (0x42b81d, 0x420c30)
 *   11  circuit (episode I): a node of the logic gate puzzles; byte 7 holds its signal
 *       (0x40f700)
 *   12  oracle, 13 teleporter: see exits.ts
 */

export type RecordKind =
  | "stacked"
  | "buried"
  | "spawner"
  | "creature"
  | "travelling actor"
  | "circuit"
  | "oracle"
  | "teleporter"
  | "unknown";

const KINDS: Readonly<Partial<Record<number, RecordKind>>> = {
  1: "stacked",
  3: "buried",
  5: "spawner",
  7: "creature",
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

/** `classes` (the record's episode) name the actors of travelling actor records. */
export function describeRecord(record: LogicRecord, classes?: EpisodeClasses): RecordInfo {
  const d = record.data;
  const u16 = (at: number) => d[at] | (d[at + 1] << 8);
  const target = () => `room ${u16(4) & 0x3ff} at (${u16(4) >> 10}, ${d[6]})`;
  const kind = KINDS[d[0]] ?? "unknown";
  const summaries: Record<RecordKind, () => string> = {
    stacked: () => `${hex(u16(4))} lies on ${hex(u16(2))}`,
    buried: () => `${hex(u16(4))} is buried under ${hex(u16(2))}; dig to find it`,
    spawner: () =>
      `a creature appears every ${d[5]} ticks while the hero is within ` +
      `${Math.sqrt(d[4]).toFixed(1)} cells`,
    creature: () => `a creature (kind 0x107) appears here when the room is entered`,
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
    circuit: () => `a node of the logic gate puzzles`,
    oracle: () => `an oracle; walked onto northwards it teleports to ${target()}`,
    teleporter: () =>
      `a teleporter to ${target()}` +
      (d[1] & 0x02 ? ", or where a script's Teleport() says" : "") +
      (d[8] ? `; shows message ${1200 + d[8]}` : ""),
    unknown: () => `record type ${d[0]}`,
  };
  return { kind, summary: summaries[kind]() };
}
