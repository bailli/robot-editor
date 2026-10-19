import {
  DIRECTIONS,
  type Direction,
  type EpisodeClasses,
  type Exits,
  OUTSIDE_ROOM,
  type Passage,
  type PassageKind,
  ROOM_WIDTH,
  type RecordTeleport,
  type Room,
  type ScriptBus,
  type ScriptExit,
  type ScriptTeleport,
  roomExits,
  roomPassages,
  roomScript,
  roomScriptExits,
  roomTeleports,
} from "@robot/formats";

export interface Connections {
  /** From the room's exits byte, on entering the room. */
  exits: Exits;
  /** Changes made by the room's script. */
  scripted: ScriptExit[];
  teleports: ScriptTeleport[];
  buses: ScriptBus[];
  /** Doors and stairs to room +/- 100. */
  passages: Passage[];
  /** Oracles and teleporters among the logic records. */
  records: RecordTeleport[];
}

export function connections(
  room: Room,
  ids: ReadonlySet<number>,
  classes: EpisodeClasses,
): Connections {
  const { exits, teleports, buses } = roomScriptExits(roomScript(room));
  const passages = roomPassages(room, classes, ids);
  const records = roomTeleports(room);
  return { exits: roomExits(room, ids), scripted: exits, teleports, buses, passages, records };
}

/** Where a direction leads regardless of the game state: the last fixed script assignment, else the exits byte. */
export function fixedExit(c: Connections, direction: Direction): number {
  const fixed = c.scripted.filter((s) => s.direction === direction && !s.conditional).at(-1);
  return fixed ? fixed.room : c.exits[direction];
}

const PASSAGE_KINDS: readonly PassageKind[] = ["door in", "door out", "stairs down", "stairs up"];

const LABELS: Readonly<Record<Direction, string>> = {
  north: "↑ North",
  south: "↓ South",
  west: "← West",
  east: "→ East",
};

/** The exits of the shown room as links to the rooms they lead to. */
export class ExitsView {
  readonly element = document.createElement("nav");
  private readonly go: (room: number) => void;
  private readonly label: (room: number) => string;

  /** `label` names a room in tooltips. */
  constructor(go: (room: number) => void, label: (room: number) => string) {
    this.go = go;
    this.label = label;
    this.element.className = "exits";
    this.element.setAttribute("aria-label", "Exits");
  }

  show(c: Connections): void {
    const items = DIRECTIONS.map((direction) => {
      const item = document.createElement("span");
      item.className = "exit";
      item.dataset["direction"] = direction;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = LABELS[direction];
      item.append(label, this.target(c.exits[direction], "from the room's exits byte"));
      for (const s of c.scripted.filter((x) => x.direction === direction)) {
        const how = s.conditional
          ? "set by the script, depending on the game state"
          : "set by the script";
        item.append(this.target(s.room, how, s.conditional ? "conditional" : "scripted"));
      }
      return item;
    });
    this.element.replaceChildren(...items);
    for (const kind of PASSAGE_KINDS) {
      const passages = c.passages.filter((x) => x.kind === kind);
      const targets = [...new Set(passages.map((x) => x.room))].map((room) => {
        const cells = passages.filter((x) => x.room === room).length;
        return this.target(room, `${cells} cell${cells === 1 ? "" : "s"}`);
      });
      const label = kind.charAt(0).toUpperCase() + kind.slice(1);
      this.group("passage", label, targets, kind);
    }
    this.group(
      "bus",
      "Bus",
      c.buses.map((b) =>
        this.target(
          b.room,
          `bus ${b.direction}, set by the script${b.conditional ? ", depending on the game state" : ""}`,
          b.conditional ? "conditional" : "scripted",
        ),
      ),
    );
    const at = (cell: number | undefined) =>
      cell === undefined ? "" : ` at (${cell % ROOM_WIDTH}, ${Math.floor(cell / ROOM_WIDTH)})`;
    const oracles = c.records.filter((r) => r.kind === "oracle");
    this.group(
      "oracles",
      "Oracles",
      oracles.map((r) =>
        this.target(
          r.room,
          `oracle${at(r.cell)}, teleports when walked onto northwards, arriving at (${r.x}, ${r.y})`,
        ),
      ),
    );
    this.group(
      "actors",
      "Actors",
      c.records
        .filter((r) => r.kind === "actor")
        .map((r) =>
          this.target(r.room, `an actor appears${at(r.cell)}, heading for (${r.x}, ${r.y})`),
        ),
    );
    const teleporters = c.records.filter((r) => r.kind === "teleporter");
    this.group("teleports", "Teleporters", [
      ...teleporters.map((r) =>
        this.target(
          r.room,
          `teleporter${at(r.cell)}, arriving at (${r.x}, ${r.y})` +
            (r.returns ? ", or back to where the hero came from" : ""),
        ),
      ),
      ...[...new Map(c.teleports.map((x) => [x.room, x])).values()].map((t) =>
        this.target(
          t.room,
          `the script's Teleport(${t.room}, ${t.x}, ${t.y}) sets where returning teleporters lead` +
            (t.conditional ? ", depending on the game state" : ""),
          t.conditional ? "conditional" : "scripted",
        ),
      ),
    ]);
  }

  /** A labelled group of targets (left out when empty). */
  private group(className: string, text: string, targets: HTMLElement[], direction?: string): void {
    if (targets.length === 0) return;
    const item = document.createElement("span");
    item.className = `exit ${className}`;
    if (direction) item.dataset["direction"] = direction;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = text;
    item.append(label, ...targets);
    this.element.append(item);
  }

  private target(room: number, how: string, kind = "default"): HTMLElement {
    if (room === 0) {
      const none = document.createElement("span");
      none.className = `target none ${kind}`;
      none.textContent = kind === "default" ? "—" : "closed";
      none.title = `no exit (${how})`;
      return none;
    }
    const button = document.createElement("button");
    button.className = `target ${kind}`;
    button.textContent = room === OUTSIDE_ROOM ? `${room} outside` : String(room);
    button.title = `${this.label(room)} (${how})`;
    button.addEventListener("click", () => {
      this.go(room);
    });
    return button;
  }
}
