import { classTexts, freeTileTypes } from "./classes.ts";
import { EVENT_TEXT, FIRST_EVENT_ENTRY, readEventTable, spareEventEntries } from "./events.ts";
import { type Game, eventTextsId, textsId } from "./game.ts";
import type { CopyTextsChange, ModChanges } from "./mod.ts";
import { LOGIC_CELL } from "./scene.ts";

/**
 * Kits: what makes a feature of one episode work in another, copied in one step (the
 * editor's Episode tab, Editor.addKit): its tile types (withTileTypes: class, shape,
 * description, sound, first take), the texts their classes show (classTexts) and the
 * events their code raises, in entries the episode never uses (spareEventEntries). A
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
  const plan: KitPlan = {
    types,
    present,
    texts,
    events,
    lacking,
    without: lacking.filter((id) => !given.has(id)),
  };
  if (problems.length > 0) plan.problem = problems.join("; ");
  return plan;
}

/** Types without a class that no room of the episode uses. */
function unusedFreeTypes(game: Game, episode: number): number[] {
  const used = new Set<number>();
  for (const room of game.episode(episode).rooms) {
    for (const layer of [room.base, room.overlay]) for (const cell of layer) used.add(cell & 0xff);
  }
  return freeTileTypes(game.image, episode).filter(
    (t) => t !== 0 && t !== LOGIC_CELL && !used.has(t),
  );
}

/**
 * The mod changes a plan makes (tileTypes, events with the kit episode's points, the
 * texts and the events' texts as copyTexts), for a mod or the editor to merge.
 */
export function kitChanges(
  source: Game,
  episode: number,
  kit: Kit,
  plan: KitPlan,
): Pick<ModChanges, "tileTypes" | "events" | "copyTexts"> {
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
    tileTypes: plan.types.length > 0 ? [{ episode, from: kit.from, types: plan.types }] : [],
    events: plan.events.map(({ entry, of, id }) => ({
      episode,
      entry,
      id,
      points: table[of]?.points ?? 0,
    })),
    copyTexts,
  };
}
