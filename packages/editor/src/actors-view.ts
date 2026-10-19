import { type ActorSource, ROOM_WIDTH, type RoomActor, type ScriptActors } from "@robot/formats";

export interface ActorsViewEvents {
  /** Selects a cell (e.g. to inspect the record behind an actor). */
  select(cell: number): void;
  /** A one-line name for a tile type. */
  name(type: number): string;
  /** A canvas showing a tile type. */
  icon(type: number): HTMLCanvasElement;
}

/** How an actor comes into the room, for people. */
export function actorOrigin(actor: RoomActor): string {
  const origins: Record<ActorSource, () => string> = {
    tile: () => "placed in the map",
    hatchery: () => "appear after a while",
    bomb: () => "its explosion lets robots appear",
    scorpions: () => "scorpions hiding under sand",
    spawner: () =>
      `appear every ${actor.period ?? 0} ticks while the hero is within ` +
      `${(actor.radius ?? 0).toFixed(1)} cells`,
    creature: () => "appears when the room is entered",
    travelling: () =>
      actor.target
        ? `heads for room ${actor.target.room} at (${actor.target.x}, ${actor.target.y})`
        : "travelling",
  };
  return origins[actor.source]();
}

const where = (cell: number) => `(${cell % ROOM_WIDTH}, ${Math.floor(cell / ROOM_WIDTH)})`;

/** The room's actors, grouped by what they are and how they appear. */
export class ActorsView {
  readonly element = document.createElement("section");
  private readonly events: ActorsViewEvents;

  constructor(events: ActorsViewEvents) {
    this.events = events;
    this.element.className = "actors-view";
    this.element.setAttribute("aria-label", "Actors");
  }

  show(actors: readonly RoomActor[], scripted: readonly ScriptActors[]): void {
    const groups = new Map<string, RoomActor[]>();
    for (const actor of actors) {
      const key = `${actor.source} ${actor.type ?? "?"} ${actorOrigin(actor)}`;
      groups.set(key, [...(groups.get(key) ?? []), actor]);
    }
    const rows = [...groups.values()].map((group) => {
      const first = group.at(0);
      const row = document.createElement("div");
      row.className = "actor-row";
      if (!first) return row;
      if (first.type !== undefined) row.append(this.events.icon(first.type));
      const text = document.createElement("span");
      text.className = "actor-text";
      const name = first.type === undefined ? "Actor" : this.events.name(first.type);
      text.textContent = `${group.length > 1 ? `${group.length} × ` : ""}${name}`;
      text.title = text.textContent;
      const origin = document.createElement("span");
      origin.className = "actor-origin";
      origin.textContent = actorOrigin(first);
      const cells = document.createElement("span");
      cells.className = "actor-cells";
      for (const actor of group) {
        const button = document.createElement("button");
        button.textContent = where(actor.cell);
        button.addEventListener("click", () => {
          this.events.select(actor.cell);
        });
        cells.append(button);
      }
      row.append(text, origin, cells);
      return row;
    });
    const scriptRows = scripted.map((s) => {
      const row = document.createElement("div");
      row.className = "actor-row scripted";
      const count = s.min === s.max ? `${s.min}` : `${s.min}–${s.max}`;
      row.textContent =
        `Script: ${count} × O_${s.name} at random places` +
        (s.conditional ? ", depending on the game state" : "");
      return row;
    });
    const heading = document.createElement("h3");
    heading.textContent = actors.length + scripted.length > 0 ? "Actors" : "No actors";
    this.element.replaceChildren(heading, ...rows, ...scriptRows);
  }
}
