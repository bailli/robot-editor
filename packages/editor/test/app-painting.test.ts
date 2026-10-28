import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  ROOM_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  backdropRoom,
  darkPalette,
  darknessBlock,
  renderCell,
  renderRoom,
  toRgba,
} from "@robot/formats";

import { line } from "../src/app.ts";
import {
  app,
  cellCentre,
  clickCell,
  drawnWithBackdrop,
  fireAt,
  game,
  roomNameField,
  useApp,
} from "./app-setup.ts";
import { defined, firstDifference } from "./game.ts";

useApp();

test("shows the start room of Robot I as the renderer draws it", async () => {
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
  expect(roomNameField().value).toBe("DER START");
  const ep = game.episode(1);
  const expected = toRgba(renderRoom(game.room(1, 43), ep.objects, ep.classes), ep.palette);
  expect(firstDifference(app.view.pixels(), expected)).toBe(-1);
});

test("the Dark toggle draws rooms as dark as the game on entering them", async () => {
  const ep = game.episode(1);
  const drawn = (id: number, block: number) =>
    toRgba(renderRoom(game.room(1, id), ep.objects, ep.classes), darkPalette(ep.palette, block));
  await page.getByRole("checkbox", { name: "Dark" }).click();
  // room 43 has no darkness
  expect(firstDifference(app.view.pixels(), drawn(43, 0))).toBe(-1);
  app.showRoom(42); // darkness 80: palette block 11
  expect(darknessBlock(80)).toBe(11);
  expect(firstDifference(app.view.pixels(), drawn(42, 11))).toBe(-1);
  // the key D toggles it
  await userEvent.keyboard("d");
  expect(firstDifference(app.view.pixels(), drawn(42, 0))).toBe(-1);
});

test("? and the Shortcuts button show the help; keys in it leave the room alone", async () => {
  const help = page.getByRole("dialog", { name: "Shortcuts" });
  await userEvent.keyboard("?");
  await expect.element(help).toBeVisible();
  expect(help.element().textContent).toMatch(/Ctrl\+V.*Paste/);
  const grid = page.getByRole("checkbox", { name: "Grid" }).element() as HTMLInputElement;
  const before = grid.checked;
  await userEvent.keyboard("g");
  expect(grid.checked).toBe(before);
  // also when nothing in it has the focus (a click on its text)
  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard("g");
  expect(grid.checked).toBe(before);
  await userEvent.keyboard("{Escape}");
  await expect.element(help).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Shortcuts" }).click();
  await help.getByRole("button", { name: "Close" }).click();
  await expect.element(help).not.toBeInTheDocument();
});

// every room's render is pinned in formats (render.test.ts); here the editor's drawing
// of it: rooms with a backdrop (dimmed) and every eighth room besides
test("rooms of every episode are drawn as the renderer draws them, backdrops dimmed", () => {
  for (const episode of [0, 1, 2, 3, 4]) {
    const ep = game.episode(episode);
    app.showEpisode(episode);
    const rooms = ep.rooms.filter(
      (room, k) => k % 8 === 0 || backdropRoom(room, ep.rooms, ep.classes),
    );
    for (const room of rooms) {
      app.showRoom(room.id);
      const expected = drawnWithBackdrop(episode, room.id);
      const pixels = app.view.pixels();
      expect(pixels.length).toBe(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
      expect(firstDifference(pixels, expected), `episode ${episode} room ${room.id}`).toBe(-1);
    }
  }
});

test("a house's interior shows the town around it dimmed, until its marks are painted over", () => {
  // episode II room 115: its class 99 cells show room 15
  app.showEpisode(2, 115);
  const ep = game.episode(2);
  const room = game.room(2, 115);
  expect(backdropRoom(room, ep.rooms, ep.classes)?.id).toBe(15);
  const plain = toRgba(renderRoom(room, ep.objects, ep.classes), ep.palette);
  expect(firstDifference(app.view.pixels(), drawnWithBackdrop(2, 115))).toBe(-1);
  expect(firstDifference(app.view.pixels(), plain)).not.toBe(-1);
  // (0, 1) and (39, 1) both mark it; painting one keeps the backdrop
  app.setTile(0x0000); // empty floor
  app.paintCell(ROOM_WIDTH);
  expect(firstDifference(app.view.pixels(), plain)).not.toBe(-1);
  app.paintCell(2 * ROOM_WIDTH - 1);
  const edited = app.editor?.room(2, 115);
  const without = toRgba(renderRoom(defined(edited), ep.objects, ep.classes), ep.palette);
  expect(firstDifference(app.view.pixels(), without)).toBe(-1);
  app.undo();
  app.undo();
  expect(firstDifference(app.view.pixels(), drawnWithBackdrop(2, 115))).toBe(-1);
});

test("right click picks a tile, left click paints it, undo reverts it", async () => {
  const room = game.room(1, 43);
  const source = 3 * ROOM_WIDTH + 1; // a wall
  const target = 5 * ROOM_WIDTH + 20; // empty floor
  expect(room.base[target]).not.toBe(room.base[source]);

  await clickCell(source, "right");
  expect(app.tile).toBe(room.base[source]);
  await clickCell(target);
  expect(app.editor?.room(1, 43).base[target]).toBe(room.base[source]);
  await expect.element(page.getByRole("button", { name: "43", exact: true })).toHaveClass(/edited/);
  await expect.element(page.getByRole("button", { name: "Save exe" })).toBeEnabled();

  await userEvent.keyboard("{Control>}z{/Control}");
  expect(app.editor?.room(1, 43).base[target]).toBe(room.base[target]);
  await expect.element(page.getByRole("button", { name: "Save exe" })).toBeDisabled();
});

test("dragging paints every cell along the way", () => {
  app.setTile(game.room(1, 43).base[3 * ROOM_WIDTH + 1] ?? 0);
  const from = 6 * ROOM_WIDTH + 12;
  const to = 6 * ROOM_WIDTH + 24;
  const rect = app.view.element.getBoundingClientRect();
  const fire = (type: string, index: number) =>
    app.view.element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: rect.left + cellCentre(index).x,
        clientY: rect.top + cellCentre(index).y,
      }),
    );
  fire("mousedown", from);
  fire("mousemove", to); // one jump: the cells in between are filled in
  window.dispatchEvent(new MouseEvent("mouseup"));
  const base = app.editor?.room(1, 43).base;
  for (const i of line(from, to)) expect(base?.[i]).toBe(app.tile);
  expect(app.editor?.undo()?.changes.length).toBeGreaterThan(1);
});

test("undo during a drag ends it: moving on paints no more", async () => {
  const original = game.room(1, 43).base;
  app.setTile(original[3 * ROOM_WIDTH + 1] ?? 0);
  const [from, to] = [6 * ROOM_WIDTH + 12, 6 * ROOM_WIDTH + 24];
  fireAt("mousedown", from);
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(app.editor?.room(1, 43).base[from]).toBe(original[from]);
  fireAt("mousemove", to);
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(app.editor?.room(1, 43).base[to]).toBe(original[to]);
  expect(app.editor?.isEdited(1, 43)).toBe(false);
});

test("an area is selected, copied and pasted into another room, undoably", async () => {
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await expect.element(button("Copy area")).toBeDisabled();
  await expect.element(button("Paste area")).toBeDisabled();
  await page.getByRole("radio", { name: "Select" }).click();
  // room 43's top left corner: walls
  fireAt("mousedown", 0);
  fireAt("mousemove", 2 * ROOM_WIDTH + 3);
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(app.area).toEqual({ x: 0, y: 0, w: 4, h: 3 });
  await expect.element(button("Copy area")).toBeEnabled();
  await userEvent.keyboard("{Control>}c{/Control}");
  expect(app.clip?.w).toBe(4);
  app.showRoom(44);
  expect(app.area).toBeUndefined(); // the selection belongs to the room
  await userEvent.keyboard("{Control>}v{/Control}");
  expect(app.pasting).toBe(true);
  const target = 10 * ROOM_WIDTH + 10;
  fireAt("mousemove", target);
  fireAt("mousedown", target);
  expect(app.pasting).toBe(false);
  const source = game.room(1, 43);
  const room = defined(app.editor).room(1, 44);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      expect(room.base[(10 + y) * ROOM_WIDTH + 10 + x]).toBe(source.base[y * ROOM_WIDTH + x]);
    }
  }
  expect(app.area).toEqual({ x: 10, y: 10, w: 4, h: 3 });
  // Delete clears the pasted area, undo brings it back
  await userEvent.keyboard("{Delete}");
  expect(defined(app.editor).room(1, 44).base[target]).toBe(0);
  app.undo();
  app.undo();
  expect(defined(app.editor).isEdited(1, 44)).toBe(false);
});

test("the fill tool fills connected cells of one value, within a selected area", async () => {
  const room = game.room(1, 43);
  const floor = 5 * ROOM_WIDTH + 20; // empty floor
  app.setTile(room.base[3 * ROOM_WIDTH + 1] ?? 0);
  app.setArea({ x: 18, y: 4, w: 5, h: 3 });
  await page.getByRole("radio", { name: "Fill" }).click();
  expect(app.area).toBeUndefined(); // other tools drop the selection
  app.setArea({ x: 18, y: 4, w: 5, h: 3 });
  fireAt("mousedown", floor);
  const filled =
    defined(app.editor)
      .undo()
      ?.changes.map((c) => c.index) ?? [];
  expect(filled.length).toBeGreaterThan(1);
  expect(filled.length).toBeLessThanOrEqual(15);
  // without the area: much more of the floor
  app.setArea(undefined);
  fireAt("mousedown", floor);
  expect(defined(app.editor).undo()?.changes.length).toBeGreaterThan(15);
});

test("the tile filter keeps the tiles whose name or value match", async () => {
  const tiles = () => [...document.querySelectorAll<HTMLElement>(".tile-grid button")];
  const all = tiles().length;
  await userEvent.fill(page.getByRole("searchbox", { name: "Filter tiles" }), "0x0017");
  const shown = tiles().filter((b) => !b.hidden);
  expect(shown.map((b) => Number(b.dataset["tile"]))).toEqual([0x17]);
  await userEvent.fill(page.getByRole("searchbox", { name: "Filter tiles" }), "");
  expect(tiles().filter((b) => !b.hidden).length).toBe(all);
});

test("switching episodes shows the episode's start room", async () => {
  await userEvent.selectOptions(page.getByRole("combobox", { name: "Episode" }), "Robot III");
  await expect.element(page.getByRole("heading", { name: "Robot III – room 41" })).toBeVisible();
});

test("line connects cells without gaps", () => {
  expect(line(0, 3)).toEqual([0, 1, 2, 3]);
  expect(line(0, 2 * ROOM_WIDTH + 2)).toEqual([0, ROOM_WIDTH + 1, 2 * ROOM_WIDTH + 2]);
  expect(line(5, 5)).toEqual([5]);
});

test("tiles show their names and descriptions", async () => {
  app.showEpisode(3, 47);
  const key = document.querySelector<HTMLElement>('.tile-grid [data-tile="277"]'); // 0x0115
  expect(key?.title).toMatch(/^0x0115 Key\nRichtig, das ist ein Schlüssel\. Du mußt/);
  if (key) await userEvent.click(key);
  expect(app.tile).toBe(0x0115);
  expect(document.querySelector(".tile-text")?.textContent).toMatch(
    /^Key – Richtig, das ist ein Schlüssel\./,
  );
  app.setTile(0x003d); // stairs down: the description for this state only
  expect(document.querySelector(".tile-text")?.getAttribute("title")).toBe(
    "0x003d\nDiese Treppen führen hinunter.",
  );
  app.setTile(0x0000);
  expect(document.querySelector(".tile-text")?.getAttribute("title")).toMatch(
    /^0x0000 \(one of\)\nHier gibt's nichts Interessantes zu sehen\.\n/,
  );
});

test("actors from records are drawn as themselves and described once", () => {
  app.showRoom(42); // episode I room 42: the dealer's record at (10, 10)
  const index = 10 * ROOM_WIDTH + 10;
  // the cell's centre on the marks canvas is the dealer's tile, not the logic cell's fill
  const marks = app.view.pixelsOfMarks();
  const width = SCREEN_WIDTH * app.view.zoom;
  const centre = ((10 * 12 + 6) * app.view.zoom * width + (10 * 16 + 8) * app.view.zoom) * 4;
  expect(marks[centre + 3]).toBe(255); // opaque: the tile, not the translucent magenta
  fireAt("mousemove", index);
  const info = document.querySelector(".cell-info")?.textContent ?? "";
  expect(info).toMatch(/the dealer appears here/);
  expect(info).not.toMatch(/actor:/);
});

test("hovering a logic cell says what its record does", () => {
  app.showEpisode(2, 55);
  const room = app.editor?.room(2, 55);
  const index = room?.base.findIndex((c) => (c & 0xff) === 0x7f) ?? -1;
  expect(index).toBeGreaterThanOrEqual(0);
  const rect = app.view.element.getBoundingClientRect();
  app.view.element.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + ((index % 40) + 0.5) * (rect.width / 40),
      clientY: rect.top + (Math.floor(index / 40) + 0.5) * (rect.height / 29),
    }),
  );
  expect(document.querySelector(".cell-info")?.textContent).toMatch(
    /· a teleporter to room \d+ at/,
  );
});

test("robots keep their sprite when the marks are redrawn", () => {
  app.showEpisode(2, 123);
  const before = app.view.pixelsOfMarks();
  app.view.setHover(5 * ROOM_WIDTH + 5);
  app.view.setHover(undefined);
  expect(firstDifference(app.view.pixelsOfMarks(), before)).toBe(-1);
});

test("palette tiles that draw nothing show a robot or a hatching instead", () => {
  const pixels = (value: number) => {
    const canvas = document.querySelector(`.tile-grid [data-tile="${value}"] canvas`);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`no tile ${value}`);
    return [...defined(canvas.getContext("2d") ?? undefined).getImageData(0, 0, 16, 12).data];
  };
  const floor = pixels(0);
  // episode I: robots (type 2) are actors in the game, their tiles draw nothing
  expect(pixels(0x0002)).not.toEqual(floor);
  expect(document.querySelector('.tile-grid [data-tile="2"]')?.getAttribute("title")).toMatch(
    /a robot: the game turns it into an actor/,
  );
  app.showEpisode(2, 43);
  // episode II: the marker of rooms named after the room 100 below draws nothing
  expect(pixels(0x0054)).not.toEqual(pixels(0));
  expect(document.querySelector('.tile-grid [data-tile="84"]')?.getAttribute("title")).toMatch(
    /draws nothing in the game/,
  );
});

test("palette robots: episode IV's sprite, not its tile's ?, and colours by the flags", async () => {
  const pixels = (value: number) => {
    const canvas = document.querySelector(`.tile-grid [data-tile="${value}"] canvas`);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`no tile ${value}`);
    return [...defined(canvas.getContext("2d") ?? undefined).getImageData(0, 0, 16, 12).data];
  };
  const title = () => document.querySelector('.tile-grid [data-tile="2"]')?.getAttribute("title");
  app.showEpisode(4, 135);
  const ep = game.episode(4);
  const tile = toRgba(renderCell(0x0002, 0, ep.objects, ep.classes), ep.palette);
  expect(firstDifference(pixels(0x0002), tile)).not.toBe(-1);
  expect(title()).toMatch(/robot sprites, in that sprite's colours/);
  // Junior: random colours, its sprite's once the flag says so
  app.showEpisode(0, 43);
  expect(title()).toMatch(/in three random colours/);
  const random = pixels(0x0002);
  await page.getByRole("tab", { name: "Episode" }).click();
  await page
    .getByRole("region", { name: "Flags" })
    .getByRole("checkbox", { name: /sprite's colours/ })
    .click();
  expect(title()).toMatch(/in that sprite's colours/);
  expect(pixels(0x0002)).not.toEqual(random);
  app.undo();
  expect(pixels(0x0002)).toEqual(random);
});

test("undoing a painted robot takes it out of the actors", () => {
  const free = 20 * ROOM_WIDTH + 10; // floor in episode I room 43
  // one position button per actor in the list
  const robots = () => app.actorsView.element.querySelectorAll(".actor-cells button").length;
  const before = robots();
  app.setTile(0x0002);
  app.paintCell(free);
  expect(robots()).toBeGreaterThan(before);
  app.undo();
  expect(robots()).toBe(before);
});

test("expert fields say how many points they need", () => {
  app.setTile(0x0c32); // episode I: state 12
  expect(document.querySelector(".tile-text")?.textContent).toMatch(
    /^Expert – Needs at least 120000 points to cross\./,
  );
});

test("tiles the game draws in its texts are drawn in the editor's texts too", () => {
  app.setTile(0x000a); // gold: "… bei der Bank @14 gegen Punkte eintauschen …"
  const text = document.querySelector(".tile-text");
  expect(text?.querySelectorAll("canvas.text-tile").length).toBe(1);
  expect(text?.textContent).toMatch(/bei der Bank\s+gegen Punkte/);
  // tooltips name the tile instead
  expect(text?.getAttribute("title")).toMatch(/bei der Bank \[0x0014\] gegen/);
});
