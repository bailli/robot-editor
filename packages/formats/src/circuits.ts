import type { EpisodeClasses } from "./classes.ts";
import { type Passage, STAIRS_CLASS } from "./exits.ts";
import { LOGIC_CELL, ROOM_CELLS, ROOM_WIDTH, type Room, resolveCell } from "./scene.ts";

/**
 * Logic circuits (episodes I and II, GameOfRobot.exe 0x40f700, 0x40f9a0). The code
 * works by class, so any episode whose class table maps the three classes has them
 * (Game.withTileTypes; tried in episode III).
 *
 * A circuit is nothing but cells: LETTER cells (class 59) with the state '1' or '0' are
 * the sources, GATE cells (class 76; pieces the hero carries, takes and puts down) the
 * wiring by state (CIRCUIT_PIECES), and circuit nodes (logic records of type 11, see
 * records.ts) the outputs. Whenever the hero takes or puts down a GATE piece (0x40fdf0,
 * 0x40fc50; not on entering the room, not for letters) the game evaluates every node
 * whose logic cell lies in columns 1-37, rows 2-26, row by row: it traces the node's
 * input westwards from the cell west of it. A node that changed turns its stairs on or
 * off (byte 5 not 0: placed at (byte 4, byte 5), up if byte 6, as a hero would put an
 * object down: not onto water, on top of what lies there; turned off, the cell is
 * emptied) and casts or drops a light (byte 8 holds it at run time). A final node (byte
 * 1 bit 0) does not place its stairs itself: they appear (event 0x127) once every node
 * of the room is on, the final one included, and go again when one goes off (byte 1 bit
 * 1 remembers it). The last final node of the scan counts.
 *
 * The trace (0x40f9a0) walks west, or up and down a gate's input legs, and stops on the
 * first cell that does not continue it: a '1' or '0' gives the signal, anything else
 * none (the game counts that as 0). A gate is two cells, its inputs half (state 0x0e)
 * west of its operator; input A comes from above the inputs half, B from below. The game
 * reads the cells as it holds them: logic cells as their record's cell, overlay objects
 * on top of the base (circuitCell).
 *
 * A node shows its record's cell with a BULB on top (class 77; 0x4329f2), lit while
 * byte 7 holds a 1 (nodeBulb).
 */

export const LETTER_CLASS = 59;
export const GATE_CLASS = 76;
/** The area the game looks for nodes in (inclusive). */
export const CIRCUIT_AREA = { x0: 1, x1: 37, y0: 2, y1: 26 } as const;
export const CIRCUIT_NODE_RECORD = 11;
export const BULB_CLASS = 77;

/**
 * The bulb drawn over a node (a BULB cell: state 1 lit, 0 not), or undefined where the
 * episode has none.
 */
export function nodeBulb(classes: EpisodeClasses, lit: boolean): number | undefined {
  const type = classes.typeOfClass.get(BULB_CLASS);
  return type === undefined ? undefined : type | (lit ? 0x100 : 0);
}

export type CircuitPieceKind = "gate" | "not" | "wire" | "corner" | "inputs";

export interface CircuitPiece {
  /** GATE state. */
  state: number;
  kind: CircuitPieceKind;
  name: string;
  /** What it does, for people. */
  text: string;
  /** Gates: the output from inputs A (above) and B (below). */
  output?: (a: number, b: number) => number;
}

const gate = (state: number, name: string, output: (a: number, b: number) => number) => ({
  state,
  kind: "gate" as const,
  name,
  text: `${name} gate: its inputs half lies west of it, A from above that, B from below`,
  output,
});

/** The GATE pieces by state (0x40f9a0; their texts are entries of the GATE tile type). */
export const CIRCUIT_PIECES: readonly CircuitPiece[] = [
  gate(0, "OR", (a, b) => a | b),
  gate(1, "AND", (a, b) => a & b),
  gate(2, "NOR", (a, b) => (a | b ? 0 : 1)),
  gate(3, "NAND", (a, b) => (a & b ? 0 : 1)),
  gate(4, "XOR", (a, b) => a ^ b),
  gate(5, "OR, A inverted", (a, b) => (a ? 0 : 1) | b),
  gate(6, "OR, B inverted", (a, b) => a | (b ? 0 : 1)),
  gate(7, "AND, A inverted", (a, b) => (a ? 0 : 1) & b),
  gate(8, "AND, B inverted", (a, b) => a & (b ? 0 : 1)),
  { state: 9, kind: "not", name: "NOT", text: "inverts the signal from the west" },
  { state: 0x0a, kind: "wire", name: "wire ─", text: "carries the signal from west to east" },
  { state: 0x0b, kind: "wire", name: "wire │", text: "carries a gate input up or down" },
  { state: 0x0c, kind: "corner", name: "corner ┐", text: "turns a signal from the west down" },
  { state: 0x0d, kind: "corner", name: "corner ┘", text: "turns a signal from the west up" },
  {
    state: 0x0e,
    kind: "inputs",
    name: "gate inputs",
    text: "a gate's west half: its inputs come from above (A) and below (B)",
  },
];

const PIECES = new Map(CIRCUIT_PIECES.map((p) => [p.state, p]));
const INPUTS = 0x0e;
const NOT = 9;
const WIRE_ACROSS = 0x0a;
const WIRE_DOWN = 0x0b;
const CORNER_FROM_BELOW = 0x0c;
const CORNER_FROM_ABOVE = 0x0d;

/** A signal: 1, 0, or -1 for none (the trace failed; the game counts it as 0). */
export type Signal = 0 | 1 | -1;

export interface CircuitCell {
  cell: number;
  /** The signal on the cell: a gate's or NOT's output on it, a wire's on a wire. */
  signal: Signal;
  role: "source" | CircuitPieceKind;
}

/** Where a trace stopped without a signal. */
export interface CircuitEnd {
  cell: number;
  /**
   * open: nothing that conducts lies there (yet), e.g. empty floor where the hero is
   * meant to lay pieces; broken: a piece lies there that does not fit.
   */
  kind: "open" | "broken";
  reason: string;
}

export interface CircuitNode {
  slot: number;
  /** The node's logic cell in the base layer. */
  cell: number;
  final: boolean;
  /** Inside the area the game looks for nodes in. */
  scanned: boolean;
  signal: Signal;
  /** The stairs it places (byte 5 not 0). */
  stairs?: { cell: number; up: boolean };
  /**
   * What the game keeps in the record at run time, 0 in the originals: the last signal
   * (byte 7) and, for a final node, whether its stairs are placed (byte 1 bit 1).
   */
  stored: { signal: number; placed: boolean };
  /** The cells its trace went through. */
  cells: CircuitCell[];
  /** Why it has no signal. */
  end?: CircuitEnd;
}

export interface CircuitProblem {
  cell: number;
  severity: "warning" | "note";
  text: string;
}

export interface RoomCircuit {
  /** Nodes in the order the game evaluates them (unscanned ones last). */
  nodes: CircuitNode[];
  /** The final node that counts, if any. */
  final?: CircuitNode;
  /** Every scanned node is on (what a final node waits for). */
  allOn: boolean;
  /** Each traced cell once, with its signal. */
  cells: CircuitCell[];
  problems: CircuitProblem[];
}

const at = (cell: number) => `(${cell % ROOM_WIDTH}, ${Math.floor(cell / ROOM_WIDTH)})`;

/**
 * A cell as the game holds it in its one-layer map: an overlay object lies on top of
 * the base cell (the game turns it into a stacked record), a logic cell shows its
 * record's cell. Returned as class id | state << 8, as the game compares them.
 */
export function circuitCell(room: Room, classes: EpisodeClasses, cell: number): number {
  const overlay = room.overlay[cell] ?? 0;
  const value =
    overlay !== 0 && (overlay & 0xff) !== LOGIC_CELL
      ? overlay
      : resolveCell(room, room.base[cell] ?? 0);
  const id = classes.classes.get(value & 0xff)?.id ?? 0;
  return (id & 0xff) | (value & 0xff00);
}

interface Trace {
  signal: Signal;
  cells: CircuitCell[];
  end?: CircuitEnd;
}

/** The water classes: stairs are never placed on their cells. */
const WATER_CLASSES: readonly number[] = [55, 82];

/**
 * Any trace longer than this loops (the game would hang). The game's own callers go
 * only west or vertically and leave the map, but traceCircuit is exported and with
 * (dx, dy) = (0, 0) a wire stands still: the guard stays.
 */
const MAX_STEPS = ROOM_CELLS * 4;

/**
 * The game's trace (0x40f9a0) from (x, y), looking at (x + dx, y + dy). `value` gives a
 * cell as circuitCell does, undefined outside the map. Like the game, cells are found
 * as x + y * 40 without a look at the column: west of column 0 is column 39 of the row
 * above (outside the map the game reads whatever lies next to it; here the trace ends).
 */
export function traceCircuit(
  value: (cell: number) => number | undefined,
  x: number,
  y: number,
  dx: number,
  dy: number,
): Trace {
  const chain: { cell: number; role: CircuitPieceKind }[] = [];
  const done = (signal: Signal, cells: CircuitCell[] = [], end?: CircuitEnd): Trace => ({
    signal,
    cells: [...chain.map((c) => ({ ...c, signal })), ...cells],
    ...(end ? { end } : {}),
  });
  for (let step = 0; step < MAX_STEPS; step++) {
    const cell = x + dx + (y + dy) * ROOM_WIDTH;
    const v = value(cell);
    const fail = (kind: CircuitEnd["kind"], reason: string) =>
      done(-1, [], { cell, kind, reason: `${at(cell)}: ${reason}` });
    if (v === undefined) return fail("open", "the trace leaves the room");
    const id = v & 0xff;
    const state = v >> 8;
    if (id === LETTER_CLASS) {
      const source = (signal: Signal) => done(signal, [{ cell, signal, role: "source" }]);
      if (state === 0x30) return source(0);
      if (state === 0x31) return source(1);
      return fail("broken", `the letter ${String.fromCharCode(state)} is neither 1 nor 0`);
    }
    if (id !== GATE_CLASS) {
      return fail("open", v === 0 ? "nothing lies there" : "no circuit piece lies there");
    }
    const piece = PIECES.get(state);
    const from = dx ? "the east" : dy < 0 ? "below" : "above";
    const misfit = () =>
      fail("broken", `the ${piece?.name ?? "piece"} cannot be entered from ${from}`);
    if (piece?.kind === "gate") {
      if (dx !== -1) return misfit();
      const inputs = x - 2 + y * ROOM_WIDTH;
      if (value(inputs) !== (GATE_CLASS | (INPUTS << 8))) {
        return fail("broken", `the ${piece.name} gate has no inputs half west of it`);
      }
      const a = traceCircuit(value, x - 2, y, 0, -1);
      const b = a.signal === -1 ? undefined : traceCircuit(value, x - 2, y, 0, 1);
      const signal: Signal =
        b === undefined || b.signal === -1 || !piece.output
          ? -1
          : piece.output(a.signal, b.signal) === 0
            ? 0
            : 1;
      const gateCells: CircuitCell[] = [
        { cell, signal, role: "gate" },
        { cell: inputs, signal, role: "inputs" },
      ];
      return done(signal, [...gateCells, ...a.cells, ...(b?.cells ?? [])], a.end ?? b?.end);
    }
    if (state === NOT) {
      if (dx !== -1) return misfit();
      const inner = traceCircuit(value, x - 1, y, -1, 0);
      const signal: Signal = inner.signal === -1 ? -1 : inner.signal ? 0 : 1;
      return done(signal, [{ cell, signal, role: "not" }, ...inner.cells], inner.end);
    }
    if (state === WIRE_ACROSS) {
      if (dy !== 0) return misfit();
      chain.push({ cell, role: "wire" });
      x += dx;
    } else if (state === WIRE_DOWN) {
      if (dx !== 0) return misfit();
      chain.push({ cell, role: "wire" });
      y += dy;
    } else if (state === CORNER_FROM_BELOW || state === CORNER_FROM_ABOVE) {
      if (dy !== (state === CORNER_FROM_BELOW ? -1 : 1)) return misfit();
      chain.push({ cell, role: "corner" });
      y += dy;
      dx = -1;
      dy = 0;
    } else if (state === INPUTS) {
      return fail("broken", "a gate's inputs half without its gate east of it");
    } else return fail("broken", `GATE state ${state} is no circuit piece`);
  }
  return done(-1, [], { cell: x + y * ROOM_WIDTH, kind: "broken", reason: "the trace loops" });
}

/** The room's circuit as the game evaluates it with the cells as they are now. */
export function roomCircuit(room: Room, classes: EpisodeClasses): RoomCircuit {
  const value = (cell: number) =>
    cell >= 0 && cell < ROOM_CELLS ? circuitCell(room, classes, cell) : undefined;
  const problems: CircuitProblem[] = [];
  const nodes: CircuitNode[] = [];
  const records = room.records.filter((r) => r.data[0] === CIRCUIT_NODE_RECORD);
  for (const record of records) {
    const cell = room.base.findIndex((v) => (v & 0xff) === LOGIC_CELL && v >> 8 === record.slot);
    if (cell < 0) continue;
    const [, flags = 0, , , sx = 0, sy = 0, up = 0, last = 0] = record.data;
    const x = cell % ROOM_WIDTH;
    const y = Math.floor(cell / ROOM_WIDTH);
    const { x0, x1, y0, y1 } = CIRCUIT_AREA;
    const scanned = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const trace = traceCircuit(value, x, y, -1, 0);
    nodes.push({
      slot: record.slot,
      cell,
      final: (flags & 1) !== 0,
      scanned,
      signal: trace.signal,
      ...(sy ? { stairs: { cell: sx + sy * ROOM_WIDTH, up: up !== 0 } } : {}),
      stored: { signal: last, placed: (flags & 2) !== 0 },
      cells: trace.cells,
      ...(trace.end ? { end: trace.end } : {}),
    });
  }
  // the game's order: row by row, west to east; unscanned nodes never count
  nodes.sort((a, b) => Number(b.scanned) - Number(a.scanned) || a.cell - b.cell);
  const scanned = nodes.filter((n) => n.scanned);
  const finals = scanned.filter((n) => n.final);
  const final = finals.at(-1);
  const cells = new Map<number, CircuitCell>();
  for (const node of scanned)
    for (const c of node.cells) if (!cells.has(c.cell)) cells.set(c.cell, c);

  for (const node of nodes) {
    const name = `${node.final ? "Final node" : "Node"} ${node.slot} at ${at(node.cell)}`;
    if (!node.scanned) {
      problems.push({
        cell: node.cell,
        severity: "warning",
        text: `${name} is never evaluated: the game looks for nodes in columns 1–37, rows 2–26 only`,
      });
      continue;
    }
    if (node.stored.signal !== 0) {
      problems.push({
        cell: node.cell,
        severity: "warning",
        text:
          `${name} starts with last signal ${node.stored.signal} (byte 7, kept by the game): ` +
          "it acts only on a change, so a node on from the start places no stairs; keep it 0",
      });
    }
    if (node.final && node.stored.placed) {
      problems.push({
        cell: node.cell,
        severity: "warning",
        text:
          `${name} starts as if its stairs were placed (byte 1 bit 1, kept by the game): ` +
          "they never appear, and the cell is emptied once a node is off; clear it",
      });
    }
    // open ends are where the hero is to lay pieces: the node itself says so
    if (node.end?.kind === "broken") {
      problems.push({
        cell: node.end.cell,
        severity: "warning",
        text: `${name} has no signal: ${node.end.reason}`,
      });
    }
    if (node.final && node !== final) {
      problems.push({
        cell: node.cell,
        severity: "warning",
        text: `${name} does not count: only the last final node of the room does (${final ? at(final.cell) : ""})`,
      });
    }
    if (node.final && !node.stairs) {
      problems.push({
        cell: node.cell,
        severity: "note",
        text: `${name} places no stairs (stairs y is 0)`,
      });
    }
    if (node.stairs) {
      const spot = node.stairs.cell;
      const there = value(spot) ?? 0;
      const id = there & 0xff;
      if (WATER_CLASSES.includes(id)) {
        problems.push({
          cell: spot,
          severity: "warning",
          text: `${name}: its stairs at ${at(spot)} are never placed, the cell is water`,
        });
      } else if (there !== 0 && id !== STAIRS_CLASS) {
        problems.push({
          cell: spot,
          severity: "note",
          text: `${name}: its stairs at ${at(spot)} are put on top of what lies there, which is gone once they disappear`,
        });
      }
    }
  }
  const on = scanned.find((n) => n.signal === 1);
  if (on) {
    problems.push({
      cell: on.cell,
      severity: "note",
      text: "Nodes on as the room is laid out light only once the hero takes or puts down a GATE piece",
    });
  }
  if (nodes.length > 0 && !classes.typeOfClass.has(GATE_CLASS)) {
    problems.unshift({
      cell: nodes[0]?.cell ?? 0,
      severity: "warning",
      text: "This episode has no circuit pieces (GATE, class 76): its circuits are never evaluated",
    });
  }
  return {
    nodes,
    ...(final ? { final } : {}),
    allOn: scanned.length > 0 && scanned.every((n) => n.signal === 1),
    cells: [...cells.values()],
    problems,
  };
}

/**
 * The stairs a room's circuit nodes place once lit (record bytes 4, 5: x, y, none if y
 * is 0; byte 6: up, else down), as passages to room +/- 100.
 */
export function roomCircuitStairs(room: Room, ids: ReadonlySet<number>): Passage[] {
  return room.records.flatMap((record): Passage[] => {
    const [type = 0, , , , x = 0, y = 0, up = 0] = record.data;
    if (type !== CIRCUIT_NODE_RECORD || y === 0) return [];
    const target = room.id + (up ? -100 : 100);
    return [
      {
        cell: y * ROOM_WIDTH + x,
        kind: up ? "stairs up" : "stairs down",
        room: ids.has(target) ? target : 0,
      },
    ];
  });
}
