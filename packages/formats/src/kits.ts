import {
  CARD_READER_CLASS,
  type EpisodeClasses,
  PUNCH_CARD_CLASS,
  PUNCH_CLASS,
  SLIDING_DOOR_CLASS,
  classTexts,
  freeTileTypes,
} from "./classes.ts";
import { roomTileTypes } from "./describe.ts";
import { WOODS_CUT_THROUGH, readEpisodeFlags } from "./episode-flags.ts";
import { EVENT_TEXT, FIRST_EVENT_ENTRY, readEventTable, spareEventEntries } from "./events.ts";
import { type Game, eventTextsId, textsId } from "./game.ts";
import type { CodeChange, CopyTextsChange, ModChanges, TextChange } from "./mod.ts";
import { readVa } from "./pe.ts";
import { readOracleSymbols } from "./records.ts";
import { LOGIC_CELL } from "./scene.ts";

/**
 * Kits: what makes a feature of one episode work in another, copied in one step (the
 * editor's Episode tab, Editor.addKit): its tile types (withTileTypes: class, shape,
 * description, sound, first take, the hero states' icons and frames), the texts their
 * classes show (classTexts), the events their code raises, in entries the episode never
 * uses (spareEventEntries), and the MUSIC pieces the types' and events' sounds name
 * that the episode lacks. A type whose class the episode has already is not copied: the
 * circuits' stairs only go to Junior, and a kit in the episode it comes from has
 * nothing to do. See STATUS, "Fan episodes", for the pilots they come from, and
 * "Endings" for the goal.
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
  /**
   * A text the classes' code shows by number (`from`, the imm32 of a push at `va`), moved
   * to `to`, which no episode has: a code change makes the push show `to` (in every
   * episode, the code being shared), and the kit episode's entry `from` is copied to
   * `to` there and in the episode, German and English where they have texts. So the
   * episode keeps its own `from` (the goal's 994: the README.TXT joke in I and II,
   * the wood message in III).
   */
  textMove?: { va: number; from: number; to: number };
  /**
   * Events (ids) whose bonus box must not show: where the episode's entry for one has a
   * text, the id moves to a spare entry without one, else that text is removed. (The
   * goal's box would come first, and closing its text then does not end the game.)
   */
  quietEvents?: readonly number[];
  /**
   * Texts of the episode's texts (textsId) the feature shows that no class it copies
   * names (classTexts): the water's 230, whose class every episode with water has.
   * Copied where the episode lacks them.
   */
  texts?: readonly number[];
  /** When the game shows `texts`, for the view. */
  textsNote?: string;
  /** Episode flags (episode-flags.ts) the feature needs, set once it copies a type. */
  flags?: number;
  /** What the flags do, for the view. */
  flagsNote?: string;
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
  {
    key: "goal",
    name: "Goal",
    from: 0,
    types: [[0x32, "goal"]],
    events: [],
    // walked onto: event 298 (10000 points; text 1970, which only IV's helicopter uses
    // too), then text 994, whose closing ends the game (0x41f450, push 994 at 0x41f45e);
    // 1700: no episode has it, nothing in the code names or computes it
    textMove: { va: 0x41f45f, from: 994, to: 1700 },
    quietEvents: [298],
    example:
      "Junior's goal, 3 × 2 cells: walked onto, it gives 10000 points where the episode has its event, shows text 1700 (Junior's “Du hast es geschafft!”, to write anew in the Texts tab) and ends the game once that is closed.",
    note: "Junior's goal (tile 0x32, states 0–5 its 3 × 2 parts) ends the game: walked onto, it shows its text, and closing it ends the game as running out of lives does (the rank, the high scores). Its code shows text 994 in every episode, so a code patch makes it 1700, which no episode has: Junior's goal text is copied there, into this episode and into Junior.",
  },
  {
    key: "woods",
    name: "Woods & boots",
    from: 3,
    types: [
      [0x4c, "woods"],
      [0x4b, "hiking boots"],
    ],
    events: [],
    example:
      "Woods four cells across with a way through them (state 4) in the middle row, the hiking boots west of it: with them the hero gets through the way, a step on a coin flip.",
    note: "Woods (tile 0x4c in II–IV) block; their ways through (states 4 and 5) take the hero while he carries the hiking boots, each step on a coin flip (0x413c50). Only for Junior and I, which have no woods.",
  },
  {
    key: "axe",
    name: "Axe & bridges",
    from: 3,
    types: [
      [0x61, "axe"],
      [0x62, "hammer"],
      [0x2b, "timber"],
      [0x6e, "bridge"],
      [0x4c, "woods"],
      [0x12, "river"],
    ],
    // felling (0x447230) and building (0x447370): 6000 and 12000 points in III
    events: [335, 331],
    // the timber's message when the hero carries enough (0x415b1f, push 994): 994 is
    // Junior's goal and the README.TXT joke in I and II; 1701: no episode has it,
    // nothing in the code or the scripts names it (II's and IV's texts from 1400 on
    // are per room, and no episode has room 701)
    textMove: { va: 0x415b20, from: 994, to: 1701 },
    flags: WOODS_CUT_THROUGH,
    flagsNote: "felled woods let the hero through, so he can take the timber",
    example:
      "The axe and the hammer, woods three cells high and a river (state 2) three cells high: used, the axe fells the woods the hero walks into and leaves timber there; the hammer builds a bridge into the river he walks into, a hit at a time (five to finish one), each taking a unit of the timber's 20.",
    note: "III's axe fells woods (state 0) and leaves timber; with the timber the hammer builds bridges over rivers (state 2) and water. Brings the woods and a river where the episode has none, the hero's frames and icons for both tools, the timber's message (moved to text 1701, a code patch), the hammer's text 285, events 335 and 331 and the episode flag 0x20000.",
  },
  {
    key: "fire",
    name: "Fire & bucket",
    from: 3,
    types: [
      [0x67, "bucket"],
      [0x66, "fire"],
      [0x4f, "ash"],
      [0x12, "river"],
      [0x25, "water (current)"],
    ],
    // a fire put out (0x4142c0): 2000 points in every episode
    events: [261],
    example:
      "A river with a current east (a water cell, state 2) along the top, the bucket below it and two fires at the east end: swimming west, against the current, fills the bucket; used next to the fires it puts out those around the hero, which turn to ash.",
    note: "The bucket fills while the hero swims against a river's current (0x427450) and, used, puts out the fires in the 3 × 3 cells around him (0x4142c0), which turn to ash. Fire kills the hero who walks into it (text 947). Brings a river and water (the current's markers) where the episode has none.",
  },
  {
    key: "swimming",
    name: "Swimming",
    from: 3,
    types: [
      [0x60, "flippers"],
      [0x12, "river"],
      [0x25, "water (current)"],
    ],
    events: [],
    // shown by water and rivers while a script's NoSwim is set (0x427e40)
    texts: [230],
    textsNote: "shown while a room's script sets NoSwim; without it the hero always swims",
    example:
      "A river two rows high with a current east (a water cell, state 2), the flippers south of it: the current carries the hero east, with the flippers he swims against it.",
    note: "Rivers carry the hero along their current, which water cells set (direction by the state's low nibble, strength by its high one; 0x427f90); the flippers make him swim stronger (0x427450). Brings a river and water where the episode has none, and text 230, which water and rivers show while a room's script sets NoSwim.",
  },
  {
    key: "computer",
    name: "Computer",
    from: 1,
    types: [
      [0x08, "portable computer"],
      [0x41, "interface"],
    ],
    // the computer used (0x4524e0): 1000 points; the central computer's password (0x451508):
    // 5000 points, in Junior, I and II
    events: [289, 290],
    eventLabel: (id) => (id === 289 ? "computer used" : "password"),
    example:
      "An interface in the wall north of the cell east of the computer: the computer taken and used there (rucksack, “Benutzen”) connects to the central computer (RCP, password TOBOR).",
    note: "I's portable computer, used (rucksack, “Benutzen”), runs its programs (games, a directory, RCP; texts 550–555). Its RCP connects where an interface (tile 0x41) is next to the hero, by state: 0 south of him, 1 west, 2 north, 3 east (0x451577); with the password TOBOR it switches the room's doors, beam and arrows. It sends nothing to IV's punches.",
  },
  {
    key: "punchcards",
    name: "Punch cards",
    from: 4,
    types: [
      [0x59, "punch card"],
      [0x62, "card reader"],
      [0x5c, "punch"],
      [0x5b, "terminal"],
      [0x61, "sliding door"],
    ],
    // 0x419b30, a card used: next to a reader with an Area of its key, 352 (the square
    // turned); next to a train, 351 (its driving program); 0x430739, a card punched:
    // 353; 0x4307a2, a sliding door opening for its code: 350; 0x41aaa0, the hero
    // through it, the code used up: 370
    events: [352, 353, 350, 351, 370],
    eventLabel: (id) => PUNCH_CARD_EVENTS.get(id) ?? String(id),
    example:
      "The punch (address 2) with a blank card south-east of it, the terminal below, a card reader (address 7) with a square east of it and a sliding door below: the card used where it lies goes into the punch; at the terminal “MSG 2 AAAB” punches it with key 1; taken from the punch (walk into it) and used next to the reader, it turns the square a quarter with “Area(x, y, 3, 1);” in the room's script, (x, y) the square's top left. Punched with the door's code instead (on its sign, walked into), the card used there opens the door (or “MSG 7 code” at the terminal). Put the door into a wall running east–west. A card used stops at the first punch or reader next to it.",
    note: "IV's punch cards: a card's state is its key (0: blank). Used next to a card reader it turns the square of a script's Area(x, y, size, key) with its key (0x4302f0), else the reader sends the key to its address (state >> 4; a script's MsgPoll hears it). A blank card used next to the punch goes into it; a word sent to the punch's address (state & 0xf0 + 2, on its sign, text 532) punches it, by the terminal's “MSG address word” (word: four letters A–D, two bits each, AAAB = 1) or a script's MsgSend(address, key). A sliding door (states 0–2 in an east–west wall, 3–5 in a north–south one; 0, 1, 2: closed, opening, open) opens while its code waits at address 7, the doors' (readers with state 0x70 send there), and once the hero is through, the code is used up and it closes; its code is room ^ (state & 0xf0) ^ x ^ y (0x42fc00), its sign shows it (text 533). Punches and doors work only in an episode with the terminal's class, whose room-entered method starts them (0x419fc0). Brings the terminal's texts 520–524 and 965, which name IV's devices.",
  },
  {
    key: "train",
    name: "Train & tracks",
    from: 4,
    types: [
      [0x4a, "train"],
      [0x39, "rails"],
    ],
    events: [],
    example:
      "A loop of rails with a station on its west side, the train on the top row heading east: it goes round, waits at the station, and the hero walking onto the station from the west gets on.",
    note: "IV's train (an actor, direction = state >> 1: 0 north, 1 east, 2 south, 3 west) runs along rails (state: 0 north–south, 1 east–west, 2 a crossing, 3 and 4 stations, 5–8 bends: east–south, south–west, north–east, north–west; 0x483150) and waits at stations, the only rails the hero walks on. Off the rails it is gone. The hero rides it (hero state 9), steps off at a station with an arrow key, and takes it along into the next room on rails. A punch card used next to it gives it a driving program (event 351, the punch cards kit).",
  },
];

/** The punch cards kit's events by id, for the view. */
const PUNCH_CARD_EVENTS: ReadonlyMap<number, string> = new Map([
  [352, "square turned"],
  [353, "card punched"],
  [350, "door opened"],
  [351, "train program"],
  [370, "door closed behind"],
]);

/**
 * The code IV's sliding door at (x, y) of room `room` in state `state` opens for (0x42fc00):
 * the low byte of the room id, the state's high nibble and x ^ y, xored. A card punched
 * with it, used at a reader with address 7, or the word sent to 7, opens it.
 */
export function slidingDoorCode(room: number, x: number, y: number, state: number): number {
  return (room & 0xff) ^ (state & 0xf0) ^ ((x ^ y) & 0xff);
}

/**
 * A byte as the word IV's terminal takes for it (`MSG address word`, 0x42fae0): four
 * letters A–D, two bits each, the highest first (1 is AAAB). Any letter counts by
 * (code − 1) & 3, so E–H and the small letters work too; 0 has no word.
 */
export function networkWord(byte: number): string {
  return [6, 4, 2, 0].map((shift) => "ABCD"[(byte >> shift) & 3]).join("");
}

/**
 * What IV's network (the punch cards kit) makes of the cell value at (x, y) of room
 * `room`, for the editor's cell info: a sliding door's code there and the word for it, a
 * card's key, a punch's or a reader's address; undefined for other classes.
 */
export function networkNote(
  value: number,
  classes: EpisodeClasses,
  room: number,
  x: number,
  y: number,
): string | undefined {
  const id = classes.classes.get(value & 0xff)?.id;
  const state = value >> 8;
  if (id === SLIDING_DOOR_CLASS) {
    const code = slidingDoorCode(room, x, y, state);
    if (code === 0) return "door code 0 here: no word opens it";
    const word = networkWord(code);
    return `door code ${String(code)} = ${word} (“MSG 7 ${word}”, or a card with it at a reader of address 7)`;
  }
  if (id === PUNCH_CARD_CLASS)
    return state === 0 ? "blank card" : `card key ${String(state)} = ${networkWord(state)}`;
  if (id === PUNCH_CLASS) return `punch (printer) address ${String((state & 0xf0) + 2)}`;
  if (id === CARD_READER_CLASS) {
    const address = state >> 4;
    return `reader address ${String(address)}${address === DOORS_ADDRESS ? " (the doors)" : ""}`;
  }
  return undefined;
}

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
  /** The code changes it takes (textMove's push, unless the exe has it already). */
  code: CodeChange[];
  /** Texts copied to other numbers (textMove), into the episode and the kit episode. */
  textCopies: CopyTextsChange[];
  /**
   * Quiet events moved from an entry with a text to a spare one without: the entry's
   * points and sound go along, the old entry gets the spare's id and points.
   */
  moved: {
    entry: number;
    from: number;
    id: number;
    points: number;
    sound: string;
    freed: { id: number; points: number };
  }[];
  /** Entries of quiet events whose text (1800 + n) is removed: no spare entry was left. */
  silenced: number[];
  /** The episode's flags with the kit's (Kit.flags), where they lack some. */
  flags?: number;
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
  /** Whether text resource `resource` has entry n (default: as in `game`), for textMove. */
  hasEntry?: (resource: number, n: number) => boolean;
  /** Whether the episode's event texts (eventTextsId) have entry n (default: as in `game`). */
  hasEventText?: (n: number) => boolean;
  /** The lacking events to give entries, in order (default: as many as fit, in order). */
  events?: readonly number[];
  /** The episode's flags (default: as in `game`). */
  flags?: number;
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
  // what the copied classes' hero states need and cannot have (IV crashes without an icon)
  problems.push(
    ...game.heroStatesLacking(
      episode,
      kit.from,
      types.map(([, of]) => classes.get(of)?.id ?? 0),
    ),
  );
  const sourceTexts = source.texts(textsId(kit.from))?.entries;
  const hasText = options.hasText ?? ((n) => game.texts(textsId(episode))?.entries.has(n) === true);
  // the texts of every class the episode does not have by itself, copied by hand or not
  const native = source.episode(episode).classes.typeOfClass;
  const move = kit.textMove;
  const texts = [
    ...new Set([
      ...kit.types
        .map(([type]) => classes.get(type)?.id ?? 0)
        .filter((id) => !native.has(id))
        .flatMap((id) => classTexts(id)),
      ...(kit.texts ?? []),
    ]),
  ].filter((n) => sourceTexts?.has(n) === true && !hasText(n) && n !== move?.from);
  // the moved text: the push changed once, the entry copied where it is missing
  const code: CodeChange[] = [];
  const textCopies: CopyTextsChange[] = [];
  const foreign = kit.types.some(([type]) => !native.has(classes.get(type)?.id ?? 0));
  const flagsNow = options.flags ?? readEpisodeFlags(game.image, episode);
  const kitFlags = kit.flags ?? 0;
  const flags =
    foreign && (flagsNow & kitFlags) !== kitFlags ? (flagsNow | kitFlags) >>> 0 : undefined;
  if (move && foreign) {
    const imm = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, n >> 16, n >>> 24);
    // the bytes as a view of their own (a Buffer's slice shares its pool)
    const at = readVa(game.image, move.va, 4);
    const now = new DataView(at.buffer, at.byteOffset, 4).getUint32(0, true);
    if (now === move.from) code.push({ va: move.va, expect: imm(move.from), bytes: imm(move.to) });
    else if (now !== move.to) problems.push(`the code at 0x${move.va.toString(16)} is changed`);
    const hasEntry =
      options.hasEntry ?? ((resource, n) => game.texts(resource)?.entries.has(n) === true);
    for (const language of ["de", "en"] as const) {
      const from = textsId(kit.from, language);
      if (source.texts(from)?.entries.has(move.from) !== true) continue;
      for (const resource of new Set([textsId(kit.from, language), textsId(episode, language)])) {
        if (game.texts(resource) === undefined || hasEntry(resource, move.to)) continue;
        textCopies.push({ resource, from, entries: [[move.to, move.from]] });
      }
    }
  }
  const table = readEventTable(source.image, kit.from);
  const held = new Set(readEventTable(game.image, episode).map((e) => e.id));
  const entryOf = (id: number) => table.findIndex((e, n) => n >= FIRST_EVENT_ENTRY && e.id === id);
  const lacking = kit.events.filter((id) => !held.has(id) && entryOf(id) >= 0);
  const spareEntries = [...(options.spare ?? spareEventEntries(episode))];
  let chosen = options.events ?? lacking.slice(0, spareEntries.length);
  const notLacking = chosen.filter((id) => !lacking.includes(id));
  if (notLacking.length > 0)
    problems.push(`the episode has event ${notLacking.join(", ")} already or the kit has none`);
  if (chosen.length > spareEntries.length) {
    problems.push(`${chosen.length} events chosen, ${spareEntries.length} spare entries left`);
    chosen = chosen.slice(0, spareEntries.length);
  }
  const events = chosen
    .filter((id) => lacking.includes(id))
    .map((id, k) => ({ entry: spareEntries[k] ?? -1, of: entryOf(id), id }));
  const given = new Set(events.map((e) => e.id));
  // quiet events: off entries with a text, to spare entries without one left by `events`
  const eventTexts = game.texts(eventTextsId(episode))?.entries;
  const hasEventText = options.hasEventText ?? ((n) => eventTexts?.has(n) === true);
  const own = readEventTable(game.image, episode);
  const quietSpare = spareEntries.slice(events.length).filter((n) => !hasEventText(EVENT_TEXT + n));
  const moved: KitPlan["moved"] = [];
  const silenced: number[] = [];
  for (const id of kit.quietEvents ?? []) {
    const from = own.findIndex((e, n) => n >= FIRST_EVENT_ENTRY && e.id === id);
    if (from < 0 || !hasEventText(EVENT_TEXT + from)) continue;
    const entry = quietSpare.shift();
    if (entry === undefined) {
      silenced.push(from);
      continue;
    }
    const { points } = own[from] ?? { points: 0 };
    const freed = own[entry] ?? { id: 0, points: 0 };
    moved.push({ entry, from, id, points, sound: game.sound(episode, from), freed });
  }
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
    code,
    textCopies,
    moved,
    silenced,
  };
  if (flags !== undefined) plan.flags = flags;
  if (problems.length > 0) plan.problem = problems.join("; ");
  return plan;
}

/**
 * Types without a class that no room of the episode uses: in its maps, in the cells its
 * logic records hold (an oracle's object, what a teleporter or a circuit node shows, a
 * buried object) or inside a package (roomTileTypes).
 */
function unusedFreeTypes(game: Game, episode: number): number[] {
  const { rooms, classes } = game.episode(episode);
  const used = new Set(rooms.flatMap((room) => [...roomTileTypes(room, classes)]));
  return freeTileTypes(game.image, episode).filter(
    (t) => t !== 0 && t !== LOGIC_CELL && !used.has(t),
  );
}

/**
 * The mod changes a plan makes (tileTypes, events with the kit episode's points and
 * sounds, the pieces those sounds name that the episode lacks as music, the texts and
 * the events' texts as copyTexts; quiet events moved as events, their texts removed as
 * texts; the episode's flags), for a mod or the editor to merge. A plan for a second
 * kit or episode is made against the game with the first one's changes (planKit's `game`,
 * as the editor does): planned against the same exe, both would carry the moved text's
 * code change and its copy (the goal kit's 0x41f45f and text 1700), which a mod refuses
 * as changed twice.
 */
export function kitChanges(
  source: Game,
  episode: number,
  kit: Kit,
  plan: KitPlan,
): Pick<ModChanges, "music" | "tileTypes" | "events" | "code" | "copyTexts" | "texts" | "flags"> {
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
  for (const c of plan.textCopies)
    add(
      c.resource,
      c.from,
      c.entries.map(([to, of]) => [to, of]),
    );
  return {
    music: plan.music.length > 0 ? [{ episode, from: kit.from, pieces: plan.music }] : [],
    tileTypes: plan.types.length > 0 ? [{ episode, from: kit.from, types: plan.types }] : [],
    events: [
      ...plan.events.map(({ entry, of, id }) => {
        const sound = source.sound(kit.from, of);
        return {
          episode,
          entry,
          id,
          points: table[of]?.points ?? 0,
          ...(sound ? { sound } : {}),
        };
      }),
      ...plan.moved.flatMap(({ entry, from, id, points, sound, freed }) => [
        { episode, entry, id, points, ...(sound ? { sound } : {}) },
        { episode, entry: from, ...freed },
      ]),
    ],
    code: plan.code,
    copyTexts,
    texts: plan.silenced.map((n): TextChange => ({
      resource: eventTextsId(episode),
      entry: EVENT_TEXT + n,
      variants: null,
    })),
    flags: plan.flags === undefined ? [] : [{ episode, flags: plan.flags }],
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
  /**
   * What is left to do once the example lies with its top left cell at (x, y) of the
   * room, said with those positions (a script line, a code that depends on them).
   */
  placed?: (x: number, y: number) => string;
}

/** Circuit pieces (tile 0x42's states, circuits.ts) and letters (0x25's: the character). */
const [OR, WIRE_ACROSS, CORNER_DOWN, CORNER_UP, GATE_LEFT] = [0x00, 0x0a, 0x0c, 0x0d, 0x0e];
const [ZERO, ONE] = [0x30, 0x31];
/** Woods' way through (0x413c50: states 4 and 5). */
const WOODS_WAY = 4;
/** A river's open water, where the hammer builds (0x447370: state & 0xf = 2). */
const RIVER_OPEN = 2;
/** A water cell's current: direction east (0x481054: 2), strength 1 (high nibble 0). */
const CURRENT_EAST = 2;
/** The interface's state when it lies north of the computer's user (0x48349c). */
const INTERFACE_NORTH = 2;
/** Rail states (their ways at 0x483150: N 1, E 2, S 4, W 8, a station 0x20). */
const [RAIL_NS, RAIL_EW, RAIL_STATION_NS, RAIL_ES, RAIL_SW, RAIL_NE, RAIL_NW] = [
  0, 1, 3, 5, 6, 7, 8,
];
/** The sliding doors' address in IV's network (text 524: “Tür 7”). */
const DOORS_ADDRESS = 7;
/** A train heading east (its direction is state >> 1, 0x41c570). */
const TRAIN_EAST = 2;

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
 * - goal (3 × 2): its six parts in the base layer, as in Junior's room 43.
 * - woods (6 × 3): woods (state 0) four cells across, a way through them (state 4) in
 *   the middle row, the hiking boots west of it.
 * - axe (7 × 3): the axe and the hammer at x = 0, woods (state 0) at x = 2 and a river
 *   (state 2) at x = 5, three cells high.
 * - fire (7 × 3): a river (state 2) along the top with a water cell at x = 3 (a current
 *   east), the bucket at (0, 2), fires at (5, 1) and (5, 2).
 * - swimming (6 × 3): a river two rows high with a water cell at (2, 0) (a current
 *   east), the flippers at (0, 2).
 * - computer (3 × 2): the interface at (1, 0) (state 2: north of its user), the
 *   computer at (0, 1).
 * - punch cards (7 × 4): the punch (0, 0) with address 2, a blank card (1, 1), the
 *   reader (3, 1) with address 7 (the doors'), the terminal (0, 2), a sliding door
 *   (3, 3); another blank card at (5, 0), in the square (4..6, 0..2) a script's Area
 *   turns.
 * - train (6 × 3): a loop of rails, a station at (0, 1), the train at (2, 0) heading east.
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
  if (kit.key === "goal") {
    const [goal] = types;
    if (goal === undefined) return undefined;
    const w = 3;
    const base = Array.from({ length: 2 * w }, (_, k) => cell(0, k));
    return { w, h: 2, base, overlay: base.map(() => 0), records: [] };
  }
  if (kit.key === "woods") {
    const [woods, boots] = types;
    if (woods === undefined || boots === undefined) return undefined;
    const w = 6;
    const base = Array.from({ length: 3 * w }, (_, k) =>
      k % w === 0 || k % w === w - 1 ? 0 : cell(0, Math.floor(k / w) === 1 ? WOODS_WAY : 0),
    );
    const overlay = base.map(() => 0);
    overlay[w] = cell(1, 0);
    return { w, h: 3, base, overlay, records: [] };
  }
  if (kit.key === "axe") {
    if (types.some((t) => t === undefined)) return undefined;
    const w = 7;
    const base = Array.from({ length: 3 * w }, (_, k) =>
      k % w === 2 ? cell(4, 0) : k % w === 5 ? cell(5, RIVER_OPEN) : 0,
    );
    const overlay = base.map(() => 0);
    overlay[0] = cell(0, 0);
    overlay[2 * w] = cell(1, 0);
    return { w, h: 3, base, overlay, records: [] };
  }
  if (kit.key === "fire") {
    if (types.some((t) => t === undefined)) return undefined;
    const w = 7;
    const base = Array.from({ length: 3 * w }, (_, k) =>
      k === 3 ? cell(4, CURRENT_EAST) : k < w ? cell(3, RIVER_OPEN) : 0,
    );
    base[5 + w] = base[5 + 2 * w] = cell(1, 0);
    const overlay = base.map(() => 0);
    overlay[2 * w] = cell(0, 0);
    return { w, h: 3, base, overlay, records: [] };
  }
  if (kit.key === "swimming") {
    if (types.some((t) => t === undefined)) return undefined;
    const w = 6;
    const base = Array.from({ length: 3 * w }, (_, k) =>
      k === 2 ? cell(2, CURRENT_EAST) : k < 2 * w ? cell(1, RIVER_OPEN) : 0,
    );
    const overlay = base.map(() => 0);
    overlay[2 * w] = cell(0, 0);
    return { w, h: 3, base, overlay, records: [] };
  }
  if (kit.key === "computer") {
    const [computer, iface] = types;
    if (computer === undefined || iface === undefined) return undefined;
    const w = 3;
    const base = Array.from({ length: 2 * w }, () => 0);
    base[1] = cell(1, INTERFACE_NORTH);
    const overlay = base.map(() => 0);
    overlay[w] = cell(0, 0);
    return { w, h: 2, base, overlay, records: [] };
  }
  if (kit.key === "punchcards") {
    if (types.some((t) => t === undefined)) return undefined;
    const w = 7;
    const base = Array.from({ length: 4 * w }, () => 0);
    const overlay = base.slice();
    // a card used stops at the first punch or reader around it (0x419b30), so the
    // blank card's cell has the punch, not the reader, next to it
    overlay[0] = cell(2, 0); // the punch, address 2
    overlay[1 + w] = cell(0, 0); // a blank card
    overlay[3 + w] = cell(1, DOORS_ADDRESS << 4); // the reader, sending to the doors
    overlay[2 * w] = cell(3, 0); // the terminal
    overlay[5] = cell(0, 0); // in the square (4..6, 0..2): shows the turn
    overlay[3 + 3 * w] = cell(4, 0); // a sliding door, closed, passed north-south
    // the square's Area and the door's code, which depend on where it lies
    const placed = (x: number, y: number) => {
      const code = slidingDoorCode(room, x + 3, y + 3, 0);
      const word = networkWord(code);
      const door =
        code === 0
          ? "the door's code is 0 where it lies, which no word sends: move it"
          : `the door opens for ${word} where it lies: “MSG 7 ${word}” at the terminal, or a card punched with “MSG 2 ${word}” used at the reader`;
      return `Example placed. Add “Area(${String(x + 4)}, ${String(y)}, 3, 1);” to the room's script for the square (key 1: “MSG 2 AAAB”); ${door}.`;
    };
    return { w, h: 4, base, overlay, records: [], placed };
  }
  if (kit.key === "train") {
    const [train, rails] = types;
    if (train === undefined || rails === undefined) return undefined;
    const w = 6;
    const loop = [
      [RAIL_ES, RAIL_EW, RAIL_EW, RAIL_EW, RAIL_EW, RAIL_SW],
      [RAIL_STATION_NS, -1, -1, -1, -1, RAIL_NS],
      [RAIL_NE, RAIL_EW, RAIL_EW, RAIL_EW, RAIL_EW, RAIL_NW],
    ];
    const base = loop.flat().map((state) => (state < 0 ? 0 : rails | (state << 8)));
    const overlay = base.map(() => 0);
    overlay[2] = train | (TRAIN_EAST << 8);
    return { w, h: 3, base, overlay, records: [] };
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
