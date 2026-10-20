import { beforeEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  Game,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  displayText,
  exitMode,
  parsePe,
  readEpisodeStart,
  readEventTable,
  renderRoom,
  roomScript,
  roomSettings,
  toRgba,
} from "@robot/formats";

import { App, line } from "../src/app.ts";
import "../src/style.css";
import { defined, exeBytes, firstDifference } from "./game.ts";

const bytes = await exeBytes();
const game = new Game(bytes);
let app: App;
/** Apps created so far: their window listeners are removed before the next test. */
const apps: App[] = [];
const track = (created: App) => {
  apps.push(created);
  return created;
};

beforeEach(() => {
  for (const old of apps.splice(0)) old.dispose();
  // the address names the room shown; start every test without one
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  app = track(new App(root));
  app.load(bytes);
});

/** The centre of a cell in the room view, relative to the view. */
function cellCentre(index: number) {
  const rect = app.view.element.getBoundingClientRect();
  return {
    x: ((index % ROOM_WIDTH) + 0.5) * (rect.width / ROOM_WIDTH),
    y: (Math.floor(index / ROOM_WIDTH) + 0.5) * (rect.height / ROOM_HEIGHT),
  };
}

function roomNameField(): HTMLInputElement {
  return defined(document.querySelector<HTMLInputElement>(".room-name") ?? undefined, "the name");
}

async function clickCell(index: number, button: "left" | "right" = "left") {
  await userEvent.click(app.view.element, { position: cellCentre(index), button });
}

test("shows the start room of Robot I as the renderer draws it", async () => {
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
  expect(roomNameField().value).toBe("DER START");
  const ep = game.episode(1);
  const expected = toRgba(renderRoom(game.room(1, 43), ep.objects, ep.classes), ep.palette);
  expect(firstDifference(app.view.pixels(), expected)).toBe(-1);
});

test("every room of every episode is drawn as the renderer draws it", () => {
  for (const episode of [0, 1, 2, 3, 4]) {
    const ep = game.episode(episode);
    app.showEpisode(episode);
    for (const room of ep.rooms) {
      app.showRoom(room.id);
      const expected = toRgba(renderRoom(room, ep.objects, ep.classes), ep.palette);
      const pixels = app.view.pixels();
      expect(pixels.length).toBe(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
      expect(firstDifference(pixels, expected), `episode ${episode} room ${room.id}`).toBe(-1);
    }
  }
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

/** Sends a mouse event to the room view at a cell. */
function fireAt(type: string, index: number, init: MouseEventInit = {}) {
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

const exits = () => page.getByRole("navigation", { name: "Exits" });

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

describe("logic records", () => {
  const teleporterCell = () => {
    const room = defined(app.editor).room(2, 55);
    return room.base.findIndex((c) => (c & 0xff) === 0x7f);
  };

  test("clicking a logic cell opens its record; changing a field edits it", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    await expect.element(page.getByRole("heading", { name: /^Logic record \d+ at/ })).toBeVisible();
    const room = page.getByRole("textbox", { name: "Target room" });
    await userEvent.clear(room);
    await userEvent.type(room, "43{Enter}");
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const record = defined(app.editor)
      .room(2, 55)
      .records.find((r) => r.slot === slot);
    expect(record && (record.data[4] | (record.data[5] << 8)) & 0x3ff).toBe(43);
    expect(document.querySelector(".teleports")?.textContent).toContain("43");
    await expect.element(page.getByRole("button", { name: "Save exe" })).toBeEnabled();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(defined(app.editor).isEdited(2, 55)).toBe(false);
  });

  test("the inspect tool adds and removes records", async () => {
    app.showEpisode(1, 43);
    await page.getByRole("radio", { name: "Inspect" }).click();
    const index = 5 * ROOM_WIDTH + 20;
    await clickCell(index);
    await expect.element(page.getByRole("heading", { name: /^No logic record at/ })).toBeVisible();
    await userEvent.selectOptions(
      page.getByRole("combobox", { name: "Record type" }),
      "13 Teleporter",
    );
    await page.getByRole("button", { name: "Add record" }).click();
    expect((defined(app.editor).room(1, 43).base[index] ?? 0) & 0xff).toBe(0x7f);
    await page.getByRole("button", { name: "Remove record" }).click();
    expect(defined(app.editor).room(1, 43).base[index]).toBe(game.room(1, 43).base[index]);
  });
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
  app = track(new App(root));
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
  app = track(new App(root));
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
  app = track(new App(root));
  app.load(bytes);
  await expect.element(page.getByRole("heading", { name: "Robot II – room 55" })).toBeVisible();
});

test("the actors of a room are listed and can be selected", async () => {
  await page.getByRole("tab", { name: "Actors" }).click();
  app.showEpisode(2, 123);
  const rows = [...document.querySelectorAll(".actors-view .actor-row")].map((r) =>
    (r.querySelector(".actor-text")?.textContent ?? r.textContent).slice(0, 40),
  );
  expect(rows.some((r) => r.startsWith("20 × "))).toBe(true); // the robots
  expect(rows.some((r) => r.startsWith("4 × "))).toBe(true); // the androids
  expect(document.querySelector(".actors-view")?.textContent).toContain(
    "Script keeps 8–15 × O_ALIEN: 20 in the room now, so it removes 5–12 at random " +
      "(depending on the game state)",
  );
  await page.getByRole("button", { name: "(12, 6)" }).click(); // an android
  expect(app.selected?.index).toBe(6 * ROOM_WIDTH + 12);
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

test("robots keep their sprite when the marks are redrawn", () => {
  app.showEpisode(2, 123);
  const before = app.view.pixelsOfMarks();
  app.view.setHover(5 * ROOM_WIDTH + 5);
  app.view.setHover(undefined);
  expect(firstDifference(app.view.pixelsOfMarks(), before)).toBe(-1);
});

test("hovering a RandObj line shows where robots are placed", async () => {
  app.sidePanel.show("actors");
  app.showEpisode(2, 123);
  const before = app.view.pixelsOfMarks();
  expect(document.querySelector(".actors-view")?.textContent).toContain(
    "Script keeps 2–4 × O_ANDROID: 4 in the room now, so it removes up to 2",
  );
  expect(document.querySelector(".actors-view")?.textContent).toContain(
    "Script keeps 1 × O_BOMB: 1 in the room now, so it leaves them as they are",
  );
  const row = page.getByText(/^Script keeps 8–15 × O_ALIEN/);
  await userEvent.hover(row);
  expect(firstDifference(app.view.pixelsOfMarks(), before)).not.toBe(-1);
  await userEvent.unhover(row);
  app.view.setHover(undefined); // the mouse may now be over the room
  expect(firstDifference(app.view.pixelsOfMarks(), before)).toBe(-1);
});

const scriptView = () => page.getByRole("region", { name: "Script" });

test("the script explains itself and can be edited", async () => {
  await page.getByRole("tab", { name: "Script" }).click();
  // episode I room 43: if(NewRoom) Message(700, 25); ...
  const source = document.querySelector(".script-source");
  expect(source?.textContent).toContain("Message(700, 25)");
  const message = [...(source?.querySelectorAll(".function") ?? [])].find(
    (e) => e.textContent === "Message",
  );
  expect(message?.getAttribute("title")).toMatch(/^Message\(text, delay\)/);
  const number = [...(source?.querySelectorAll(".number") ?? [])].find(
    (e) => e.textContent === "700",
  );
  // Message with a delay shows all of the text's variants as pages, one after another
  const pages = defined(game.episodeTexts(1)?.entries.get(700)).map((t) => displayText(t));
  expect(pages.length).toBe(3);
  expect(number?.getAttribute("title")).toBe(
    `3 pages, one after another:\n${pages.map((p, i) => `[${i + 1}/3] ${p}`).join("\n\n")}`,
  );
  await scriptView().getByRole("button", { name: "Bytecode" }).click();
  expect(document.querySelector(".script-code")?.textContent).toMatch(/call Message/);

  await scriptView().getByRole("button", { name: "Edit" }).click();
  // Cancel first, the confirming action last (as in the dialogs)
  const bar = [...document.querySelectorAll(".script-bar button")];
  expect(bar.map((b) => [b.textContent, b.className])).toEqual([
    ["Cancel", ""],
    ["Apply", "primary"],
  ]);
  const area = scriptView().getByRole("textbox", { name: "Script source" });
  // keys typed there are text, not the editor's shortcuts (m: map, g: grid)
  await userEvent.fill(area, "");
  await userEvent.keyboard("gm");
  expect(area.element().textContent).toBe("gm");
  expect(app.mapView.element.hidden).toBe(true);
  await expect.element(page.getByRole("checkbox", { name: "Grid" })).not.toBeChecked();
  // completion: the function with its arguments as fields (Tab to the next)
  await userEvent.fill(area, "");
  await userEvent.keyboard("Mess");
  await expect.element(page.getByRole("option", { name: /^Message/ })).toBeVisible();
  await userEvent.keyboard("{Enter}700{Tab}0");
  expect(area.element().textContent).toBe("Message(700, 0)");
  await userEvent.fill(area, "RoomWest = 42;\nMesage(1, 0);");
  expect(document.querySelector(".script-verdict")?.textContent).toMatch(/unknown function Mesage/);
  await expect.element(scriptView().getByRole("button", { name: "Apply" })).toBeDisabled();
  // a syntax error is marked where it is
  await userEvent.fill(area, "RoomWest = 42;\nRoomEast = ;");
  expect(document.querySelector(".script-verdict")?.textContent).toMatch(/at line 2, column 12/);
  expect(document.querySelector(".script-edit .script-error")?.textContent).toBe(";");
  await userEvent.fill(area, "RoomWest = 42;");
  expect(document.querySelector(".script-verdict")?.textContent).toBe("Compiles.");
  await scriptView().getByRole("button", { name: "Apply" }).click();
  expect(roomScript(defined(app.editor).room(1, 43))).toBe("RoomWest = 42;");
  // the exits follow the script; undo brings the old script back
  expect(document.querySelector('[data-direction="west"] .scripted')?.textContent).toBe("42");
  app.undo();
  expect(document.querySelector(".script-source")?.textContent).toContain("Message(700, 25)");
});

test("the exits byte can be changed per direction, undoably", async () => {
  // episode I room 43: west is closed in its exits byte
  const west = () => defined(document.querySelector('[data-direction="west"]') ?? undefined);
  await userEvent.selectOptions(page.getByRole("combobox", { name: "west exit" }), "neighbour");
  expect(exitMode(defined(app.editor).room(1, 43), "west")).toBe("neighbour");
  // room 42 exists: west now leads there
  expect(west().querySelector(".target.default")?.textContent).toBe("42");
  await userEvent.selectOptions(page.getByRole("combobox", { name: "east exit" }), "outside");
  expect(document.querySelector('[data-direction="east"] .target')?.textContent).toBe("2 outside");
  app.undo();
  app.undo();
  expect(defined(app.editor).isEdited(1, 43)).toBe(false);
  expect(west().querySelector("select")?.value).toBe("none");
});

test("the Room tab edits darkness, points, music and episode III's flags, undoably", async () => {
  const settings = () => roomSettings(defined(app.editor).room(app.episode, app.roomId));
  app.showRoom(42); // episode I room 42: darkness 80, 1000 points
  await page.getByRole("tab", { name: "Room" }).click();
  const darkness = page.getByRole("spinbutton", { name: "Darkness" });
  const points = page.getByRole("spinbutton", { name: "First visit points" });
  expect((darkness.element() as HTMLInputElement).value).toBe("80");
  await userEvent.fill(darkness, "50");
  await userEvent.keyboard("{Enter}");
  expect(settings().darkness).toBe(50);
  await userEvent.fill(points, "15");
  await userEvent.keyboard("{Enter}");
  expect(settings().points).toBe(1000);
  expect(document.querySelector(".status.error")?.textContent).toContain("multiple of 10");
  expect((points.element() as HTMLInputElement).value).toBe("1000");
  const music = page.getByRole("combobox", { name: "Music" });
  // Robot I's rooms play nothing; its MUSIC resource has episode II's SADMELO
  expect((music.element() as HTMLSelectElement).value).toBe("");
  await userEvent.selectOptions(music, "SADMELO");
  expect(settings().music).toBe("SADMELO");
  expect(document.querySelector<HTMLElement>(".settings-flags")?.hidden).toBe(true);
  app.undo();
  app.undo();
  expect(defined(app.editor).isEdited(1, 42)).toBe(false);

  // episode III room 144: the labyrinth and dizziness; room 1 (the title screen) plays HUMBA, which its MUSIC lacks
  app.showEpisode(3, 144);
  const dizzy = page.getByRole("checkbox", { name: "Hero gets dizzy" });
  expect((dizzy.element() as HTMLInputElement).checked).toBe(true);
  await dizzy.click();
  expect(settings().flags).toBe(1);
  app.showRoom(1);
  expect((music.element() as HTMLSelectElement).selectedOptions[0].textContent).toBe(
    "HUMBA (missing: silence)",
  );
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

test("outlines from hovering the actors or the script go when the room changes", async () => {
  // episode I room 43: RandObj(O_ALIEN, …) outlines where robots appear, SetObj-free script
  app.sidePanel.show("actors");
  await userEvent.hover(defined(document.querySelector(".actor-row.scripted") ?? undefined));
  expect(app.view.outlines()).toBeGreaterThan(0);
  app.back(); // like browser back: the row goes without a mouseleave
  app.showRoom(44);
  expect(app.view.outlines()).toBe(0);
  app.showEpisode(4, 157);
  app.sidePanel.show("script");
  const area = [...document.querySelectorAll(".script-source .function")].find(
    (e) => e.textContent === "SetWarea",
  );
  await userEvent.hover(defined(area));
  expect(app.view.outlines()).toBe(1);
  app.showRoom(167);
  expect(app.view.outlines()).toBe(0);
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

test("the script editor notices when undo changes the script underneath", async () => {
  defined(app.editor).setScript(1, 43, "RoomWest = 42;");
  app.showRoom(43);
  app.sidePanel.show("script");
  await scriptView().getByRole("button", { name: "Edit" }).click();
  app.undo();
  expect(document.querySelector(".script-verdict")?.textContent).toMatch(
    /changed since editing began/,
  );
  await expect.element(scriptView().getByRole("button", { name: "Apply" })).toBeEnabled();
});

test("the side column shows one panel at a time; clicking a record cell opens the record", async () => {
  const panel = (name: string) => document.querySelector<HTMLElement>(`.side-${name}`);
  expect(app.sidePanel.shown).toBe("tiles");
  expect(panel("script")?.hidden).toBe(true);
  await page.getByRole("tab", { name: "Script" }).click();
  expect([panel("tiles")?.hidden, panel("script")?.hidden]).toEqual([true, false]);
  // episode I room 11 has teleporters (logic cells): clicking one shows its record
  app.showRoom(11);
  const logic = game.room(1, 11).base.findIndex((c) => (c & 0xff) === 0x7f);
  expect(logic).toBeGreaterThan(0);
  await clickCell(logic);
  expect(app.sidePanel.shown).toBe("record");
  expect(panel("record")?.querySelector(".record-view")?.hasAttribute("hidden")).toBe(false);
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

test("the room's name is edited in place", async () => {
  const name = roomNameField();
  await userEvent.fill(name, "NEUER START");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.roomName(1, 43)?.name).toBe("NEUER START");
  expect(document.querySelector('.room-list [data-room="43"]')?.classList.contains("edited")).toBe(
    true,
  );
  expect(document.querySelector('.room-list [data-room="43"]')?.getAttribute("title")).toBe(
    "room 43 – NEUER START",
  );
  // a name the game cannot store changes nothing
  await userEvent.fill(name, "A;B");
  await userEvent.keyboard("{Enter}");
  expect(name.value).toBe("NEUER START");
  expect(document.querySelector(".status")?.classList.contains("error")).toBe(true);
  app.undo();
  expect(name.value).toBe("DER START");
  // rooms whose names the game does not show
  app.showEpisode(2, 600);
  expect(name.disabled).toBe(false);
  expect(name.placeholder).toBe("Szene 600 (no name)");
});

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

test("Test in game runs an exe that starts in the room, at the selected cell", async () => {
  const runs: { exe: Uint8Array; episode: number }[] = [];
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  app = track(
    new App(root, {
      play: (exe, episode) => {
        runs.push({ exe, episode });
        return Promise.resolve();
      },
    }),
  );
  app.load(bytes);
  app.showEpisode(2, 44);
  app.select(10 * ROOM_WIDTH + 7);
  await page.getByRole("button", { name: "Test in game" }).click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0]?.episode).toBe(2);
  expect(readEpisodeStart(parsePe(defined(runs[0]).exe), 2)).toEqual({ room: 44, x: 7, y: 10 });
  expect(document.querySelector(".status")?.textContent).toBe(
    "Game started: choose Robot II, it starts in room 44 at (7, 10)",
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

test("Enigma's number says what the entry gives", () => {
  app.showEpisode(4, 135); // Enigma(192) when a slot gets the lock
  const number = [...document.querySelectorAll(".script-source .number")].find(
    (e) => e.textContent === "192",
  );
  const entry = defined(readEventTable(game.image, 4)[192]);
  expect(number?.getAttribute("title")).toMatch(
    new RegExp(`^entry 192: ${entry.points} points, text 1992:\\n`),
  );
});

test("an oracle's record shows the symbol it needs", () => {
  app.showEpisode(2, 43);
  const room = game.room(2, 43);
  const slot = defined(room.records.find((r) => r.data[0] === 12)).slot;
  const index = room.base.findIndex((c) => c === (0x7f | (slot << 8)));
  app.select(index);
  const symbol = defined(document.querySelector(".oracle-symbol") ?? undefined, "the symbol");
  expect(symbol.querySelectorAll("canvas").length).toBe(4);
  expect(document.querySelector(".record-summary")?.textContent).toMatch(
    /^an oracle; once its symbol, tangram pieces 0x0[0-4]50 /,
  );
  // its hint eastwards (message 330 + n)
  app.showEpisode(3, 48);
  const room48 = game.room(3, 48);
  const oracle = defined(room48.records.find((r) => r.data[0] === 12));
  app.select(room48.base.findIndex((c) => c === (0x7f | (oracle.slot << 8))));
  const hint = defined(game.episodeTexts(3)?.entries.get(330 + (oracle.data[3] & 15)));
  expect(document.querySelector(".record-text")?.textContent).toBe(displayText(hint[0] ?? ""));
});

test("the record inspector fits into the side column", async () => {
  app.showEpisode(2, 43);
  await page.getByRole("tab", { name: "Record" }).click();
  const room = game.room(2, 43);
  const slot = defined(room.records.find((r) => r.data[0] === 12)).slot;
  app.select(room.base.findIndex((c) => c === (0x7f | (slot << 8))));
  const view = defined(document.querySelector<HTMLElement>(".record-view") ?? undefined);
  expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
  for (const child of view.querySelectorAll<HTMLElement>("*"))
    expect(child.getBoundingClientRect().right, child.className).toBeLessThanOrEqual(
      view.getBoundingClientRect().right + 0.5,
    );
});
