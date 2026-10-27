import assert from "node:assert/strict";

import { expect, test } from "vitest";

import {
  CIRCUIT_PIECES,
  type RoomCircuit,
  circuitCell,
  nodeBulb,
  roomCircuit,
} from "../src/circuits.ts";
import { Game } from "../src/game.ts";
import { shownCells } from "../src/render.ts";
import { LOGIC_CELL, ROOM_CELLS, ROOM_WIDTH, type Room } from "../src/scene.ts";
import { exe } from "./data.ts";

const game = new Game(exe());
const classes = game.episode(1).classes;

const LETTER = 0x25;
const GATE = 0x42;
const FENCE = 0x07;
const one = LETTER | (0x31 << 8);
const zero = LETTER | (0x30 << 8);
const piece = (state: number) => GATE | (state << 8);
const [AND, NOT, ACROSS, DOWN, FROM_BELOW, FROM_ABOVE, INPUTS] = [
  1, 9, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
];

/** A room drawn from rows of cells: "1", "0", "-" "|" wires, "N" a node, etc. */
function room(
  cells: Record<string, number>,
  nodes: { x: number; y: number; data?: number[] }[],
): Room {
  const base = new Uint16Array(ROOM_CELLS);
  for (const [where, value] of Object.entries(cells)) {
    const [x = 0, y = 0] = where.split(",").map(Number);
    base[x + y * ROOM_WIDTH] = value;
  }
  const records = nodes.map(({ x, y, data = [] }, slot) => {
    base[x + y * ROOM_WIDTH] = LOGIC_CELL | (slot << 8);
    const bytes = new Uint8Array(10);
    bytes.set([11, ...data]);
    return { slot, data: bytes };
  });
  return {
    id: 50,
    tags: [],
    base,
    overlay: new Uint16Array(ROOM_CELLS),
    records,
    trailing: new Uint8Array(),
  };
}

const signals = (c: RoomCircuit) => c.nodes.map((n) => n.signal);

test("a node takes the signal west of it, through wires and NOT", () => {
  assert.deepEqual(signals(roomCircuit(room({ "9,5": one }, [{ x: 10, y: 5 }]), classes)), [1]);
  const wired = roomCircuit(
    room({ "6,5": zero, "7,5": piece(ACROSS), "8,5": piece(NOT), "9,5": piece(ACROSS) }, [
      { x: 10, y: 5 },
    ]),
    classes,
  );
  assert.deepEqual(signals(wired), [1]);
  // the wire west of the NOT carries 0, the NOT and the wire after it 1
  assert.deepEqual(Object.fromEntries(wired.cells.map((c) => [c.cell % ROOM_WIDTH, c.signal])), {
    6: 0,
    7: 0,
    8: 1,
    9: 1,
  });
});

test("a gate takes A from above its inputs half and B from below, also around corners", () => {
  const gate = (a: number, b: number) =>
    roomCircuit(
      room(
        {
          // A: up from the inputs half, a corner turns it west to the source
          "8,4": piece(DOWN),
          "8,3": piece(FROM_BELOW),
          "7,3": a,
          // B: down, then west
          "8,6": piece(FROM_ABOVE),
          "7,6": b,
          "8,5": piece(INPUTS),
          "9,5": piece(AND),
        },
        [{ x: 10, y: 5 }],
      ),
      classes,
    );
  assert.deepEqual(signals(gate(one, one)), [1]);
  assert.deepEqual(signals(gate(one, zero)), [0]);
  assert.deepEqual(signals(gate(zero, one)), [0]);
});

test("the gates work as the game's own truth tables say", () => {
  // texts of the GATE tile type in episode I: per state a table of A B │ Q
  const texts = game.episodeTexts(1)?.entries.get(GATE) ?? [];
  for (const p of CIRCUIT_PIECES.filter((p) => p.kind === "gate")) {
    const rows = [...(texts[p.state] ?? "").matchAll(/_([01])__([01])_│_([01])/g)];
    assert.equal(rows.length, 4, p.name);
    for (const [, a, b, q] of rows)
      assert.equal(p.output?.(Number(a), Number(b)), Number(q), p.name);
  }
});

test("traces stop where nothing conducts (open) or a piece does not fit (broken)", () => {
  const end = (cells: Record<string, number>) =>
    roomCircuit(room(cells, [{ x: 10, y: 5 }]), classes).nodes[0]?.end;
  expect(end({})).toMatchObject({ kind: "open", reason: "(9, 5): nothing lies there" });
  expect(end({ "9,5": piece(DOWN) })).toMatchObject({ kind: "broken" });
  expect(end({ "9,5": piece(AND) })).toMatchObject({
    kind: "broken",
    reason: "(9, 5): the AND gate has no inputs half west of it",
  });
  expect(end({ "9,5": LETTER | (0x41 << 8) })).toMatchObject({ kind: "broken" });
  expect(end({ "9,5": piece(INPUTS) })).toMatchObject({ kind: "broken" });
});

test("west of column 0 the trace goes on at the end of the row above, as the game's does", () => {
  // 0x40f9a0 reads the map at x + dx + (y + dy) * 40 without looking at the column
  const wrapped = room({ "0,5": piece(ACROSS), "39,4": one }, [{ x: 1, y: 5 }]);
  expect(signals(roomCircuit(wrapped, classes))).toEqual([1]);
});

test("pieces put down on other objects count, as the game stacks them", () => {
  const r = room({ "9,5": FENCE, "8,5": one }, [{ x: 10, y: 5 }]);
  assert.deepEqual(signals(roomCircuit(r, classes)), [-1]);
  r.overlay[9 + 5 * ROOM_WIDTH] = piece(ACROSS);
  assert.equal(circuitCell(r, classes, 9 + 5 * ROOM_WIDTH), 76 | (ACROSS << 8));
  assert.deepEqual(signals(roomCircuit(r, classes)), [1]);
});

test("the final node waits for all nodes, itself included; the last final one counts", () => {
  const c = roomCircuit(
    room({ "4,5": one, "9,5": one }, [
      { x: 5, y: 5 },
      { x: 10, y: 5, data: [1, 0, 0, 12, 20] },
      { x: 20, y: 5, data: [1] },
    ]),
    classes,
  );
  assert.equal(c.final?.slot, 2);
  assert.equal(c.allOn, false);
  expect(c.problems.map((p) => p.text)).toContain(
    "Final node 1 at (10, 5) does not count: only the last final node of the room does ((20, 5))",
  );
  const lit = roomCircuit(
    room({ "4,5": one, "9,5": one }, [
      { x: 5, y: 5 },
      { x: 10, y: 5, data: [1] },
    ]),
    classes,
  );
  assert.equal(lit.allOn, true);
});

test("what the game keeps in a node at run time is to start at 0", () => {
  const c = roomCircuit(
    room({ "9,5": one }, [{ x: 10, y: 5, data: [3, 0, 0, 12, 20, 0, 1] }]),
    classes,
  );
  expect(c.problems.map((p) => p.text)).toEqual([
    expect.stringMatching(/^Final node 0 at \(10, 5\) starts with last signal 1 \(byte 7/),
    expect.stringMatching(/^Final node 0 at \(10, 5\) starts as if its stairs were placed/),
    expect.stringMatching(/^Nodes on as the room is laid out/),
  ]);
});

test("nodes outside columns 1-37, rows 2-26 are never evaluated", () => {
  const c = roomCircuit(room({ "38,1": one }, [{ x: 39, y: 1 }]), classes);
  assert.equal(c.nodes[0]?.scanned, false);
  assert.equal(c.allOn, false);
  expect(c.problems[0]?.text).toMatch(/is never evaluated/);
});

test("a node shows its record's cell with a bulb on top, lit while byte 7 is", () => {
  const BULB = 0x43; // tile type 67, class 77
  assert.equal(nodeBulb(classes, false), BULB);
  const off = room({}, [{ x: 10, y: 5, data: [0, FENCE] }]);
  const cell = 10 + 5 * ROOM_WIDTH;
  assert.deepEqual(shownCells(off, cell, classes), [FENCE, BULB, false]);
  const on = room({}, [{ x: 10, y: 5, data: [0, 0, 0, 0, 0, 0, 1] }]);
  assert.deepEqual(shownCells(on, cell, classes), [0, BULB | 0x100, false]);
  // as the circuit lights it
  assert.deepEqual(
    shownCells(on, cell, classes, undefined, () => false),
    [0, BULB, false],
  );
  // not under an overlay object
  on.overlay[cell] = FENCE;
  assert.deepEqual(shownCells(on, cell, classes), [0, FENCE, false]);
});

test("the original circuits", () => {
  const summary = (episode: number, id: number) => {
    const c = roomCircuit(game.room(episode, id), game.episode(episode).classes);
    return [
      ...c.nodes.map(
        (n) =>
          `${n.final ? "final " : ""}node ${n.slot} (${n.cell % ROOM_WIDTH}, ${Math.floor(n.cell / ROOM_WIDTH)}): ` +
          `${n.signal}${n.end ? ` ${n.end.kind} ${n.end.reason}` : ""}`,
      ),
      ...c.problems.map((p) => `${p.severity}: ${p.text}`),
    ];
  };
  expect({
    "I 128": summary(1, 128),
    "II 142": summary(2, 142),
    "I 99": summary(1, 99),
  }).toMatchSnapshot();
});
