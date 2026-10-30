import { classTexts, freeTileTypes } from "./classes.ts";
import { EVENT_TEXT, FIRST_EVENT_ENTRY, readEventTable, spareEventEntries } from "./events.ts";
import { type Game, eventTextsId, textsId } from "./game.ts";
import type { CopyTextsChange, ModChanges } from "./mod.ts";
import { readOracleSymbols, recordCellOffsets } from "./records.ts";
import { LOGIC_CELL } from "./scene.ts";

/**
 * Kits: what makes a feature of one episode work in another, copied in one step (the
 * editor's Episode tab, Editor.addKit): its tile types (withTileTypes: class, shape,
 * description, sound, first take), the texts their classes show (classTexts), the
 * events their code raises, in entries the episode never uses (spareEventEntries), and
 * the MUSIC pieces the types' and events' sounds name that the episode lacks. A
 * type whose class the episode has already is not copied: the circuits' stairs only go
 * to Junior, and a kit in the episode it comes from has nothing to do. See STATUS, "Fan
 * episodes", for the pilots they come from.
 */
export interface Kit {
  key: string;
  name: string;
  /** The episode the types come from. */
  from: number;
  /** Its tile types and what they are. */
  types: readonly (readonly [type: number, name: string])[];
  /** The events (ids) the classes' code raises, each once per game for its points. */
  events: readonly number[];
  /** An event's name for the view, e.g. the oracle symbol it is for. */
  eventLabel?: (id: number) => string;
  /** What it takes in the rooms, for the view. */
  note: string;
  /** What its example (kitExample) holds, for the view. */
  example: string;
}

export const KITS: readonly Kit[] = [
  {
    key: "oracles",
    name: "Oracles",
    from: 2,
    types: [
      [0x50, "tangram piece"],
      [0x51, "oracle"],
    ],
    // a use of the oracle with symbol n: 262 + n (0x42bef0), 3500 points in II
    events: Array.from({ length: 10 }, (_, n) => 262 + n),
    eventLabel: (id) => `symbol ${id - 262}`,
    example:
      "An oracle with its symbol laid out west of it: walked into northwards it sends the hero below the symbol, eastwards it gives its hint. Change its target, hint and object in the Record tab.",
    note: "An oracle (a logic record of type 12) works once its symbol, a 2×2 block of tangram pieces, lies in the room: north it sends the hero, east it gives its hint (330 + n), west it turns into its object, south it kills.",
  },
  {
    key: "circuits",
    name: "Circuits",
    from: 1,
    types: [
      [0x25, "letter"],
      [0x42, "gate"],
      [0x43, "bulb"],
      [0x3d, "stairs"],
    ],
    // a node lit (0x125): 4000 points in Junior, I and II, none in III and IV (no entry)
    events: [293],
    example:
      "Letters 1 and 0 into an OR gate, a wire on to a node with its stairs; the wire is missing and lies below its gap: taken and used there (rucksack, “Benutzen”) it lights the node, which places the stairs; “Ablegen” puts it down without lighting anything.",
    note: "Letters 1 and 0, wires and gates lead to a circuit node (a logic record); once a circuit piece is taken a lit node places its stairs.",
  },
];

/** What adding a kit to an episode does (planKit). */
export interface KitPlan {
  /** Tile types copied: [target type, the kit's type]. */
  types: [to: number, of: number][];
  /** The kit's types whose class the episode has already. */
  present: number[];
  /** Entries of the episode's texts copied from the kit's episode, at the same numbers. */
  texts: number[];
  /** Event entries: a spare entry, the kit episode's entry it copies, its id. */
  events: { entry: number; of: number; id: number }[];
  /** The kit's events the episode's table lacks (`events` and `without` share them out). */
  lacking: number[];
  /** The lacking events no entry is left for: they give no points. */
  without: number[];
  /** The MUSIC pieces the copied types' and events' sounds name that the episode lacks. */
  music: string[];
  /** Why the kit cannot be added, if it cannot. */
  problem?: string;
}

/** What planKit takes from the episode as it is now; defaults read from `game`. */
export interface KitOptions {
  /** The exe the types, texts and events come from (default `game`). */
  source?: Game;
  /** Types a copy can go to (default: no class and no room uses them). */
  free?: readonly number[];
  /** Event entries a copy can go to (default spareEventEntries). */
  spare?: readonly number[];
  /** Whether the episode's texts (textsId) have entry n (default: as in `game`). */
  hasText?: (n: number) => boolean;
  /** The lacking events to give entries, in order (default: as many as fit, in order). */
  events?: readonly number[];
}

/**
 * What adding `kit` to the episode of `game` takes: its types whose class the episode
 * lacks, each at the same number where that is free, else at the first free type left;
 * the texts the kit's classes show (classTexts) that the episode lacks, for classes it
 * does not have by itself in `source`; the events the
 * episode's table lacks, in its spare entries. A problem where the free types do not
 * suffice, where chosen events are not lacking or do not fit.
 */
export function planKit(game: Game, episode: number, kit: Kit, options: KitOptions = {}): KitPlan {
  const source = options.source ?? game;
  const classes = source.episode(kit.from).classes.classes;
  const here = game.episode(episode).classes.typeOfClass;
  const present: number[] = [];
  const wanted: number[] = [];
  for (const [type] of kit.types) {
    const id = classes.get(type)?.id ?? 0;
    (here.has(id) ? present : wanted).push(type);
  }
  const free = options.free ?? unusedFreeTypes(game, episode);
  const same = new Set(wanted.filter((t) => free.includes(t)));
  const rest = free.filter((t) => !same.has(t));
  const types: [number, number][] = [];
  const problems: string[] = [];
  for (const of of wanted) {
    const to = same.has(of) ? of : rest.shift();
    if (to === undefined) {
      problems.push(`${wanted.length} free tile types needed, ${free.length} left`);
      break;
    }
    types.push([to, of]);
  }
  const sourceTexts = source.texts(textsId(kit.from))?.entries;
  const hasText = options.hasText ?? ((n) => game.texts(textsId(episode))?.entries.has(n) === true);
  // the texts of every class the episode does not have by itself, copied by hand or not
  const native = source.episode(episode).classes.typeOfClass;
  const texts = [
    ...new Set(
      kit.types
        .map(([type]) => classes.get(type)?.id ?? 0)
        .filter((id) => !native.has(id))
        .flatMap((id) => classTexts(id)),
    ),
  ].filter((n) => sourceTexts?.has(n) === true && !hasText(n));
  const table = readEventTable(source.image, kit.from);
  const held = new Set(readEventTable(game.image, episode).map((e) => e.id));
  const entryOf = (id: number) => table.findIndex((e, n) => n >= FIRST_EVENT_ENTRY && e.id === id);
  const lacking = kit.events.filter((id) => !held.has(id) && entryOf(id) >= 0);
  const spare = [...(options.spare ?? spareEventEntries(episode))];
  let chosen = options.events ?? lacking.slice(0, spare.length);
  const notLacking = chosen.filter((id) => !lacking.includes(id));
  if (notLacking.length > 0)
    problems.push(`the episode has event ${notLacking.join(", ")} already or the kit has none`);
  if (chosen.length > spare.length) {
    problems.push(`${chosen.length} events chosen, ${spare.length} spare entries left`);
    chosen = chosen.slice(0, spare.length);
  }
  const events = chosen
    .filter((id) => lacking.includes(id))
    .map((id, k) => ({ entry: spare[k] ?? -1, of: entryOf(id), id }));
  const given = new Set(events.map((e) => e.id));
  const sounds = [...types.map(([, of]) => of), ...events.map((e) => e.of)].map((n) =>
    source.sound(kit.from, n),
  );
  const plan: KitPlan = {
    types,
    present,
    texts,
    events,
    lacking,
    without: lacking.filter((id) => !given.has(id)),
    music: game.lackedPieces(episode, sounds),
  };
  if (problems.length > 0) plan.problem = problems.join("; ");
  return plan;
}

/**
 * Types without a class that no room of the episode uses: in its maps or in the cells its
 * logic records hold (an oracle's object, what a teleporter or a circuit node shows).
 */
function unusedFreeTypes(game: Game, episode: number): number[] {
  const used = new Set<number>();
  for (const room of game.episode(episode).rooms) {
    for (const layer of [room.base, room.overlay]) for (const cell of layer) used.add(cell & 0xff);
    for (const { data } of room.records) {
      for (const at of recordCellOffsets(data[0])) used.add(data[at]);
    }
  }
  return freeTileTypes(game.image, episode).filter(
    (t) => t !== 0 && t !== LOGIC_CELL && !used.has(t),
  );
}

/**
 * The mod changes a plan makes (tileTypes, events with the kit episode's points and
 * sounds, the pieces those sounds name that the episode lacks as music, the texts and
 * the events' texts as copyTexts), for a mod or the editor to merge.
 */
export function kitChanges(
  source: Game,
  episode: number,
  kit: Kit,
  plan: KitPlan,
): Pick<ModChanges, "music" | "tileTypes" | "events" | "copyTexts"> {
  const table = readEventTable(source.image, kit.from);
  const eventTexts = source.texts(eventTextsId(kit.from))?.entries;
  const withText = plan.events.filter((e) => eventTexts?.has(EVENT_TEXT + e.of) === true);
  const texts: [number, number][] = plan.texts.map((n) => [n, n]);
  const copies: [number, number][] = withText.map((e) => [EVENT_TEXT + e.entry, EVENT_TEXT + e.of]);
  const copyTexts: CopyTextsChange[] = [];
  const add = (resource: number, from: number, entries: [number, number][]) => {
    const group = copyTexts.find((c) => c.resource === resource && c.from === from);
    if (group) group.entries = [...group.entries, ...entries];
    else if (entries.length > 0) copyTexts.push({ resource, from, entries });
  };
  add(textsId(episode), textsId(kit.from), texts);
  add(eventTextsId(episode), eventTextsId(kit.from), copies);
  return {
    music: plan.music.length > 0 ? [{ episode, from: kit.from, pieces: plan.music }] : [],
    tileTypes: plan.types.length > 0 ? [{ episode, from: kit.from, types: plan.types }] : [],
    events: plan.events.map(({ entry, of, id }) => {
      const sound = source.sound(kit.from, of);
      return {
        episode,
        entry,
        id,
        points: table[of]?.points ?? 0,
        ...(sound ? { sound } : {}),
      };
    }),
    copyTexts,
  };
}

/**
 * A small working setup of a kit's feature, to place in a room: both layers' cells row
 * by row (base: 0, empty floor, but logic cells where `records` lie; the pieces in the
 * overlay, so the floor under them can be painted, as the game stacks overlay objects
 * on their base cell) and the records, whose positions (a node's stairs, an oracle's
 * target) are as if the example's top left cell were (0, 0) of room `room`.
 */
export interface KitExample {
  w: number;
  h: number;
  base: number[];
  overlay: number[];
  records: { x: number; y: number; data: Uint8Array }[];
}

/** Circuit pieces (tile 0x42's states, circuits.ts) and letters (0x25's: the character). */
const [OR, WIRE_ACROSS, CORNER_DOWN, CORNER_UP, GATE_LEFT] = [0x00, 0x0a, 0x0c, 0x0d, 0x0e];
const [ZERO, ONE] = [0x30, 0x31];

/**
 * The example of `kit` for the episode as `game` has it (its types found by their class,
 * copies or its own; undefined where the episode lacks one):
 *
 * - circuits (7 × 3): letters 1 and 0 into an OR gate, a wire on to a node whose stairs
 *   go down two cells east of it; the wire is missing and lies below its gap: put down
 *   there ("Benutzen") it lights the node, which places the stairs.
 * - oracles (4 × 3): the 2×2 block of tangram pieces laid as symbol n, the oracle east of
 *   it (state n, hint 330 + n), which sends the hero below the block. n: the first symbol
 *   whose event (262 + n) the episode's table has and whose hint `hasText`, else the
 *   first with its event, else 0.
 */
export function kitExample(
  game: Game,
  episode: number,
  kit: Kit,
  room: number,
  hasText: (n: number) => boolean = (n) => game.texts(textsId(episode))?.entries.has(n) === true,
): KitExample | undefined {
  const classes = game.episode(kit.from).classes.classes;
  const here = game.episode(episode).classes.typeOfClass;
  const types = kit.types.map(([of]) => here.get(classes.get(of)?.id ?? 0));
  const cell = (k: number, state: number) => (types[k] ?? 0) | (state << 8);
  if (kit.key === "circuits") {
    const [letter, gate] = types;
    if (letter === undefined || gate === undefined) return undefined;
    const w = 7;
    const base = Array.from({ length: 3 * w }, () => 0);
    const overlay = base.slice();
    const put = (x: number, y: number, value: number) => (overlay[x + y * w] = value);
    put(0, 0, cell(0, ONE));
    put(0, 2, cell(0, ZERO));
    put(1, 0, cell(1, CORNER_DOWN));
    put(1, 1, cell(1, GATE_LEFT));
    put(1, 2, cell(1, CORNER_UP));
    put(2, 1, cell(1, OR));
    put(3, 2, cell(1, WIRE_ACROSS)); // its place is (3, 1)
    base[4 + w] = LOGIC_CELL;
    // a node: stairs down at (6, 1) once lit
    const node = Uint8Array.from([11, 0, 0, 0, 6, 1, 0, 0, 0, 0]);
    return { w, h: 3, base, overlay, records: [{ x: 4, y: 1, data: node }] };
  }
  if (kit.key === "oracles") {
    const [tangram, oracle] = types;
    if (tangram === undefined || oracle === undefined) return undefined;
    const held = new Set(readEventTable(game.image, episode).map((e) => e.id));
    const symbols = Array.from({ length: 10 }, (_, n) => n).filter((n) => held.has(262 + n));
    const n = symbols.find((k) => hasText(330 + k)) ?? symbols.at(0) ?? 0;
    const pieces = readOracleSymbols(game.image)[n];
    const w = 4;
    const base = Array.from({ length: 3 * w }, () => 0);
    const overlay = base.slice();
    pieces.forEach((state, k) => (overlay[(k % 2) + Math.floor(k / 2) * w] = cell(0, state)));
    base[3 + w] = LOGIC_CELL;
    // sends to (0, 2), below the block: room | x << 10, y
    const target = room;
    const data = Uint8Array.from([12, 0, oracle, n, target & 0xff, target >> 8, 2, 0, 0, 0]);
    return { w, h: 3, base, overlay, records: [{ x: 3, y: 1, data }] };
  }
  return undefined;
}
