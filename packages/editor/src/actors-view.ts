import {
  type ActorSource,
  ROOM_WIDTH,
  type RandomPlacement,
  type RoomActor,
  type ScriptActors,
} from "@robot/formats";

export interface ActorsViewEvents {
  /** Selects a cell (e.g. to inspect the record behind an actor). */
  select(cell: number): void;
  /** A one-line name for a tile type. */
  name(type: number): string;
  /** A canvas showing a tile type. */
  icon(type: number): HTMLCanvasElement;
  /** Shows or hides where RandObj places robots and androids. */
  areas(show: boolean): void;
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
        ? `leaves for room ${actor.target.room} once met (follow it: arrive at ` +
          `(${actor.target.x}, ${actor.target.y}))`
        : "travelling",
  };
  return origins[actor.source]();
}

/** What RandObj does with the room's current number, for people. */
export function randomEffect(call: ScriptActors, placement: RandomPlacement): string {
  const { existing } = placement;
  const range = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
  const target = range(call.min, call.max);
  const where = placement.awayFromHero
    ? "on empty cells across the room from where the hero enters (hover to see the areas)"
    : "on empty cells anywhere";
  const add = call.max - existing;
  const remove = existing - call.min;
  const change =
    existing > call.max
      ? `removes ${range(existing - call.max, remove)} at random`
      : existing < call.min
        ? `adds ${range(call.min - existing, add)} ${where}`
        : add === 0 && remove === 0
          ? "leaves them as they are"
          : [
              add > 0 ? `adds up to ${add} ${where}` : "",
              remove > 0 ? `removes up to ${remove}` : "",
            ]
              .filter(Boolean)
              .join(" or ");
  return `keeps ${target} × O_${call.name}: ${existing} in the room now, so it ${change}`;
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

  show(
    actors: readonly RoomActor[],
    scripted: readonly { call: ScriptActors; placement: RandomPlacement }[],
  ): void {
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
    const scriptRows = scripted.map(({ call, placement }) => {
      const row = document.createElement("div");
      row.className = "actor-row scripted";
      if (placement.type !== undefined) row.append(this.events.icon(placement.type));
      const text = document.createElement("span");
      text.textContent =
        `Script ${randomEffect(call, placement)}` +
        (call.conditional ? " (depending on the game state)" : "");
      row.append(text);
      if (placement.awayFromHero) {
        row.addEventListener("mouseenter", () => {
          this.events.areas(true);
        });
        row.addEventListener("mouseleave", () => {
          this.events.areas(false);
        });
      }
      return row;
    });
    const heading = document.createElement("h3");
    heading.textContent = actors.length + scripted.length > 0 ? "Actors" : "No actors";
    this.element.replaceChildren(heading, ...rows, ...scriptRows);
  }
}
