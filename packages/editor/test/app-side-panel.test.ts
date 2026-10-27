import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  LOGIC_CELL,
  ROOM_WIDTH,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  parseMod,
  readDealer,
  roomActors,
} from "@robot/formats";

import { app, bytes, clickCell, game, useApp } from "./app-setup.ts";
import { defined } from "./game.ts";

useApp();

// saving offers a download: a link is clicked
beforeEach(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (name: string) => app.sidePanel.state(name);
const cellName = (index: number) => `(${index % ROOM_WIDTH}, ${Math.floor(index / ROOM_WIDTH)})`;
const status = () => document.querySelector(".status")?.textContent;
const roomButton = (id: number) =>
  document.querySelector<HTMLElement>(`.room-list [data-room="${id}"]`);
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const dealer = () => page.getByRole("region", { name: "Dealer" });
const price = (n: number) => dealer().getByLabelText(`Price of good ${n}`, { exact: true });

test("the tabs tell what the room has without opening them", () => {
  // episode I room 43: two actors and a RandObj call, a script, no circuit, nothing selected
  app.showEpisode(1, 43);
  expect(tab("actors")).toMatchObject({
    badge: "3",
    empty: false,
    title: "2 actors, 1 RandObj call",
  });
  expect(tab("script")).toMatchObject({ badge: "●", empty: false });
  expect(tab("script").title).toMatch(/^A script of \d+ lines$/);
  expect(tab("circuit")).toMatchObject({ badge: undefined, empty: true });
  expect(tab("episode")).toMatchObject({
    badge: undefined,
    empty: false,
    title: "Starts in room 43 at (5, 14); a rucksack of 50; the dealer sells 27 goods",
  });
  // seven circuit nodes, none on
  app.showRoom(128);
  expect(tab("circuit")).toMatchObject({ badge: "0/7", empty: false, title: "0 of 7 nodes on" });
  // episode II room 123: robots, androids, a bomb and RandObj calls
  app.showEpisode(2, 123);
  expect(tab("actors").title).toMatch(/^\d+ actors, 3 RandObj calls$/);
  // episode III: no dealer
  app.showEpisode(3, 41);
  expect(tab("episode")).toMatchObject({
    empty: false,
    title: "Starts in room 41 at (8, 15); a rucksack of 200; no dealer",
  });
});

test("the Record tab counts the room's records, lists them and names the selected one", async () => {
  // episode II room 55: a teleporter
  app.showEpisode(2, 55);
  const records = game.room(2, 55).records.length;
  expect(tab("record")).toMatchObject({
    badge: String(records),
    empty: false,
    title: `${records} logic record${records === 1 ? "" : "s"} in this room`,
  });
  // with nothing selected, the tab lists them; a click selects one's cell
  const list = page.getByRole("tabpanel", { name: "Record" });
  await page.getByRole("tab", { name: "Record" }).click();
  expect(document.querySelectorAll(".record-list-row").length).toBe(records);
  const teleporter = game.room(2, 55).base.findIndex((c) => (c & 0xff) === LOGIC_CELL);
  await list
    .getByRole("button", { name: cellName(teleporter), exact: true })
    .first()
    .click();
  expect(app.selected?.index).toBe(teleporter);
  expect(tab("record").title).toMatch(/^\(\d+, \d+\): /);
  await expect.element(list.getByRole("heading", { name: /^Logic record \d+ at/ })).toBeVisible();
  // Escape: back to the list
  await userEvent.keyboard("{Escape}");
  expect(app.selected).toBeUndefined();
  await expect.element(list.getByRole("heading", { name: /logic records?$/ })).toBeVisible();
  // a room without records: dimmed
  const empty = defined(game.episode(2).rooms.find((r) => r.records.length === 0));
  app.showRoom(empty.id);
  expect(tab("record")).toMatchObject({ badge: undefined, empty: true });
});

test("Inspect opens the tab of what is at the cell: record, actor, circuit", async () => {
  await userEvent.keyboard("i");
  expect(app.tool).toBe("inspect");
  // episode II room 55: its teleporter's record
  app.showEpisode(2, 55);
  await clickCell(game.room(2, 55).base.findIndex((c) => (c & 0xff) === LOGIC_CELL));
  expect(app.sidePanel.shown).toBe("record");
  // episode I room 43: a robot placed in the map, its row marked in the Actors tab
  app.showEpisode(1, 43);
  const actor = defined(
    roomActors(game.room(1, 43), game.episode(1).classes).find(
      (a) => !a.record && a.cell > 3 * ROOM_WIDTH,
    ),
  );
  await clickCell(actor.cell);
  expect(app.sidePanel.shown).toBe("actors");
  expect(document.querySelector(".actor-cells button.current")?.textContent).toBe(
    cellName(actor.cell),
  );
  // episode I room 128: a wire laid next to node 1 at (4, 3) is part of its circuit
  app.showRoom(128);
  app.sidePanel.show("circuit");
  await page
    .getByRole("tabpanel", { name: "Circuit" })
    .getByRole("button", { name: /wire ─/ })
    .click();
  await clickCell(3 * ROOM_WIDTH + 3);
  await userEvent.keyboard("i");
  app.sidePanel.show("tiles");
  await clickCell(3 * ROOM_WIDTH + 3);
  expect(app.sidePanel.shown).toBe("circuit");
});

test("keys choose the tool, the layer and the tab; the help lists them", async () => {
  for (const [key, tool] of [
    ["s", "select"],
    ["f", "fill"],
    ["i", "inspect"],
    ["p", "paint"],
  ] as const) {
    await userEvent.keyboard(key);
    expect(app.tool).toBe(tool);
    await expect.element(page.getByRole("radio", { name: capitalized(tool) })).toBeChecked();
  }
  await userEvent.keyboard("l");
  expect(app.layer).toBe("overlay");
  await userEvent.keyboard("l");
  expect(app.layer).toBe("base");
  for (const [n, name] of app.sidePanel.names.entries()) {
    await userEvent.keyboard(String(n + 1));
    expect(app.sidePanel.shown).toBe(name);
  }
  // the help names every tab by its key, in the panel's order
  await userEvent.keyboard("?");
  const help = page.getByRole("dialog", { name: "Shortcuts" });
  const rows = [...help.element().querySelectorAll("caption")]
    .find((c) => c.textContent === "Side panel")
    ?.closest("table")
    ?.querySelectorAll("tr");
  const labels = [
    ...document.querySelectorAll<HTMLElement>(".side-tabs [role=tab] span:first-child"),
  ];
  expect([...(rows ?? [])].map((r) => r.cells[1].textContent.split(" ")[0])).toEqual(
    labels.map((l) => l.textContent),
  );
  for (const key of ["P", "F", "S", "I", "L"]) {
    expect([...help.element().querySelectorAll("kbd")].some((k) => k.textContent === key)).toBe(
      true,
    );
  }
  await userEvent.keyboard("{Escape}");
});

test("tiles painted with go into a row of recent ones", async () => {
  app.showEpisode(1, 43);
  const recent = () =>
    [...document.querySelectorAll<HTMLElement>(".tile-recent button")].map((b) =>
      Number(b.dataset["tile"]),
    );
  expect(recent()).toEqual([]);
  const free = game.room(1, 43).base.findIndex((c, i) => i > 5 * ROOM_WIDTH && c === 0);
  for (const tile of [0x0006, 0x0105, 0x0006]) {
    app.setTile(tile);
    await clickCell(free);
  }
  expect(recent()).toEqual([0x0006, 0x0105]);
  app.setTile(0);
  document.querySelector<HTMLElement>('.tile-recent [data-tile="261"]')?.click();
  expect(app.tile).toBe(0x0105);
});

test("a script being edited marks its tab until applied or cancelled", async () => {
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Script" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  expect(tab("script").badge).toBe("●"); // nothing typed yet
  await userEvent.keyboard("x");
  expect(tab("script")).toMatchObject({ badge: "✎" });
  expect(tab("script").title).toMatch(/edited, not applied$/);
  // another room: the draft is kept, marked in the room list, and comes back
  app.showRoom(44);
  expect(status()).toBe("The script draft of room 43 is kept: Apply or Cancel it there");
  expect(roomButton(43)?.classList.contains("drafted")).toBe(true);
  expect(tab("script").badge).not.toBe("✎");
  // saving says it is not saved
  app.save();
  expect(status()).toMatch(/script drafts not applied \(not saved\) in room 43$/);
  app.showRoom(43);
  expect(tab("script").badge).toBe("✎");
  expect(document.querySelector(".script-edit .cm-content")?.textContent).toMatch(/^x/);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(tab("script").badge).toBe("●");
  expect(roomButton(43)?.classList.contains("drafted")).toBe(false);
  // another exe or mod drops the drafts
  await page.getByRole("button", { name: "Edit" }).click();
  await userEvent.keyboard("y");
  app.load(bytes);
  expect(tab("script").badge).toBe("●");
});

test("the Episode tab edits the dealer's goods, undoably; the mod keeps them", async () => {
  const original = defined(readDealer(game.image, 1));
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect.element(dealer().getByText("Dealers appear in rooms 18, 24, 42.")).toBeVisible();
  expect(document.querySelectorAll(".dealer-good").length).toBe(27);
  await expect.element(dealer().getByText("27 of 27")).toBeVisible();
  // the goods are classes, shown as the tiles the game makes of them
  const names = [...document.querySelectorAll(".dealer-name")].map((n) => n.textContent);
  expect(names.slice(14, 17)).toEqual(["Tonic", "Sickle", "Save"]);
  expect(names.at(-1)).toBe("Lamp");
  expect(names).not.toContain("Thief");
  // a tile without a class cannot be sold
  app.setTile(0);
  document
    .querySelector(".dealer-good canvas")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(document.querySelector(".status")?.textContent).toBe(
    "The tile 0x0000 has no class: the dealer cannot sell it",
  );
  expect(app.editor?.dealer(1)).toEqual(original);
  await expect
    .element(dealer().getByRole("button", { name: "Add the current tile" }))
    .toBeDisabled();

  // a price: one undo step; the field stays the one focused
  const field = price(1).element();
  await userEvent.fill(price(1), "99");
  await userEvent.keyboard("{Tab}");
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ classId: 0x20, state: 0, price: 99 });
  expect(price(1).element()).toBe(field);
  expect(tab("episode")).toMatchObject({
    badge: "●",
    title: "Starts in room 43 at (5, 14); a rucksack of 50; the dealer sells 27 goods (edited)",
  });

  // the last good goes; the current tile replaces the first one; fewer shown
  const rows = () => document.querySelectorAll(".dealer-good");
  await dealer().getByRole("button", { name: "×" }).last().click();
  expect(rows().length).toBe(26);
  app.setTile(0x0315);
  defined(rows()[0].querySelector("canvas") ?? undefined).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ classId: 0x15, state: 3, price: 99 });
  await userEvent.fill(dealer().getByLabelText("Shown at most"), "6");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.dealer(1)?.most).toBe(6);
  // room for one more now
  await dealer().getByRole("button", { name: "Add the current tile" }).click();
  expect(app.editor?.dealer(1)?.goods.at(-1)).toEqual({ classId: 0x15, state: 3, price: 10 });

  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.dealer.map((c) => [c.episode, c.goods.length, c.most])).toEqual([
    [1, 27, 6],
  ]);

  // undo, step by step, back to the exe's goods
  for (let i = 0; i < 5; i++) app.undo();
  expect(app.editor?.dealer(1)).toEqual(original);
  expect(tab("episode").badge).toBeUndefined();
  await expect.element(dealer().getByRole("button", { name: "Original goods" })).toBeDisabled();
});

test("the Episode tab sets the start to the shown room and the picked cell, undoably", async () => {
  const start = () => page.getByRole("region", { name: "Start" });
  app.showEpisode(1, 44);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect
    .element(start().getByText("Robot I starts in room", { exact: false }))
    .toHaveTextContent("Robot I starts in room 43, the hero at (5, 14).");
  // no cell picked: the start's cell, in the shown room
  await start().getByRole("button", { name: "Start here" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 5, y: 14 });
  expect(status()).toBe("The episode now starts in room 44 at (5, 14)");
  // a cell picked with Select
  app.setArea({ x: 20, y: 10, w: 1, h: 1 });
  await start().getByRole("button", { name: "Start here" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 20, y: 10 });
  expect(tab("episode")).toMatchObject({
    badge: "●",
    title: "Starts in room 44 at (20, 10) (edited); a rucksack of 50; the dealer sells 27 goods",
  });
  expect(document.querySelector(".start-line")?.textContent).toBe(
    "Robot I starts in room 44, the hero at (20, 10) (edited).",
  );
  // the start cell is marked: its frame's left edge in green
  const marked = (x: number, y: number) => {
    const zoom = app.view.zoom;
    const at =
      (y * TILE_HEIGHT + TILE_HEIGHT / 2) * zoom * SCREEN_WIDTH * zoom + x * TILE_WIDTH * zoom + 1;
    return [...app.view.pixelsOfMarks().slice(at * 4, at * 4 + 4)];
  };
  app.setArea(undefined);
  expect(marked(20, 10)).toEqual([0, 170, 60, 255]);
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.start).toEqual([{ episode: 1, room: 44, x: 20, y: 10 }]);
  // back to the exe's start, then undone step by step
  await start().getByRole("button", { name: "Original start" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 43, x: 5, y: 14 });
  expect(app.roomId).toBe(43);
  expect(marked(5, 14)).toEqual([0, 170, 60, 255]);
  app.undo();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 20, y: 10 });
  app.undo();
  app.undo();
  expect(app.editor?.start(1)).toEqual({ room: 43, x: 5, y: 14 });
  expect(tab("episode").badge).toBeUndefined();
  await expect.element(start().getByRole("button", { name: "Original start" })).toBeDisabled();
});

test("the Episode tab sets the rucksack and the oracles' flags, undoably; the mod keeps them", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const rucksack = page.getByRole("region", { name: "Rucksack" });
  const oracles = page.getByRole("region", { name: "Flags" });
  await expect.element(rucksack.getByLabelText("Capacity")).toHaveValue(38);
  await userEvent.fill(rucksack.getByLabelText("Capacity"), "12");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.rucksack(0)).toBe(12);
  // out of range: the field goes back
  await userEvent.fill(rucksack.getByLabelText("Capacity"), "251");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.rucksack(0)).toBe(12);
  await expect.element(rucksack.getByLabelText("Capacity")).toHaveValue(12);
  await oracles.getByRole("checkbox", { name: /sending the hero/ }).click();
  await oracles.getByRole("checkbox", { name: /their hint/ }).click();
  expect(app.editor?.episodeFlags(0)).toBe(0x4801e946);
  await oracles.getByRole("checkbox", { name: /without the key/ }).click();
  await oracles.getByRole("checkbox", { name: /sprite's colours/ }).click();
  expect(app.editor?.episodeFlags(0)).toBe(0x4809e966);
  // Junior's Teleport() points: cleared on entering a room, as everywhere but in III
  await expect.element(oracles.getByRole("checkbox", { name: /only in their room/ })).toBeChecked();
  await expect
    .element(oracles.getByRole("checkbox", { name: /block from room 100/ }))
    .not.toBeChecked();
  const backdrop = page.getByRole("region", { name: "Backdrop" });
  await userEvent.selectOptions(backdrop.getByLabelText("Backdrop room"), "minus100");
  expect(app.editor?.backdropRule(0)).toBe("minus100");
  app.undo();
  expect(tab("episode")).toMatchObject({ badge: "●" });
  expect(tab("episode").title).toMatch(/a rucksack of 12, settings edited/);
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.rucksack).toEqual([{ episode: 0, capacity: 12 }]);
  expect(saved.changes.flags).toEqual([{ episode: 0, flags: 0x4809e966 }]);
  await oracles.getByRole("checkbox", { name: /without the key/ }).click();
  await oracles.getByRole("checkbox", { name: /sprite's colours/ }).click();
  for (let i = 0; i < 7; i++) app.undo();
  expect(app.editor?.rucksack(0)).toBe(38);
  expect(app.editor?.episodeFlags(0)).toBe(0x48012946);
  await expect
    .element(oracles.getByRole("checkbox", { name: /sending the hero/ }))
    .not.toBeChecked();
  expect(tab("episode").badge).toBeUndefined();
});

test("the Episode tab copies tile types of other episodes, undoably; the mod keeps them", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  await expect
    .element(types.getByText("Robot Junior has no tile types of other episodes."))
    .toBeVisible();
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x51));
  // the same number, free in Junior
  await expect.element(types.getByLabelText("To type")).toHaveValue(String(0x51));
  await types.getByRole("button", { name: "Copy" }).click();
  expect(app.editor?.tileTypeCopies(0)).toEqual([{ episode: 0, to: 0x51, from: 2, of: 0x51 }]);
  expect(app.editor?.game.episode(0).classes.classes.get(0x51)?.id).toBe(
    game.episode(2).classes.classes.get(0x51)?.id,
  );
  expect(document.querySelectorAll(".side-episode .dealer-good").length).toBeGreaterThan(0);
  // the copy is in the tile list, in each state its shape draws (the oracle: 10)
  const listed = [...document.querySelectorAll<HTMLElement>(".tile-grid button")].map((b) =>
    Number(b.dataset["tile"]),
  );
  expect(listed.filter((t) => (t & 0xff) === 0x51)).toEqual(
    Array.from({ length: 10 }, (_, k) => 0x51 | (k << 8)),
  );
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.tileTypes).toEqual([{ episode: 0, from: 2, types: [[0x51, 0x51]] }]);
  // removed with ×, back with undo, gone with another
  await types.getByRole("button", { name: "×" }).click();
  expect(app.editor?.tileTypeCopies(0)).toEqual([]);
  app.undo();
  expect(app.editor?.tileTypeCopies(0)).toHaveLength(1);
  app.undo();
  expect(app.editor?.tileTypeCopies(0)).toEqual([]);
  expect(app.editor?.game).toBe(app.editor?.pristine);
  expect(document.querySelector('.tile-grid [data-tile="81"]')).toBeNull();
});

test("the copy form's target: the same number where free, else the first type no copy has", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  const to = types.getByLabelText("To type");
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  // types 0x01 and 0x02 have classes in Junior: the first free type, 0x3a (0x39 lies in room 51)
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x01));
  await expect.element(to).toHaveValue(String(0x3a));
  await types.getByRole("button", { name: "Copy" }).click();
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x02));
  await expect.element(to).toHaveValue(String(0x3b));
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x50));
  await expect.element(to).toHaveValue(String(0x50));
  app.undo();
});
