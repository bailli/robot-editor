import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { LOGIC_CELL, ROOM_WIDTH, roomActors } from "@robot/formats";

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
