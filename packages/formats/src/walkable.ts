/**
 * Where the hero can walk: whether stepping onto a cell moves him there.
 *
 * Every step asks the target cell (0x44c6f0, from the step 0x44c9d0): tile type 0 lets
 * any actor on without asking; another cell's class decides through its touch method
 * (vtable +0x0c), which every class dispatches by the actor's kind, the hero's handler
 * being entry 0 (`ObjectClass.heroTouch`). The handler returns 1 when the actor moves
 * onto the cell, 3 when it has moved him itself (a door, a teleporter), anything else
 * keeps him where he is. Most classes have one of four constant handlers (0x41eca0
 * returns 1, 0x438d00 and 0x446f10 return 0, 0x424f90 returns 2); the others look at
 * the cell's state, the step's direction, the episode flags or what the hero carries.
 *
 * Logic cells (0x44c6f0's record branch): an overlay object, which the game turns into a
 * type 1 record on its base cell, is asked first and the base only if it lets the hero
 * on; a teleporter (type 13) with a condition (byte 7: 1, 2) depends on what he carries,
 * without one and with byte 1 bit 0 always lets him on, otherwise the cell it shows
 * decides, as for the other record types.
 *
 * Actors standing on a cell (robots, natives, the dealer) are not looked at: the tiles
 * that turn into actors when the room is entered leave an empty cell (tile type 0).
 */
import { ACTOR_LOAD_METHODS, type EpisodeClasses } from "./classes.ts";
import { HOUSE_EDGES_BLOCK_INSIDE } from "./episode-flags.ts";
import { teleporterCondition } from "./records.ts";
import { LOGIC_CELL, type Room } from "./scene.ts";

/**
 * How a cell takes the hero: "walk" he steps on it, "block" it keeps him off, "depends"
 * he steps on it only sometimes (by what he carries, the direction, chance).
 */
export type HeroStep = "walk" | "block" | "depends";

/** What a hero handler looks at besides the cell. */
interface StepContext {
  /** The episode's flags (episode-flags.ts). */
  flags: number;
  room: number;
}

type Rule = (state: number, context: StepContext) => HeroStep;

const walk: Rule = () => "walk";
const block: Rule = () => "block";
const depends: Rule = () => "depends";

/** Episode III's flag: woods in state 10 can be cut through too (0x413c50). */
const WOODS_CUT_THROUGH = 0x20000;
/** Episode III's flag: water takes the hero only in states with bit 0x10 (0x427e40). */
const WATER_NEEDS_BIT = 0x4000000;

/** "walk" in the states `walks` accepts, else "block". */
const byState =
  (walks: (state: number) => boolean): Rule =>
  (state) =>
    walks(state) ? "walk" : "block";

/**
 * The hero handlers by address (see the module comment). Those not listed depend on what
 * he carries, the step's direction, chance, the score or game variables, or take him
 * elsewhere (doors, stairs): "depends".
 */
const RULES: ReadonlyMap<number, Rule> = new Map<number, Rule>([
  [0x41eca0, walk],
  [0x438d00, block],
  [0x446f10, block],
  [0x424f90, block],
  // woods (class 0x5b): states 4 and 5 (the ways through), and 10 with flag 0x20000, take
  // him only while he carries the hiking boots (item 0x86, SHOE) and then on a coin flip
  // (0x436890(0, 1)); other actors walk them freely; the other states never
  [
    0x413c50,
    (state, { flags }) =>
      state === 4 || state === 5 || (state === 10 && (flags & WOODS_CUT_THROUGH) !== 0)
        ? "depends"
        : "block",
  ],
  // house (class 0x62): from state 9 on (low nibble) he walks on, unless flag 0x40000 in
  // rooms from 100 on; states 6 and 7 are doors in (walked into north or south)
  [
    0x413d30,
    (state, { flags, room }) => {
      const s = state & 0xf;
      if (s >= 9) return (flags & HOUSE_EDGES_BLOCK_INSIDE) !== 0 && room >= 100 ? "block" : "walk";
      return s === 6 || s === 7 ? "depends" : "block";
    },
  ],
  // sand (class 0x27): from state 8 on (low nibble) not; heaps (6, 7) let a scorpion out
  [0x41f9d0, byState((state) => (state & 0xf) < 8)],
  // water: he swims unless NoSwim is set (only episode II's scripts set it); with flag
  // 0x4000000 (III) only in states with bit 0x10
  [
    0x427e40,
    (state, { flags }) =>
      (flags & WATER_NEEDS_BIT) === 0 || (state & 0x10) !== 0 ? "walk" : "block",
  ],
  [0x427e30, block], // Junior's water
  [0x415520, byState((state) => state >= 8 && state <= 0xf)], // III's cave walls
  // III's and IV's rock: state 0x28 on a coin flip (0x436890(0, 2))
  [0x426d60, (state) => (state === 0x28 ? "depends" : "block")],
  // III's temple: state 9, and 7 and 8 while he carries item 0xef
  [0x4168c0, (state) => (state === 9 ? "walk" : state === 7 || state === 8 ? "depends" : "block")],
  [0x416800, block], // III's lava (it hurts)
  [0x4196f0, byState((state) => [3, 4, 0xc, 0xd].includes(state))], // IV's rails
  // bones: state 6 with item 0x79, 7 unless bones lie above, 8 never, the others always
  [0x412eb0, (state) => (state === 6 || state === 7 ? "depends" : state === 8 ? "block" : "walk")],
  // CORN: in state 0xd, else while he carries item 0x3f
  [0x40ef90, (state) => (state === 0xd ? "walk" : "depends")],
  [0x4272e0, walk], // gold: unless he has 150 already
  // the barrier: in even states while the registration check passes (below 70,000 points)
  [0x413e50, byState((state) => (state & 1) === 0)],
  [0x415020, walk], // III's ladder
  [0x41a9e0, byState((state) => (state & 0xf) % 3 === 2)], // IV's sliding doors, open
  [0x416b20, byState((state) => state >= 4)], // III's bridge, finished
  [0x416b70, byState((state) => state <= 4 || state === 0xa)], // III's pipes
  // cable ends, electrodes, IV's balls (these kill), switches, buttons and others
  ...[
    0x425f70, 0x4259d0, 0x419ad0, 0x4199b0, 0x419140, 0x41a790, 0x41a8b0, 0x4248b0, 0x421550,
    0x419830,
  ].map((handler): [number, Rule] => [handler, block]),
]);

/** How the cell (one layer's word) takes the hero, logic cells aside. */
function classStep(cell: number, classes: EpisodeClasses, context: StepContext): HeroStep {
  const type = cell & 0xff;
  if (type === 0) return "walk";
  const cls = classes.classes.get(type);
  if (!cls) return "block";
  // tiles that become actors leave tile type 0
  if (ACTOR_LOAD_METHODS.has(cls.loadMethod)) return "walk";
  const rule = cls.heroTouch === undefined ? undefined : RULES.get(cls.heroTouch);
  return (rule ?? depends)(cell >> 8, context);
}

/** Of two answers asked one after the other (the second only if the first lets him on). */
function then(first: HeroStep, second: () => HeroStep): HeroStep {
  if (first === "block") return "block";
  const next = second();
  return first === "walk" || next === "block" ? next : "depends";
}

const TELEPORTER = 13;
const ALWAYS_ENTERABLE = 0x01;

function logicStep(
  room: Pick<Room, "records">,
  cell: number,
  classes: EpisodeClasses,
  context: StepContext,
  depth = 0,
): HeroStep {
  if ((cell & 0xff) !== LOGIC_CELL) return classStep(cell, classes, context);
  const record = room.records.find((r) => r.slot === cell >> 8);
  if (!record || depth > 8) return "walk"; // a missing record shows an empty cell
  const data = record.data;
  const word = (at: number) => data[at] | (data[at + 1] << 8);
  const shown = () => logicStep(room, word(2), classes, context, depth + 1);
  if (data[0] === 1) return then(logicStep(room, word(4), classes, context, depth + 1), shown);
  if (data[0] === TELEPORTER) {
    if (teleporterCondition(data) !== "none") return "depends";
    if (data[7] === 0 && (data[1] & ALWAYS_ENTERABLE) !== 0) return "walk";
  }
  return shown();
}

/**
 * How each cell of the room takes the hero (index y * 40 + x), as the room is entered:
 * an overlay object over its base cell (the game's type 1 record), logic cells by their
 * records. `flags` are the episode's flags.
 */
export function heroSteps(room: Room, classes: EpisodeClasses, flags: number): HeroStep[] {
  const context: StepContext = { flags, room: room.id };
  return Array.from(room.base, (base, i) => {
    const overlay = room.overlay[i];
    const below = () => logicStep(room, base, classes, context);
    // an overlay logic cell is dropped when the room is entered
    if (overlay === 0 || (overlay & 0xff) === LOGIC_CELL) return below();
    return then(classStep(overlay, classes, context), below);
  });
}
