import { beforeEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  Game,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  renderRoom,
  toRgba,
} from "@robot/formats";

import { App, line } from "../src/app.ts";
import "../src/style.css";
import { defined, exeBytes, firstDifference } from "./game.ts";

const bytes = await exeBytes();
const game = new Game(bytes);
let app: App;

beforeEach(() => {
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.append(root);
  app = new App(root);
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

async function clickCell(index: number, button: "left" | "right" = "left") {
  await userEvent.click(app.view.element, { position: cellCentre(index), button });
}

test("shows the start room of Robot I as the renderer draws it", async () => {
  await expect.element(page.getByRole("heading", { name: "Robot I – room 43" })).toBeVisible();
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
  expect(west?.textContent).toBe("← West—42");
  expect(west?.querySelector(".conditional")?.getAttribute("title")).toBe(
    "room 42 (set by the script, depending on the game state)",
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
    .toHaveAttribute("title", "room 129 (Teleport(129, 7, 21), depending on the game state)");
  await button.click();
  await expect.element(page.getByRole("heading", { name: "Robot I – room 129" })).toBeVisible();
});

test("doors and stairs are listed with the exits", async () => {
  app.showEpisode(3, 47); // a hut: its door leads inside, room 147
  const door = document.querySelector('.passage[data-direction="door in"]');
  expect(door?.textContent).toBe("Door in147");
  await exits().getByRole("button", { name: "147" }).click();
  await expect.element(page.getByRole("heading", { name: "Robot III – room 147" })).toBeVisible();
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
    .toHaveAttribute("title", "room 155 (teleporter at (38, 2), arriving at (6, 7))");
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

test("back and forward return along the rooms visited, also across episodes", async () => {
  // Robot I room 43 -> 44 (exit) -> episode III room 47 -> 147 (door)
  await exits().getByRole("button", { name: "44" }).click();
  app.showEpisode(3, 47);
  await exits().getByRole("button", { name: "147" }).click();
  const heading = (name: string) => page.getByRole("heading", { name });
  await expect.element(heading("Robot III – room 147")).toBeVisible();

  await page.getByRole("button", { name: "◀ 47" }).click();
  await expect.element(heading("Robot III – room 47")).toBeVisible();
  await userEvent.keyboard("{Backspace}");
  await expect.element(heading("Robot I – room 44")).toBeVisible();
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await expect.element(heading("Robot III – room 47")).toBeVisible();

  // a new way drops the forward history
  app.back();
  app.showRoom(45);
  await expect.element(page.getByRole("button", { name: "▶" })).toBeDisabled();
  await page.getByRole("button", { name: "◀ 44" }).click();
  await expect.element(heading("Robot I – room 44")).toBeVisible();
});
