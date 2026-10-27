import { describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ROOM_WIDTH, displayText, readEventTable } from "@robot/formats";

import { app, bytes, clickCell, game, useApp } from "./app-setup.ts";
import { defined, firstDifference } from "./game.ts";

useApp();

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
    // the field keeps the focus (Ctrl+Z there is its own text undo)
    expect(document.activeElement).toBe(room.element());
    app.undo();
    expect(defined(app.editor).isEdited(2, 55)).toBe(false);
    // what is no number leaves the record as it is
    for (const text of ["", "4x", "0x2g"]) {
      await userEvent.fill(room, text);
      await userEvent.keyboard("{Enter}");
      expect(defined(app.editor).isEdited(2, 55)).toBe(false);
    }
  });

  test("loading an exe again leaves nothing selected", async () => {
    app.showEpisode(2, 55);
    await clickCell(teleporterCell());
    expect(app.selected).toBeDefined();
    app.load(bytes);
    expect(app.selected).toBeUndefined();
    await expect
      .element(page.getByRole("heading", { name: /^Logic record/ }))
      .not.toBeInTheDocument();
  });

  test("Ctrl+S in a field saves the exe with what was typed", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const target = () => {
      const record = defined(app.editor)
        .room(2, 55)
        .records.find((r) => r.slot === slot);
      return record && (record.data[4] | (record.data[5] << 8)) & 0x3ff;
    };
    let saved: number | undefined;
    const save = vi.spyOn(app, "save").mockImplementation(() => {
      saved = target();
      return undefined;
    });
    const room = page.getByRole("textbox", { name: "Target room" });
    await userEvent.clear(room);
    await userEvent.type(room, "44");
    await userEvent.keyboard("{Control>}s{/Control}");
    expect(save).toHaveBeenCalledOnce();
    expect(saved).toBe(44);
  });

  test("a teleporter's condition is chosen and drawn as the game draws it", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    const condition = page.getByRole("combobox", { name: "Condition" });
    await expect.element(condition).toHaveValue("1"); // the hero must carry its object
    const useCell = page.getByRole("checkbox", { name: "Always enterable" });
    await expect.element(useCell).toBeDisabled(); // the game ignores it with a condition
    const backed = app.view.pixels();
    await userEvent.selectOptions(condition, "none");
    await expect.element(useCell).toBeEnabled();
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const record = defined(app.editor)
      .room(2, 55)
      .records.find((r) => r.slot === slot);
    expect(record?.data[7]).toBe(0);
    // no longer on colour 15 with the teleporter's frame: the cell alone
    const at = firstDifference(backed, app.view.pixels()) / 4;
    expect(Math.floor((at % 640) / 16) + Math.floor(at / 640 / 12) * ROOM_WIDTH).toBe(index);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(defined(app.editor).isEdited(2, 55)).toBe(false);
  });

  test("Tab after changing a field goes on to the next one", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    const x = page.getByRole("textbox", { name: "Arrival x" });
    await userEvent.fill(x, "5");
    await userEvent.tab();
    const y = page.getByRole("textbox", { name: "Arrival y" });
    expect(document.activeElement).toBe(y.element());
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const data = () =>
      defined(
        defined(app.editor)
          .room(2, 55)
          .records.find((r) => r.slot === slot),
      ).data;
    expect((data()[4] | (data()[5] << 8)) >> 10).toBe(5);
    // the kept controls edit the record as it is now: x stays
    await userEvent.fill(y, "7");
    await userEvent.tab();
    expect([(data()[4] | (data()[5] << 8)) >> 10, data()[6]]).toEqual([5, 7]);
    expect(document.querySelector(".record-summary")?.textContent).toMatch(/at \(5, 7\)/);
    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(defined(app.editor).isEdited(2, 55)).toBe(false);
  });

  test("record types are listed by number; any record can be gone after leaving", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    const options = [
      ...document.querySelectorAll<HTMLOptionElement>('[aria-label="Record type"] option'),
    ].map((o) => Number(o.value));
    expect(options).toEqual([1, 3, 5, 7, 8, 11, 12, 13]);
    await page.getByRole("checkbox", { name: "Gone after leaving" }).click();
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const record = defined(app.editor)
      .room(2, 55)
      .records.find((r) => r.slot === slot);
    expect((record?.data[1] ?? 0) & 0x20).toBe(0x20);
    expect(document.querySelector(".record-summary")?.textContent).toMatch(
      /; gone once the hero leaves the room$/,
    );
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(defined(app.editor).isEdited(2, 55)).toBe(false);
  });

  test("a record's cell preview takes the current tile and gives its own", async () => {
    app.showEpisode(2, 55);
    const index = teleporterCell();
    await clickCell(index);
    const slot = (defined(app.editor).room(2, 55).base[index] ?? 0) >> 8;
    const shown = () =>
      defined(
        defined(app.editor)
          .room(2, 55)
          .records.find((r) => r.slot === slot),
      ).data;
    const preview = () =>
      defined(document.querySelector<HTMLElement>(".record-row .pickable") ?? undefined);
    app.setTile(0x0d15);
    preview().click();
    expect(shown()[2] | (shown()[3] << 8)).toBe(0x0d15);
    await expect
      .element(page.getByRole("textbox", { name: "Cell", exact: true }))
      .toHaveValue("0x0d15");
    app.setTile(0);
    preview().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(app.tile).toBe(0x0d15);
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

describe("circuits", () => {
  const circuit = () => page.getByRole("tabpanel", { name: "Circuit" });

  test("the circuit tab evaluates the room as it is painted", async () => {
    app.showRoom(128); // episode I: seven nodes, the hero lays the pieces
    await page.getByRole("tab", { name: "Circuit" }).click();
    await expect
      .element(circuit().getByRole("heading", { name: "Circuit: 0 of 7 nodes on" }))
      .toBeVisible();
    expect(app.view.outlines()).toBe(0);
    // node 1 at (4, 3) reads the 1 at (1, 3) once wires fill (2, 3) and (3, 3)
    await circuit()
      .getByRole("button", { name: /wire ─/ })
      .click();
    expect(app.tool).toBe("paint");
    await clickCell(3 * ROOM_WIDTH + 2);
    await clickCell(3 * ROOM_WIDTH + 3);
    await expect
      .element(circuit().getByRole("heading", { name: "Circuit: 1 of 7 nodes on" }))
      .toBeVisible();
    expect(document.querySelector('.circuit-node[data-state="1"]')?.textContent).toMatch(
      /^Node 1 \(4, 3\)on/,
    );
    // its bulb is lit in the room while the signals are shown, as the game will light it
    const lit = app.view.pixels();
    const signals = circuit().getByRole("checkbox", { name: "Show the signals in the room" });
    await signals.click();
    expect(document.activeElement).toBe(signals.element()); // Space toggles it again
    const at = firstDifference(lit, app.view.pixels()) / 4;
    expect([Math.floor((at % 640) / 16), Math.floor(at / 640 / 12)]).toEqual([4, 3]);
    await circuit().getByRole("checkbox", { name: "Show the signals in the room" }).click();
    // the final node's stairs to 228 are listed with what they wait for
    expect(document.querySelector(".circuit-final")?.textContent).toMatch(
      /stairs down at \(22, 27\) to room 228 appear once all 7 nodes are on/,
    );
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect
      .element(circuit().getByRole("heading", { name: "Circuit: 0 of 7 nodes on" }))
      .toBeVisible();
  });

  test("a node is added at the selected cell and opens its record", async () => {
    app.showRoom(43);
    app.sidePanel.show("circuit");
    await expect.element(circuit().getByRole("heading", { name: "No circuit" })).toBeVisible();
    await page.getByRole("radio", { name: "Inspect" }).click();
    const index = 5 * ROOM_WIDTH + 20;
    await clickCell(index);
    app.sidePanel.show("circuit");
    await circuit().getByRole("button", { name: "Add node at (20, 5)" }).click();
    const cell = defined(app.editor).room(1, 43).base[index] ?? 0;
    expect(cell & 0xff).toBe(0x7f);
    const record = defined(app.editor)
      .room(1, 43)
      .records.find((r) => r.slot === cell >> 8);
    expect(record?.data[0]).toBe(11);
    await expect
      .element(circuit().getByRole("heading", { name: "Circuit: 0 of 1 nodes on" }))
      .toBeVisible();
    await circuit()
      .getByRole("button", { name: /^Node \d+ \(20, 5\)$/ })
      .click();
    await expect
      .element(page.getByRole("heading", { name: /^Logic record \d+ at \(20, 5\)/ }))
      .toBeVisible();
  });
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

test("an oracle's hint is picked by its message id", async () => {
  app.showEpisode(3, 48);
  await page.getByRole("tab", { name: "Record" }).click();
  const room = game.room(3, 48);
  const oracle = defined(room.records.find((r) => r.data[0] === 12));
  app.select(room.base.findIndex((c) => c === (0x7f | (oracle.slot << 8))));
  const id = page.getByRole("textbox", { name: "Hint (eastwards)" });
  await expect.element(id).toHaveValue(String(330 + (oracle.data[3] & 15)));
  await userEvent.fill(id, "331");
  await userEvent.keyboard("{Enter}");
  const data = () =>
    defined(
      defined(app.editor)
        .room(3, 48)
        .records.find((r) => r.slot === oracle.slot),
    ).data;
  // the low 4 bits of the cell's state, the rest of it kept
  expect(data()[3]).toBe((oracle.data[3] & 0xf0) | 1);
  const hint = defined(game.episodeTexts(3)?.entries.get(331));
  expect(document.querySelector(".record-text")?.textContent).toBe(displayText(hint[0] ?? ""));
  // out of range: the field goes back to the value
  await userEvent.fill(id, "346");
  await userEvent.keyboard("{Enter}");
  await expect.element(id).toHaveValue("331");
  await page.getByRole("checkbox", { name: "Symbol found" }).click();
  expect(data()[3]).toBe((oracle.data[3] & 0xe0) | 0x11);
  expect(document.querySelector(".record-summary")?.textContent).toMatch(
    /^an oracle; its symbol counts as found:/,
  );
  await userEvent.keyboard("{Control>}z{/Control}");
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(defined(app.editor).isEdited(3, 48)).toBe(false);
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
