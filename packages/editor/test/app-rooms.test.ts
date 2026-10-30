import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  ROOM_WIDTH,
  exitMode,
  parsePe,
  readConsole,
  readEpisodeStart,
  renderRoom,
  toRgba,
} from "@robot/formats";

import { app, bytes, clickCell, game, newApp, roomNameField, useApp } from "./app-setup.ts";
import { defined, firstDifference } from "./game.ts";

useApp();

test("rooms are added empty or as a copy of the shown room", async () => {
  const dialog = page.getByRole("dialog", { name: "New room" });
  const id = dialog.getByRole("spinbutton", { name: "Room id" });
  const create = dialog.getByRole("button", { name: "Create" });
  await page.getByRole("button", { name: "New room…" }).click();
  await expect.element(dialog).toBeVisible();
  // a free id after the shown room is offered
  expect((id.element() as HTMLInputElement).value).toBe("46");
  // ids ending in 0 join the row above (the originals have none)
  await userEvent.fill(id, "250");
  expect(dialog.element().textContent).toMatch(/No original room id ends in 0/);
  await userEvent.fill(id, "251");
  expect(dialog.element().textContent).toMatch(/No room next to it/);
  // walls and exits are the default; the copy is of the shown room unless another is typed
  expect(
    (dialog.getByRole("radio", { name: "Walls and exits" }).element() as HTMLInputElement).checked,
  ).toBe(true);
  const from = dialog.getByRole("spinbutton", { name: "Copy from room" });
  expect((from.element() as HTMLInputElement).value).toBe("43");
  await userEvent.fill(from, "999");
  expect(dialog.element().textContent).toMatch(/no such room/);
  await expect.element(create).toBeDisabled();
  await userEvent.fill(from, "43");
  expect(dialog.element().textContent).toMatch(/DER START/);
  await create.click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 251" })).toBeVisible();
  expect(defined(app.editor).isEdited(1, 251)).toBe(true);
  const ep = game.episode(1);
  const expected = toRgba(renderRoom(game.room(1, 43), ep.objects, ep.classes), ep.palette);
  expect(firstDifference(app.view.pixels(), expected)).toBe(-1);
  expect(document.querySelector('.room-list [data-room="251"]')?.classList.contains("edited")).toBe(
    true,
  );
  expect(roomNameField().placeholder).toBe("Szene 251 (no name)");
  await page.getByRole("button", { name: "New room…" }).click();
  expect((id.element() as HTMLInputElement).value).toBe("252");
  await dialog.getByRole("radio", { name: "Empty floor" }).click();
  await create.click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 252" })).toBeVisible();
  expect(app.editor?.room(1, 252).base.every((c) => c === 0)).toBe(true);
  // ids in use cannot be created
  await page.getByRole("button", { name: "New room…" }).click();
  await userEvent.fill(id, "43");
  expect(dialog.element().textContent).toMatch(/Room 43 exists\./);
  await expect.element(create).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  app.undo();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 251" })).toBeVisible();
  expect(document.querySelector('.room-list [data-room="252"]')).toBeNull();
  app.undo();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
  expect(document.querySelector('.room-list [data-room="251"]')).toBeNull();
});

test("a new room's dialog names its neighbours and opens their closed exits, undone in one step", async () => {
  // room 46 is missing; 36 (north of it) leads there once it exists, 45's exit is closed here
  const editor = defined(app.editor);
  editor.setExitMode(1, 45, "east", "none");
  app.newRoom(46);
  const dialog = page.getByRole("dialog", { name: "New room" });
  const text = dialog.element().textContent;
  expect(text).toMatch(/North: room 36.* \(its exit leads here\)/);
  expect(text).toMatch(/West: room 45.* \(its exit is closed\)/);
  const open = dialog.getByRole("checkbox", { name: /Open the closed exit of its neighbour/ });
  expect((open.element() as HTMLInputElement).checked).toBe(true);
  await dialog.getByRole("button", { name: "Create" }).click();
  expect(exitMode(editor.room(1, 45), "east")).toBe("neighbour");
  expect(document.querySelector(".status")?.textContent).toBe(
    "Room 46 added, exits of 45 opened towards it",
  );
  app.undo();
  expect(exitMode(editor.room(1, 45), "east")).toBe("none");
  expect(editor.rooms(1).some((r) => r.id === 46)).toBe(false);
  app.undo(); // the exit closed above
  expect(editor.canUndo).toBe(false);
});

test("a house's interior is added from the room it is entered from", async () => {
  const editor = defined(app.editor);
  editor.removeRoom(2, 115);
  app.showEpisode(2, 15);
  app.newRoom();
  const dialog = page.getByRole("dialog", { name: "New room" });
  await dialog.getByRole("radio", { name: /Interior of room/ }).click();
  // the id moves to the room 100 above the shown one
  const id = dialog.getByRole("spinbutton", { name: "Room id" });
  expect((id.element() as HTMLInputElement).value).toBe("115");
  expect(dialog.element().textContent).toMatch(
    /Room 15 leads in: 1 door out at the same cell\. Room 15 shows around it\./,
  );
  await dialog.getByRole("button", { name: "Create" }).click();
  expect(document.querySelector(".status")?.textContent).toBe(
    "Room 115 added: the interior of room 15",
  );
  expect(editor.room(2, 115).base[8 * ROOM_WIDTH + 26]).toBe(0x005a);
  // Junior and I cannot have one
  app.showEpisode(1, 43);
  expect(app.describeInterior(143).problem).toMatch(/class 99/);
});

test("a level inside a house: the id follows the shown room, stairs go at the selected cell", async () => {
  app.showEpisode(2, 144);
  const below = game.room(2, 144);
  const cell = below.base.findIndex((c, i) => i > 80 && c === 0 && below.overlay[i] === 0);
  // picked with the Select tool: an area of one cell (the Inspect tool selects it too)
  app.setTool("select");
  await clickCell(cell);
  app.newRoom(); // offers 145, the next free id
  const dialog = page.getByRole("dialog", { name: "New room" });
  await dialog.getByRole("radio", { name: /Interior of room/ }).click();
  const id = dialog.getByRole("spinbutton", { name: "Room id" });
  expect((id.element() as HTMLInputElement).value).toBe("244");
  const at = `(${cell % ROOM_WIDTH}, ${Math.floor(cell / ROOM_WIDTH)})`;
  const stairs = dialog.getByRole("checkbox", { name: /Stairs down at/ });
  expect((stairs.element() as HTMLInputElement).checked).toBe(true); // 144 has no way in
  expect(stairs.element().parentElement?.textContent).toContain(`Stairs down at ${at} of room 144`);
  expect(dialog.element().textContent).toMatch(/Room 44 shows around it, not room 144/);
  await dialog.getByRole("button", { name: "Create" }).click();
  expect(document.querySelector(".status")?.textContent).toBe(
    `Room 244 added: the interior of room 144, stairs at ${at}`,
  );
  const editor = defined(app.editor);
  expect(editor.room(2, 144).base[cell]).toBe(0x003d);
  expect(editor.room(2, 244).base[cell]).toBe(0x013d);
});

test("Test in game runs an exe that starts in the room, at the selected cell", async () => {
  const runs: { exe: Uint8Array; episode: number }[] = [];
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  newApp(root, {
    play: (exe, episode) => {
      runs.push({ exe, episode });
      return Promise.resolve();
    },
  });
  app.load(bytes);
  app.showEpisode(2, 44);
  app.select(10 * ROOM_WIDTH + 7);
  await page.getByRole("button", { name: "Test in game" }).click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0]?.episode).toBe(2);
  expect(readEpisodeStart(parsePe(defined(runs[0]).exe), 2)).toEqual({ room: 44, x: 7, y: 10 });
  expect(document.querySelector(".status")?.textContent).toBe(
    "Game started: choose Robot II, it starts in room 44 at (7, 10)",
  ); // a single cell picked with the Select tool counts too
  app.setArea({ x: 12, y: 5, w: 1, h: 1 });
  await page.getByRole("button", { name: "Test in game" }).click();
  await expect.poll(() => runs.length).toBe(2);
  expect(readEpisodeStart(parsePe(defined(runs[1]).exe), 2)).toEqual({ room: 44, x: 12, y: 5 });
  expect(readConsole(parsePe(defined(runs[1]).exe))).toBe(false);
  // the Console chip: the same exe with the game's command console on
  await page.getByRole("checkbox", { name: "Console" }).click();
  await page.getByRole("button", { name: "Test in game" }).click();
  await expect.poll(() => runs.length).toBe(3);
  expect(readConsole(parsePe(defined(runs[2]).exe))).toBe(true);
  expect(document.querySelector(".status")?.textContent).toBe(
    "Game started: choose Robot II, it starts in room 44 at (12, 5), the console on",
  );
});

test("deleting a room asks first, naming the rooms that lead to it", async () => {
  const dialog = page.getByRole("dialog", { name: "Delete room" });
  app.showRoom(44);
  await page.getByRole("button", { name: "Delete room…" }).click();
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().textContent).toBe(
    "Delete room 44 – RÄTSELHAFTE TÜREN?Rooms leading to it (they would lead nowhere): 21, 34, 43, 45, 54.Undo brings it back.CancelDelete room",
  );
  // Cancel first, the red action last; Cancel has the focus
  const buttons = [...dialog.element().querySelectorAll("button")];
  expect(buttons.map((b) => [b.textContent, b.className])).toEqual([
    ["Cancel", ""],
    ["Delete room", "primary danger"],
  ]);
  expect(document.activeElement).toBe(buttons[0]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(document.querySelector('.room-list [data-room="44"]')).not.toBeNull();
  await page.getByRole("button", { name: "Delete room…" }).click();
  await dialog.getByRole("button", { name: "Delete room" }).click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
  expect(document.querySelector('.room-list [data-room="44"]')).toBeNull();
  // the start room stays
  await page.getByRole("button", { name: "Delete room…" }).click();
  await dialog.getByRole("button", { name: "Delete room" }).click();
  expect(document.querySelector(".status")?.textContent).toMatch(/the episode starts in room 43/);
  app.undo();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
});

test("back and forward pass over deleted rooms", async () => {
  const heading = (name: string) => page.getByRole("heading", { name });
  app.showRoom(45);
  app.showRoom(44);
  app.showRoom(42);
  await page.getByRole("button", { name: "◀ 44" }).click();
  await expect.element(heading("Robot I – room 44")).toBeVisible();
  await page.getByRole("button", { name: "Delete room…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete room" });
  await dialog.getByRole("button", { name: "Delete room" }).click();
  // 43 45 44 45: back to 43, not to the deleted 44 or the 45 shown
  await expect.element(heading("Robot I – room 45")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "◀ 43" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "▶" })).toBeDisabled();
  window.history.back(); // the browser's own back too
  await expect.element(heading("Robot I – room 43")).toBeVisible();
  await page.getByRole("button", { name: "45 ▶" }).click();
  await expect.element(heading("Robot I – room 45")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "▶" })).toBeDisabled();
  await page.getByRole("button", { name: "◀ 43" }).click();
  await expect.element(heading("Robot I – room 43")).toBeVisible();
});
