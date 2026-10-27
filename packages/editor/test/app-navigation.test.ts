import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { exitMode, roomPassages } from "@robot/formats";

import { app, bytes, exits, game, newApp, roomNameField, useApp } from "./app-setup.ts";
import { defined } from "./game.ts";

useApp();

test("the exits of a room link to the rooms they lead to", async () => {
  // room 43: north 33, south 53, east 44; west closed, opened by the script at a high score
  await expect.element(exits().getByRole("button", { name: "33" })).toBeVisible();
  const west = document.querySelector('[data-direction="west"]');
  const targets = (item: Element | null) =>
    [...(item?.querySelectorAll(".target") ?? [])].map((t) => t.textContent);
  expect(targets(west)).toEqual(["—", "42"]);
  expect(west?.querySelector("select")?.value).toBe("none");
  expect(west?.querySelector(".conditional")?.getAttribute("title")).toBe(
    "room 42 – ORT DER VERTEIDIGUNG (set by the script, depending on the game state)",
  );
  await exits().getByRole("button", { name: "44" }).click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
});

test("arrow keys follow the exits that do not depend on the game state", async () => {
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(page.getByRole("heading", { name: "Robot I – room 33" })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowLeft}");
  // 43 -> west is closed: stays
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
});

test("teleports are listed with the exits", async () => {
  app.showRoom(36);
  const teleports = document.querySelector(".teleports");
  expect(teleports?.querySelectorAll("button.conditional").length).toBe(9); // from the script
  const button = exits().getByRole("button", { name: /^129/ });
  await expect
    .element(button)
    .toHaveAttribute(
      "title",
      "room 129 – DER SPURT ZUM SCHALTER (the script's Teleport(129, 7, 21) redirects the teleporters that allow it, depending on the game state)",
    );
  await button.click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 129" })).toBeVisible();
});

test("doors and stairs are listed with the exits", async () => {
  app.showEpisode(3, 47); // a hut: its door leads inside, room 147
  const door = document.querySelector('.passage[data-direction="door in"]');
  expect(door?.textContent).toBe("Door in147");
  await exits().getByRole("button", { name: "147" }).click();
  await expect.element(page.getByRole("heading", { name: "Robot III – room 147" })).toBeVisible();
  // inside the hut: the village's name and description
  const name = roomNameField();
  expect(name.value).toBe('Das große Dorf am "Sila"-Fluß');
  expect(name.getAttribute("title")).toMatch(/^the name of room 47\nAm Mündungsdelta /);
  expect(document.querySelector('.passage[data-direction="door out"]')?.textContent).toBe(
    "Door out47",
  );
  app.showRoom(22); // a hole in the jungle: stairs down into the cave, room 122
  expect(document.querySelector('.passage[data-direction="stairs down"]')?.textContent).toBe(
    "Stairs down122",
  );
});

test("painting over stairs counts them in the exits, also after undo", () => {
  app.showEpisode(3, 22); // stairs down to 122: in the base at 215, in the overlay at 349
  const stairs = () => document.querySelector('.passage[data-direction="stairs down"] button');
  const room = defined(app.editor).room(3, 22);
  const ids = new Set(
    defined(app.editor)
      .rooms(3)
      .map((r) => r.id),
  );
  const cells = roomPassages(room, game.episode(3).classes, ids).map((p) => p.cell);
  expect(cells).toEqual([215, 349]);
  expect(stairs()?.getAttribute("title")).toMatch(/\(2 cells\)$/);
  app.setTile(0x0000);
  app.paintCell(215);
  expect(stairs()?.getAttribute("title")).toMatch(/\(1 cell\)$/);
  app.undo();
  expect(stairs()?.getAttribute("title")).toMatch(/\(2 cells\)$/);
});

test("stairs a circuit places are listed with the exits", async () => {
  app.showRoom(128); // episode I: the final node's stairs down to 228
  // conditional targets end in "?"
  const stairs = exits().getByRole("button", { name: /^228/ });
  await expect.element(stairs).toBeVisible();
  expect(stairs.element().getAttribute("title")).toMatch(/stairs down at \(22, 27\), placed once/);
  expect(document.querySelector(".circuit-stairs")?.textContent).toBe("Circuit stairs228");
  await stairs.click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 228" })).toBeVisible();
  // and back: 228 has no way out but the wizard's door, yet 128 leads to it
  expect(app.roomsLeadingTo(228)).toContain(128);
});

test("oracles and teleporters are listed with the exits", async () => {
  app.showEpisode(2, 55);
  const teleporters = document.querySelector(".teleports");
  expect([...(teleporters?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
    "155",
    "105",
    "106",
    "113",
    "51",
    "53",
  ]);
  const button = exits().getByRole("button", { name: "155" });
  await expect
    .element(button)
    .toHaveAttribute(
      "title",
      "room 155 – Nord-West-Halle (teleporter at (38, 2), arriving at (6, 7))",
    );
  await button.click();
  await expect.element(page.getByRole("heading", { name: "Robot II – room 155" })).toBeVisible();
});

test("back and forward use the browser's history, also across episodes", async () => {
  // Robot I room 43 -> 44 (exit) -> episode III room 47 -> 147 (door)
  await exits().getByRole("button", { name: "44" }).click();
  app.showEpisode(3, 47);
  await exits().getByRole("button", { name: "147" }).click();
  const heading = (name: string) => page.getByRole("heading", { name });
  await expect.element(heading("Robot III – room 147")).toBeVisible();
  expect(window.location.hash).toBe("#3/147");

  await page.getByRole("button", { name: "◀ 47" }).click();
  await expect.element(heading("Robot III – room 47")).toBeVisible();
  window.history.back(); // the browser's own back
  await expect.element(heading("Robot I – room 44")).toBeVisible();
  expect(window.location.hash).toBe("#1/44");
  window.history.forward();
  await expect.element(heading("Robot III – room 47")).toBeVisible();
  await userEvent.keyboard("{Backspace}");
  await expect.element(heading("Robot I – room 44")).toBeVisible();

  // a new way drops the forward history
  app.showRoom(45);
  await expect.element(page.getByRole("button", { name: "▶" })).toBeDisabled();
  await page.getByRole("button", { name: "◀ 44" }).click();
  await expect.element(heading("Robot I – room 44")).toBeVisible();
});

test("an episode that does not exist in the address is ignored", async () => {
  window.history.replaceState(null, "", "#7/43");
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  newApp(root);
  app.load(bytes);
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
});

test("after a reload, back and forward are labelled again", async () => {
  app.showRoom(44);
  app.showRoom(45);
  window.history.back();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
  // a new page on the same history entry
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  newApp(root);
  app.load(bytes);
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "◀ 43" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "45 ▶" })).toBeEnabled();
});

test("a room in the address is opened on loading", async () => {
  window.history.replaceState(null, "", "#2/55");
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  newApp(root);
  app.load(bytes);
  await expect.element(page.getByRole("heading", { name: "Robot II – room 55" })).toBeVisible();
});

test("a room typed into the address of the open page is shown", async () => {
  window.location.hash = "#3/147";
  await expect.element(page.getByRole("heading", { name: "Robot III – room 147" })).toBeVisible();
  // inside the hut: the village's name and description
  const name = roomNameField();
  expect(name.value).toBe('Das große Dorf am "Sila"-Fluß');
  expect(name.getAttribute("title")).toMatch(/^the name of room 47\nAm Mündungsdelta /);
  window.history.back();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
});

test("the exits byte can be changed per direction, undoably", async () => {
  // episode I room 43: west is closed in its exits byte
  const west = () => defined(document.querySelector('[data-direction="west"]') ?? undefined);
  const select = page.getByRole("combobox", { name: "west exit" });
  (select.element() as HTMLSelectElement).focus();
  await userEvent.selectOptions(select, "neighbour");
  expect(exitMode(defined(app.editor).room(1, 43), "west")).toBe("neighbour");
  // the select keeps the focus: the arrow keys stay with it, not walking out of the room
  expect(document.activeElement).toBe(select.element());
  // room 42 exists: west now leads there
  expect(west().querySelector(".target.default")?.textContent).toBe("42");
  await userEvent.selectOptions(page.getByRole("combobox", { name: "east exit" }), "outside");
  expect(document.querySelector('[data-direction="east"] .target')?.textContent).toBe("2 outside");
  app.undo();
  app.undo();
  expect(defined(app.editor).isEdited(1, 43)).toBe(false);
  expect(west().querySelector("select")?.value).toBe("none");
  // a kept exit button goes where the shown room's exit leads
  const goWest = () => {
    defined(west().querySelector<HTMLButtonElement>(".target.default") ?? undefined).click();
  };
  app.showRoom(45);
  goWest();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
  goWest();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
});

test("the map shows the rooms with their exits and opens or closes them", async () => {
  await page.getByRole("button", { name: "Map" }).click();
  const map = page.getByRole("region", { name: "Map" });
  await expect.element(map).toBeVisible();
  expect(document.querySelector(".map-room.current")?.getAttribute("data-room")).toBe("43");
  // 43 west is closed in its exits byte and opened by the script: dashed
  const west = () =>
    defined(
      document.querySelector('.map-link[data-from="43"][data-direction="west"]') ?? undefined,
    );
  expect(west().classList.contains("scripted")).toBe(true);
  await userEvent.click(west());
  expect(exitMode(defined(app.editor).room(1, 43), "west")).toBe("neighbour");
  expect(west().classList.contains("open")).toBe(true);
  app.undo();
  expect(west().classList.contains("scripted")).toBe(true);
  // a room opens in the room view
  await map.getByRole("button", { name: /^Room 33/ }).click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 33" })).toBeVisible();
  expect(app.mapView.element.hidden).toBe(true);
});

test("leaving the map shows the room as the map left it", async () => {
  await page.getByRole("button", { name: "Map" }).click();
  await userEvent.click(
    defined(
      document.querySelector('.map-link[data-from="43"][data-direction="east"]') ?? undefined,
    ),
  );
  app.setMap(false);
  expect(document.querySelector<HTMLSelectElement>('[data-direction="east"] select')?.value).toBe(
    "none",
  );
});

test("neighbours across the end of a row or a hundred are named as such", () => {
  // episode IV: room 204's north neighbour is 194, in the hundred above
  app.showEpisode(4, 204);
  defined(app.editor).removeRoom(4, 204);
  expect(app.checkNewRoom(204).lines.join("\n")).toMatch(/North: room 194.*, in rooms 100–199\)/);
  // episode I: west of a room 50 is room 49, at the end of the row above
  app.showEpisode(1, 43);
  defined(app.editor).addRoom(1, 49);
  expect(app.checkNewRoom(50).lines.join("\n")).toMatch(
    /West: room 49 \(its exit leads here, at the end of the row above\)/,
  );
});

test("Go to room opens a room by its id", async () => {
  const go = page.getByRole("spinbutton", { name: "Go to room" });
  await userEvent.fill(go, "44");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("heading", { name: "Robot I – room 44" })).toBeVisible();
  await userEvent.fill(go, "999");
  await userEvent.keyboard("{Enter}");
  expect(document.querySelector(".status.error")?.textContent).toMatch(/has no room 999/);
});

test("the map's + slots next to rooms add a room there", async () => {
  await page.getByRole("button", { name: "Map" }).click();
  // no slots in column 0: the game links those rooms with the row above and below
  expect(document.querySelector('[aria-label="Add room 40"]')).toBeNull();
  await page.getByRole("button", { name: "Add room 46" }).click();
  const dialog = page.getByRole("dialog", { name: "New room" });
  const id = dialog.getByRole("spinbutton", { name: "Room id" });
  expect((id.element() as HTMLInputElement).value).toBe("46");
  await dialog.getByRole("button", { name: "Create" }).click();
  // the map stays, with the new room on it
  expect(document.querySelector('.map-room[data-room="46"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Add room 46"]')).toBeNull();
});
