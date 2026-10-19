import {
  DIRECTIONS,
  type Direction,
  type EpisodeClasses,
  type Exits,
  OUTSIDE_ROOM,
  type Room,
  type ScriptExit,
  type ScriptTeleport,
  type Stairs,
  roomExits,
  roomScript,
  roomScriptExits,
  roomStairs,
} from "@robot/formats";

export interface Connections {
  /** From the room's exits byte, on entering the room. */
  exits: Exits;
  /** Changes made by the room's script. */
  scripted: ScriptExit[];
  teleports: ScriptTeleport[];
  stairs: Stairs[];
}

export function connections(
  room: Room,
  ids: ReadonlySet<number>,
  classes: EpisodeClasses,
): Connections {
  const { exits, teleports } = roomScriptExits(roomScript(room));
  const stairs = roomStairs(room, classes, ids);
  return { exits: roomExits(room, ids), scripted: exits, teleports, stairs };
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
      const rooms = [...new Set(stairs.map((x) => x.room))];
      if (rooms.length === 0) continue;
      const item = document.createElement("span");
      item.className = "exit stairs";
      item.dataset["direction"] = direction;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = direction === "up" ? "Stairs up" : "Stairs down";
      item.append(label);
      for (const room of rooms) {
        const cells = stairs.filter((x) => x.room === room).length;
        item.append(this.target(room, `${cells} stairs cell${cells === 1 ? "" : "s"}`));
      }
      this.element.append(item);
    }
    if (c.teleports.length > 0) {
      const item = document.createElement("span");
      item.className = "exit teleports";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = "Teleports";
      item.append(label);
      for (const t of new Map(c.teleports.map((x) => [x.room, x])).values()) {
        const how = `Teleport(${t.room}, ${t.x}, ${t.y})${t.conditional ? ", depending on the game state" : ""}`;
        item.append(this.target(t.room, how, t.conditional ? "conditional" : "scripted"));
      }
      this.element.append(item);
    }
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
