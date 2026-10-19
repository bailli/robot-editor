import {
  DIRECTIONS,
  type Direction,
  type EpisodeClasses,
  type Exits,
  OUTSIDE_ROOM,
  ROOM_WIDTH,
  type RecordTeleport,
  type Room,
  type ScriptExit,
  type ScriptTeleport,
  type Stairs,
  roomExits,
  roomScript,
  roomScriptExits,
  roomStairs,
  roomTeleports,
} from "@robot/formats";

export interface Connections {
  /** From the room's exits byte, on entering the room. */
  exits: Exits;
  /** Changes made by the room's script. */
  scripted: ScriptExit[];
  teleports: ScriptTeleport[];
  stairs: Stairs[];
  /** Oracles and teleporters among the logic records. */
  records: RecordTeleport[];
}

export function connections(
  room: Room,
  ids: ReadonlySet<number>,
  classes: EpisodeClasses,
): Connections {
  const { exits, teleports } = roomScriptExits(roomScript(room));
  const stairs = roomStairs(room, classes, ids);
  const records = roomTeleports(room);
  return { exits: roomExits(room, ids), scripted: exits, teleports, stairs, records };
}

/** Where a direction leads regardless of the game state: the last fixed script assignment, else the exits byte. */
export function fixedExit(c: Connections, direction: Direction): number {
  const fixed = c.scripted.filter((s) => s.direction === direction && !s.conditional).at(-1);
  return fixed ? fixed.room : c.exits[direction];
}

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

  constructor(go: (room: number) => void) {
    this.go = go;
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
    for (const direction of ["up", "down"] as const) {
      const stairs = c.stairs.filter((x) => x.direction === direction);
      const targets = [...new Set(stairs.map((x) => x.room))].map((room) => {
        const cells = stairs.filter((x) => x.room === room).length;
        return this.target(room, `${cells} stairs cell${cells === 1 ? "" : "s"}`);
      });
      this.group("stairs", direction === "up" ? "Stairs up" : "Stairs down", targets, direction);
    }
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
          `Teleport(${t.room}, ${t.x}, ${t.y})${t.conditional ? ", depending on the game state" : ""}`,
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
    button.title = `room ${room} (${how})`;
    button.addEventListener("click", () => {
      this.go(room);
    });
    return button;
  }
}
