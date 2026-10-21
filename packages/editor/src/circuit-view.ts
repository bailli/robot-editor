import { CIRCUIT_PIECES, type CircuitNode, ROOM_WIDTH, type RoomCircuit } from "@robot/formats";

export interface CircuitViewEvents {
  /** Selects a cell. */
  select(cell: number): void;
  /** Selects a node's cell and shows its record. */
  open(cell: number): void;
  /** Makes a piece (a cell value) the tile to paint with. */
  piece(value: number): void;
  /** A canvas showing a cell value. */
  preview(value: number): HTMLCanvasElement;
  /** Shows or hides the signals in the room. */
  signals(show: boolean): void;
  /** Adds a circuit node at the selected cell. */
  addNode(): void;
}

export interface CircuitContext {
  /** The shown room's id: stairs lead to id +/- 100. */
  room: number;
  /** The episode's room ids. */
  ids: ReadonlySet<number>;
  /** The tile types of LETTER and GATE in this episode (none outside episodes I, II). */
  letter?: number;
  gate?: number;
  /** A selected cell a node could be added at (not a logic cell), if any. */
  free?: number;
}

const where = (cell: number) => `(${cell % ROOM_WIDTH}, ${Math.floor(cell / ROOM_WIDTH)})`;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What a node's stairs are, for people. */
function stairsText(node: CircuitNode, context: CircuitContext): string | undefined {
  if (!node.stairs) return undefined;
  const target = context.room + (node.stairs.up ? -100 : 100);
  const to = context.ids.has(target)
    ? `to room ${target}`
    : `to room ${target}, which does not exist`;
  return `stairs ${node.stairs.up ? "up" : "down"} at ${where(node.stairs.cell)} ${to}`;
}

/**
 * The shown room's logic circuit (see circuits.ts in @robot/formats): which nodes are on
 * with the cells as they are, why the others are not, what they place, and the pieces
 * to build circuits with.
 */
export class CircuitView {
  readonly element = element("section", "circuit-view");
  private readonly events: CircuitViewEvents;
  private readonly toggle = element("input");

  constructor(events: CircuitViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Circuit");
    this.toggle.type = "checkbox";
    this.toggle.checked = true;
    this.toggle.addEventListener("change", () => {
      this.events.signals(this.toggle.checked);
    });
  }

  /** Whether the signals are to be shown in the room. */
  get signals(): boolean {
    return this.toggle.checked;
  }

  show(circuit: RoomCircuit, context: CircuitContext): void {
    const { nodes, final } = circuit;
    const on = nodes.filter((n) => n.scanned && n.signal === 1).length;
    const scanned = nodes.filter((n) => n.scanned).length;
    const heading = element(
      "h3",
      undefined,
      nodes.length === 0 ? "No circuit" : `Circuit: ${on} of ${scanned} nodes on`,
    );
    const parts: HTMLElement[] = [heading];
    if (nodes.length === 0) {
      parts.push(
        element(
          "p",
          "hint",
          "A circuit runs from letters 1 and 0 through GATE pieces into nodes (logic records of type 11), " +
            "traced westwards from each node. Lay pieces below, then add a node east of them.",
        ),
      );
    } else {
      const toggle = element("label", "circuit-toggle");
      toggle.append(this.toggle, " Show the signals in the room");
      parts.push(
        toggle,
        element(
          "p",
          "hint",
          "As the cells are now; the game evaluates the circuit whenever the hero takes or puts down a GATE piece.",
        ),
      );
    }
    if (final) {
      const stairs = stairsText(final, context);
      parts.push(
        element(
          "p",
          `circuit-final${circuit.allOn ? " on" : ""}`,
          `${stairs ? `The final node's ${stairs}` : "The final node"} ${
            circuit.allOn
              ? "appear: all nodes are on"
              : `appear once all ${scanned} nodes are on, itself included`
          }.`,
        ),
      );
    }
    parts.push(...nodes.map((node) => this.nodeRow(node, context)));
    if (circuit.problems.length > 0) {
      const list = element("ul", "circuit-problems");
      for (const problem of circuit.problems) {
        const item = element("li", problem.severity);
        const go = element("button", undefined, where(problem.cell));
        go.title = "Select the cell";
        go.addEventListener("click", () => {
          this.events.select(problem.cell);
        });
        item.append(go, ` ${problem.text}`);
        list.append(item);
      }
      parts.push(list);
    }
    parts.push(...this.palette(context));
    this.element.replaceChildren(...parts);
  }

  private nodeRow(node: CircuitNode, context: CircuitContext): HTMLElement {
    const row = element("div", "circuit-node");
    const state = !node.scanned
      ? "never evaluated"
      : node.signal === 1
        ? "on"
        : node.signal === 0
          ? "off"
          : "no signal";
    row.dataset["state"] = node.scanned ? String(node.signal) : "unscanned";
    const go = element(
      "button",
      undefined,
      `${node.final ? "Final node" : "Node"} ${node.slot} ${where(node.cell)}`,
    );
    go.title = "Select the node and open its record";
    go.addEventListener("click", () => {
      this.events.open(node.cell);
    });
    const dot = element("span", "circuit-dot");
    const text = element("span", "circuit-text", state);
    const details = [
      node.final ? undefined : stairsText(node, context),
      node.end && node.scanned ? node.end.reason : undefined,
    ].filter(Boolean);
    if (details.length > 0) text.textContent += ` – ${details.join("; ")}`;
    row.append(dot, go, text);
    return row;
  }

  /** The pieces to paint with, and adding a node. */
  private palette(context: CircuitContext): HTMLElement[] {
    const { letter, gate } = context;
    if (letter === undefined || gate === undefined) {
      return [
        element("p", "hint", "This episode has no circuit pieces (only episodes I and II do)."),
      ];
    }
    const grid = element("div", "circuit-pieces");
    const pieces = [
      { value: letter | (0x31 << 8), name: "1", text: "a source that is always on (a LETTER)" },
      { value: letter | (0x30 << 8), name: "0", text: "a source that is always off (a LETTER)" },
      ...CIRCUIT_PIECES.map((p) => ({ value: gate | (p.state << 8), name: p.name, text: p.text })),
    ];
    for (const piece of pieces) {
      const button = element("button", "circuit-piece");
      button.title = `${piece.name}: ${piece.text}. Click to paint with it`;
      button.append(this.events.preview(piece.value), element("span", undefined, piece.name));
      button.addEventListener("click", () => {
        this.events.piece(piece.value);
      });
      grid.append(button);
    }
    const add = element(
      "button",
      undefined,
      context.free === undefined ? "Add node" : `Add node at ${where(context.free)}`,
    );
    add.disabled = context.free === undefined;
    add.title =
      "A circuit node (logic record of type 11) at the selected cell; it reads the cell west of it";
    add.addEventListener("click", () => {
      this.events.addNode();
    });
    return [
      element("h4", undefined, "Pieces"),
      grid,
      element(
        "p",
        "hint",
        "Nodes are logic records: select a free cell with the Inspect tool to add one there. Its record (tab Record) sets the stairs it places and whether it is the final node.",
      ),
      add,
    ];
  }
}
