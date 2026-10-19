/**
 * What the names of room scripts mean: the game's functions (handlers in the keyword table
 * 0x4750d8) and variables, decoded from the handlers. Arguments in source order; `obj` is
 * a tile type with a state in the high byte (O_KEY | 0x0200).
 *
 * How scripts run: on entering a room its script runs once from the top (0x4394f3). The
 * event functions (Event, E_Take, …) do not test anything then: they register the code
 * after their call as a handler (0x407b30, 20 handlers at 0x4c5df8) and return 0, so the
 * block they guard is skipped. When the event happens (0x408970), the script continues at
 * that block with E_Value set until `return` (or the end: without a `return` it runs on
 * into the code after the block). Room 1's script is the global one (run when an episode
 * starts or a game is loaded); its handlers run when no handler of the room matches.
 * Events: 1 take (filter: tile type, E_Value: the object), 2 drop (the same), 4 walk area
 * (filter: area number, E_Value +n entering, −n leaving), 8 entering the room (filter and
 * E_Value: the room), 16 slot (filter and E_Value: the slot number, state bits 12–15).
 */
import { KEYWORD_FUNCTION, type ScriptKeyword } from "./script.ts";

/** What a number argument refers to, where the editor can show it. */
export type ScriptArgumentKind = "text" | "room";

/** Arguments that give a place in the room: indices of x, y and of width, height. */
export interface ScriptPlace {
  x: number;
  y: number;
  /** A cell if absent; a square when w and h are the same argument. */
  w?: number;
  h?: number;
}

export interface ScriptFunctionDoc {
  /** Argument names in source order. */
  args: readonly string[];
  /** What the arguments refer to, by position. */
  kinds?: readonly (ScriptArgumentKind | undefined)[];
  /** The places in the room the arguments give. */
  places?: readonly ScriptPlace[];
  doc: string;
}

const CELL = (x: number, y: number): ScriptPlace => ({ x, y });
const RECT = (x: number): ScriptPlace => ({ x, y: x + 1, w: x + 2, h: x + 3 });

const HANDLER =
  "Registers the block after it as a handler and returns 0 when the script runs; " +
  "when the event happens the script continues there (end the block with return).";

/** By upper-case name; Area has two forms, keyed AREA/3 and AREA/4. */
const FUNCTIONS: Readonly<Partial<Record<string, ScriptFunctionDoc>>> = {
  MESSAGE: {
    args: ["text", "delay"],
    kinds: ["text"],
    doc:
      "delay 0: shows one of the text's variants (|) at random at once (0x406450); else, " +
      "once the hero has been `delay` seconds in the room (nothing if that time has " +
      "passed), all variants as pages one after another (Enter, arrows; 0x405fe0). A text " +
      "starting with ! opens a different box.",
  },
  ARROWS: {
    args: ["on"],
    doc: "starts (1) or stops (0) the arrow tiles (O_ARROW) turning at random.",
  },
  BEAM: {
    args: ["on", "n"],
    doc: "switches beam n on or off (emitters whose state bits 12–15 are n).",
  },
  PHONE: {
    args: ["text", "delay", "n"],
    kinds: ["text"],
    doc:
      "lets the phone ring after `delay` seconds in the room; answering plays text `text` " +
      "(n: probably the number of rings). Episode II.",
  },
  PRINTSTR: { args: ["string"], doc: "shows a string in a message box (debugging; unused)." },
  PRINTVAL: { args: ["value"], doc: "shows a number in a message box (debugging; unused)." },
  PERC: { args: ["p"], doc: "1 with a probability of p %, else 0 (unused)." },
  SETOBJ: {
    args: ["obj", "x", "y", "mode"],
    places: [CELL(1, 2)],
    doc:
      "puts obj on cell (x, y): mode 0 like the hero dropping it (combined with what is " +
      "there; message 990 if it cannot be), 1 replaces the top object (obj 0 removes it), " +
      "2 clears the cell first. Creatures placed come alive.",
  },
  GETOBJ: {
    args: ["x", "y"],
    places: [CELL(0, 1)],
    doc: "the object at cell (x, y): tile type | state << 8, logic records resolved.",
  },
  SETMAN: {
    args: ["obj", "x", "y", "room", "tx", "ty"],
    kinds: [undefined, undefined, undefined, "room"],
    places: [CELL(1, 2)],
    doc:
      "lets a travelling actor (O_DEALER, or class 0x4a) appear at (x, y), or moves the one " +
      "that is there, heading for `room` at (tx, ty).",
  },
  RANDOBJ: {
    args: ["obj", "min", "max"],
    doc:
      "keeps the number of obj in the room between min and max: removes random ones, adds " +
      "missing ones on empty cells (robots and androids away from where the hero entered).",
  },
  EXIST: { args: ["obj"], doc: "how many of obj are in the room (map cells and actors)." },
  HAVESEEN: {
    args: ["room"],
    kinds: ["room"],
    doc: "1 if the hero has been in `room`, else 0.",
  },
  POSSESS: {
    args: ["obj"],
    doc:
      "with a state (O_KEY | 0x0100): 1 if the hero carries exactly that object; " +
      "without: how many of that kind the hero carries.",
  },
  OPOSSESS: {
    args: ["obj"],
    doc: "how many objects of obj's kind the hero carries, whatever their state.",
  },
  TAKE: {
    args: ["obj"],
    doc: "puts obj into the inventory as if picked up (raises the take event); 1 if it fits.",
  },
  DROP: {
    args: ["obj"],
    doc: "takes obj (exact state) out of the inventory as if dropped (raises the drop event); 1 if done.",
  },
  E_TAKE: {
    args: ["type"],
    doc: `event: the hero takes an object of tile type \`type\`. ${HANDLER}`,
  },
  E_DROP: {
    args: ["type"],
    doc: `event: the hero drops an object of tile type \`type\`. ${HANDLER}`,
  },
  SETWAREA: {
    args: ["x", "y", "w", "h"],
    places: [RECT(0)],
    doc:
      "defines a walk area (up to 8 per room, numbered 1… in the order defined; returns " +
      "its number − 1): entering or leaving it raises event 4 with E_Value +n / −n.",
  },
  E_AREA: { args: ["n"], doc: `event: the hero enters or leaves walk area n. ${HANDLER}` },
  E_SLOT: {
    args: ["n"],
    doc: `event 16 for slot n (state bits 12–15 of the slot's cell). ${HANDLER}`,
  },
  E_NEWROOM: {
    args: ["room"],
    kinds: ["room"],
    doc: `event: the hero enters \`room\` (for the global script in room 1). ${HANDLER}`,
  },
  EVENT: {
    args: ["mask"],
    doc:
      "event: any of the events in mask (1 take, 2 drop, 4 walk area, 8 entering the room, " +
      `16 slot); the call's value in the handler says which (or E_Value). ${HANDLER}`,
  },
  ENIGMA: {
    args: ["n"],
    doc:
      "a puzzle solved for the first time: entry n of the episode's table gives points, a " +
      "sound and a text (once only); 1 the first time, else 0.",
  },
  TELEPORT: {
    args: ["room", "x", "y"],
    kinds: ["room"],
    doc:
      "redirects the teleporters whose record allows a script target (flag 0x02) to `room` " +
      "at (x, y), from now on; room 0 gives them their own target back. Does not move the " +
      "hero.",
  },
  SETNIGHT: { args: ["level"], doc: "sets the darkness (Night, 0–100) and redraws the room." },
  GETNIGHT: {
    args: ["room"],
    kinds: ["room"],
    doc: "the darkness of `room` (its tag kind 2; 100 for rooms from 100 on in some game states).",
  },
  MSGSEND: {
    args: ["a", "b"],
    doc: "puts the pair (a, b) into a mailbox of 32 pairs (unused in the scripts).",
  },
  MSGPOLL: {
    args: ["a", "b"],
    doc: "takes a pair (a, b) out of the mailbox (b < 0: any) and returns its b, else 0 (unused).",
  },
  "AREA/3": {
    args: ["x", "y", "size"],
    places: [{ x: 0, y: 1, w: 2, h: 2 }],
    doc: "a square of cells whose rings rotate (e.g. episode I's endless labyrinth).",
  },
  "AREA/4": {
    args: ["x", "y", "size", "key"],
    places: [{ x: 0, y: 1, w: 2, h: 2 }],
    doc: "a rotating square (up to 4) turned by a switch whose key matches.",
  },
  SHIFTAREA: {
    args: ["x", "y", "w", "h", "d"],
    places: [RECT(0)],
    doc: "an area of cells that shift (d: probably the direction); not decoded in detail.",
  },
  WIZZARD: {
    args: ["x", "y", "room", "rx", "ry", "ax", "ay", "aw", "ah"],
    kinds: [undefined, undefined, "room"],
    places: [CELL(0, 1), RECT(5)],
    doc:
      "the wizard at (x, y) sends the hero to `room` at (rx, ry); outside the area " +
      "(ax, ay, aw, ah) he mutters a spell (text 993). Episode I.",
  },
};

const VARIABLES: Readonly<Partial<Record<string, string>>> = {
  NIGHT: "the room's darkness, 0–100 (from its tag kind 2 on entering; see SetNight)",
  SCORE: "the points",
  GOLD: "the gold the hero carries",
  LIFE: "the hero's lives",
  ROOM: "the current room",
  LASTROOM: "the room the hero came from",
  NXTROOM: "the room the hero goes to next",
  NEWROOM: "1 on the first visit of the room in this game, else 0",
  ROOMTIME: "seconds since the hero entered the room",
  ROOMNORTH: "where the north exit leads (0: closed); set from the exits byte on entering",
  ROOMSOUTH: "where the south exit leads (0: closed)",
  ROOMWEST: "where the west exit leads (0: closed)",
  ROOMEAST: "where the east exit leads (0: closed)",
  BUSEAST: "where the bus goes east (episode II)",
  BUSWEST: "where the bus goes west (episode II)",
  E_VALUE: "the value of the event being handled (the object, ±area, the room, the slot)",
  HEROX: "the hero's column (read only: writes are lost)",
  HEROY: "the hero's row (read only: writes are lost)",
  VAL1: "a free variable, kept across rooms",
  VAL2: "a free variable, kept across rooms",
  VAL3: "a free variable, kept across rooms",
  VAL4: "a free variable, kept across rooms",
  VAL5: "a free variable, kept across rooms",
  VAL6: "a free variable, kept across rooms",
  VAL7: "a free variable, kept across rooms",
  VAL8: "a free variable, kept across rooms",
  STATIONBOFF: "an episode IV flag (probably: power station B is off)",
  NOSWIM: "an episode III/IV flag (probably: swimming is not possible)",
};

/**
 * How the game shows a text with several variants (separated by |) that a call names:
 * as pages one after another, one of them at random, or not known (also when it depends
 * on an argument that is not a plain number).
 */
export function scriptTextVariants(
  fn: string,
  args: readonly (number | undefined)[],
): "pages" | "random" | undefined {
  if (fn.toUpperCase() !== "MESSAGE") return undefined;
  const delay = args[1];
  if (delay === undefined) return undefined;
  return delay === 0 ? "random" : "pages";
}

/** The function's documentation, by name and number of arguments. */
export function scriptFunctionDoc(name: string, args?: number): ScriptFunctionDoc | undefined {
  const key = name.toUpperCase();
  return (args === undefined ? undefined : FUNCTIONS[`${key}/${args}`]) ?? FUNCTIONS[key];
}

/** What argument `index` (0 = first) of a call to `fn` with `count` arguments refers to. */
export function scriptArgument(
  fn: string,
  index: number,
  count: number,
): ScriptArgumentKind | undefined {
  return scriptFunctionDoc(fn, count)?.kinds?.[index];
}

/**
 * One text about a name: its signature (or type) and meaning, for the game's keywords;
 * undefined for names the game does not know.
 */
export function scriptDoc(name: string, keywords: readonly ScriptKeyword[]): string | undefined {
  const known = keywords.filter((k) => k.name.toUpperCase() === name.toUpperCase());
  if (known.length === 0) return undefined;
  return known
    .map((k) => {
      const at = `0x${k.address.toString(16)}`;
      if (k.flags & KEYWORD_FUNCTION) {
        const doc = scriptFunctionDoc(k.name, k.args);
        const args = doc?.args ?? Array.from({ length: k.args }, (_, i) => `arg${i + 1}`);
        return `${k.name}(${args.join(", ")}): ${doc?.doc ?? "not decoded yet."} (${at})`;
      }
      const width = VARIABLE_WIDTHS[k.flags & 7] ?? "?";
      const doc = VARIABLES[k.name.toUpperCase()];
      return `${k.name}: ${doc ?? "a game variable"} (${width} at ${at})`;
    })
    .join("\n");
}

const VARIABLE_WIDTHS: Readonly<Partial<Record<number, string>>> = {
  1: "signed byte",
  2: "signed word",
  3: "dword",
  4: "byte",
  5: "word",
};
