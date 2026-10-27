import { beforeEach } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  Game,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  backdropRoom,
  renderRoom,
  shownCells,
  toRgba,
} from "@robot/formats";

import { App, type AppOptions } from "../src/app.ts";
import { dim } from "../src/room-view.ts";
import "../src/style.css";
import { defined, exeBytes } from "./game.ts";

export const bytes = await exeBytes();
export const game = new Game(bytes);
/** The app of the running test (useApp). */
export let app: App;
/** Apps created so far: their window listeners are removed before the next test. */
const apps: App[] = [];

/** A new app in `root`, from now on the test's `app`. */
export function newApp(root: HTMLElement, options?: AppOptions): App {
  app = new App(root, options);
  apps.push(app);
  return app;
}

/** Each test of the file gets a new app with the game loaded, its room the start room. */
export function useApp(): void {
  beforeEach(() => {
    for (const old of apps.splice(0)) old.dispose();
    // the address names the room shown; start every test without one
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    document.body.replaceChildren();
    const root = document.createElement("div");
    document.body.append(root);
    newApp(root).load(bytes);
  });
}

/** The centre of a cell in the room view, relative to the view. */
export function cellCentre(index: number) {
  const rect = app.view.element.getBoundingClientRect();
  return {
    x: ((index % ROOM_WIDTH) + 0.5) * (rect.width / ROOM_WIDTH),
    y: (Math.floor(index / ROOM_WIDTH) + 0.5) * (rect.height / ROOM_HEIGHT),
  };
}

export function roomNameField(): HTMLInputElement {
  return defined(document.querySelector<HTMLInputElement>(".room-name") ?? undefined, "the name");
}

export async function clickCell(index: number, button: "left" | "right" = "left") {
  await userEvent.click(app.view.element, { position: cellCentre(index), button });
}

/** A room as the renderer draws it, with its backdrop dimmed (as the editor shows it). */
export function drawnWithBackdrop(episode: number, id: number): Uint8ClampedArray {
  const ep = game.episode(episode);
  const room = game.room(episode, id);
  const backdrop = backdropRoom(episode, room, ep.rooms, ep.classes);
  const rgba = toRgba(renderRoom(room, ep.objects, ep.classes, backdrop), ep.palette);
  for (let i = 0; i < ROOM_WIDTH * ROOM_HEIGHT; i++) {
    if (!shownCells(room, i, ep.classes, backdrop)[2]) continue;
    const [x0, y0] = [(i % ROOM_WIDTH) * TILE_WIDTH, Math.floor(i / ROOM_WIDTH) * TILE_HEIGHT];
    for (let y = y0; y < y0 + TILE_HEIGHT; y++) {
      const start = (y * SCREEN_WIDTH + x0) * 4;
      dim(rgba.subarray(start, start + TILE_WIDTH * 4));
    }
  }
  return rgba;
}

/** Sends a mouse event to the room view at a cell. */
export function fireAt(type: string, index: number, init: MouseEventInit = {}) {
  const rect = app.view.element.getBoundingClientRect();
  app.view.element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: rect.left + cellCentre(index).x,
      clientY: rect.top + cellCentre(index).y,
      ...init,
    }),
  );
}

export const exits = () => page.getByRole("navigation", { name: "Exits" });

export const scriptView = () => page.getByRole("region", { name: "Script" });
