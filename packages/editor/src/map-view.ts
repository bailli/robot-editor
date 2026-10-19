import {
  DIRECTIONS,
  type Direction,
  type EpisodeClasses,
  OUTSIDE_ROOM,
  type Room,
  edgeExits,
  exitMode,
  roomScript,
  roomScriptExits,
} from "@robot/formats";

import { type Connections, connections } from "./exits-view.ts";

/**
 * How a room's exit towards a grid neighbour stands: open by the exits byte ("open"; the
 * hero leaves over any walkable edge cell), open but with exit tiles that do not all
 * arrive on exit tiles of the neighbour ("broken"), opened only by the script
 * ("scripted"), or closed.
 */
export type LinkState = "open" | "broken" | "scripted" | "closed";

export interface MapLink {
  from: number;
  to: number;
  direction: Direction;
  state: LinkState;
  /** For people: what the exits byte, the exit tiles and the script say. */
  title: string;
}

const STEP: Readonly<Record<Direction, number>> = { north: -10, south: 10, west: -1, east: 1 };

/** Where a room sits on the map: its floor (hundreds), row (tens) and column (ones). */
export function mapPosition(id: number): { floor: number; row: number; column: number } {
  return { floor: Math.floor(id / 100), row: Math.floor((id % 100) / 10), column: id % 10 };
}

/** The grid neighbour in `direction` if it is drawn next to the room (same floor and row). */
export function adjacent(id: number, direction: Direction): number | undefined {
  const to = id + STEP[direction];
  if (to < 0) return undefined;
  const a = mapPosition(id);
  const b = mapPosition(to);
  if (a.floor !== b.floor) return undefined;
  if ((direction === "west" || direction === "east") && a.row !== b.row) return undefined;
  return to;
}

/** The exit of `room` towards its grid neighbour `target`, as the map shows it. */
export function mapLink(room: Room, direction: Direction, target: Room): MapLink {
  const mode = exitMode(room, direction);
  const scripted = roomScriptExits(roomScript(room)).exits.filter(
    (s) => s.direction === direction && s.room === target.id,
  );
  const { cells, matching } = edgeExits(room, direction, target);
  const tiles =
    cells.length === 0
      ? "no exit tiles on this edge (open floor leads out)"
      : `${cells.length} exit tile${cells.length === 1 ? "" : "s"}` +
        (matching.length === cells.length
          ? `, all arriving on exit tiles of ${target.id}`
          : `, ${cells.length - matching.length} not arriving on an exit tile of ${target.id}`);
  const script = scripted.length
    ? `; the script sets Room${direction.charAt(0).toUpperCase()}${direction.slice(1)} = ${target.id}` +
      (scripted.every((s) => s.conditional) ? " (depending on the game state)" : "")
    : "";
  let state: LinkState;
  if (mode === "neighbour") state = matching.length === cells.length ? "open" : "broken";
  else state = scripted.length ? "scripted" : "closed";
  const title =
    `${room.id} → ${target.id}: exits byte "${mode}"; ${tiles}${script}. ` +
    `Click to ${mode === "neighbour" ? "close" : "open"} it.`;
  return { from: room.id, to: target.id, direction, state, title };
}

/** A link of a room that the map shows as a badge (not to a grid neighbour drawn next to it). */
export interface MapBadge {
  room: number;
  text: string;
  title: string;
}

const ARROWS: Readonly<Record<Direction, string>> = {
  north: "↑",
  south: "↓",
  west: "←",
  east: "→",
};

/** The links of a room the grid does not show: passages, teleports, outside, far exits. */
export function mapBadges(room: Room, c: Connections): MapBadge[] {
  const badges = new Map<string, MapBadge>();
  const add = (target: number, text: string, title: string) => {
    if (target === 0) return;
    const key = `${text} ${target}`;
    if (!badges.has(key)) badges.set(key, { room: target, text: `${text} ${target}`, title });
  };
  for (const d of DIRECTIONS) {
    const target = c.exits[d];
    if (target === OUTSIDE_ROOM && room.id !== OUTSIDE_ROOM)
      add(target, ARROWS[d], `${d}: outside (room 2), from the exits byte`);
    else if (target !== 0 && adjacent(room.id, d) !== target)
      add(target, ARROWS[d], `${d}: room ${target}, from the exits byte`);
  }
  for (const s of c.scripted) {
    if (adjacent(room.id, s.direction) !== s.room)
      add(s.room, `${ARROWS[s.direction]}*`, `${s.direction}: room ${s.room}, set by the script`);
  }
  for (const p of c.passages) add(p.room, p.kind, `${p.kind} to room ${p.room}`);
  for (const r of c.records) add(r.room, r.kind, `${r.kind} to room ${r.room} at (${r.x}, ${r.y})`);
  for (const t of c.teleports)
    add(
      t.room,
      "Teleport()",
      `the script's Teleport() redirects teleporters that allow it to room ${t.room}`,
    );
  for (const b of c.buses) add(b.room, "bus", `the bus ${b.direction} to room ${b.room}`);
  return [...badges.values()];
}

export interface MapViewEvents {
  open(room: number): void;
  /** Whether the episode has this room. */
  exists(room: number): boolean;
  /** Opens or closes the exit of `room` towards its grid neighbour in `direction`. */
  toggle(room: number, direction: Direction): void;
  /** The room drawn small (filled in later if need be). */
  thumbnail(room: number): HTMLCanvasElement;
  /** The room's name, if it has one. */
  name(room: number): string | undefined;
  edited(room: number): boolean;
}

const LINK_ARROWS: Readonly<Record<Direction, string>> = {
  north: "▲",
  south: "▼",
  west: "◀",
  east: "▶",
};

/**
 * The episode's rooms on their grid, one block per floor (hundreds of the room id), with
 * the exits between neighbours as arrows that open or close them.
 */
export class MapView {
  readonly element = document.createElement("section");
  private readonly events: MapViewEvents;

  constructor(events: MapViewEvents) {
    this.events = events;
    this.element.className = "map-view";
    this.element.setAttribute("aria-label", "Map");
  }

  show(rooms: readonly Room[], current: number, classes: EpisodeClasses): void {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const floors = [...new Set(rooms.map((r) => mapPosition(r.id).floor))].sort((a, b) => a - b);
    this.element.replaceChildren(
      ...floors.map((floor) => {
        const own = rooms.filter((r) => mapPosition(r.id).floor === floor);
        return this.floor(floor, own, byId, current, classes);
      }),
    );
    this.element.querySelector(".map-room.current")?.scrollIntoView({ block: "nearest" });
  }

  private floor(
    floor: number,
    rooms: readonly Room[],
    byId: ReadonlyMap<number, Room>,
    current: number,
    classes: EpisodeClasses,
  ): HTMLElement {
    const section = document.createElement("div");
    section.className = "map-floor";
    const heading = document.createElement("h3");
    heading.textContent = `Rooms ${floor * 100}–${floor * 100 + 99}`;
    const grid = document.createElement("div");
    grid.className = "map-grid";
    const rows = rooms.map((r) => mapPosition(r.id).row);
    const columns = rooms.map((r) => mapPosition(r.id).column);
    const [row0, column0] = [Math.min(...rows), Math.min(...columns)];
    const width = Math.max(...columns) - column0 + 1;
    grid.style.gridTemplateColumns =
      width === 1
        ? "var(--map-room)"
        : `repeat(${width - 1}, var(--map-room) var(--map-link)) var(--map-room)`;
    const place = (element: HTMLElement, row: number, column: number) => {
      element.style.gridRow = String(row + 1);
      element.style.gridColumn = String(column + 1);
      grid.append(element);
    };
    const ids = new Set(byId.keys());
    for (const room of rooms) {
      const { row, column } = mapPosition(room.id);
      const [r, c] = [2 * (row - row0), 2 * (column - column0)];
      place(this.room(room, room.id === current, connections(room, ids, classes)), r, c);
      // links to the east and south neighbour (each pair once)
      for (const [direction, back, dr, dc] of [
        ["east", "west", 0, 1],
        ["south", "north", 1, 0],
      ] as const) {
        const id = adjacent(room.id, direction);
        const neighbour = id === undefined ? undefined : byId.get(id);
        if (!neighbour) continue;
        const links = [mapLink(room, direction, neighbour), mapLink(neighbour, back, room)];
        place(this.links(links, direction === "east"), r + dr, c + dc);
      }
    }
    section.append(heading, grid);
    return section;
  }

  private room(room: Room, current: boolean, c: Connections): HTMLElement {
    const box = document.createElement("div");
    box.className = "map-room";
    box.classList.toggle("current", current);
    box.classList.toggle("edited", this.events.edited(room.id));
    box.dataset["room"] = String(room.id);
    const open = document.createElement("button");
    open.className = "map-open";
    const name = this.events.name(room.id);
    open.title = `Room ${room.id}${name ? ` – ${name}` : ""}: open it`;
    open.setAttribute("aria-label", `Room ${room.id}${name ? ` ${name}` : ""}`);
    const label = document.createElement("span");
    label.className = "map-label";
    label.textContent = name ? `${room.id} ${name}` : String(room.id);
    open.append(this.events.thumbnail(room.id), label);
    open.addEventListener("click", () => {
      this.events.open(room.id);
    });
    box.append(open);
    const badges = mapBadges(room, c);
    if (badges.length) {
      const list = document.createElement("div");
      list.className = "map-badges";
      for (const badge of badges) {
        const b = document.createElement("button");
        b.className = "map-badge";
        b.textContent = badge.text;
        b.title = badge.title;
        b.disabled = !this.events.exists(badge.room);
        if (b.disabled) b.title += " (no such room)";
        b.addEventListener("click", () => {
          this.events.open(badge.room);
        });
        list.append(b);
      }
      box.append(list);
    }
    return box;
  }

  /** The two exits between neighbours, as arrows (east/west or south/north). */
  private links(links: readonly MapLink[], horizontal: boolean): HTMLElement {
    const box = document.createElement("div");
    box.className = `map-links ${horizontal ? "horizontal" : "vertical"}`;
    for (const link of links) {
      const arrow = document.createElement("button");
      arrow.className = `map-link ${link.state}`;
      arrow.dataset["from"] = String(link.from);
      arrow.dataset["direction"] = link.direction;
      arrow.textContent = LINK_ARROWS[link.direction];
      arrow.title = link.title;
      arrow.setAttribute("aria-label", `exit ${link.from} ${link.direction}`);
      arrow.addEventListener("click", () => {
        this.events.toggle(link.from, link.direction);
      });
      box.append(arrow);
    }
    return box;
  }
}
