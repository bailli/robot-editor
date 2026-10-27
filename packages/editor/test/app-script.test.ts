import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ROOM_WIDTH, displayText, roomScript, roomSettings } from "@robot/formats";

import { app, clickCell, game, roomNameField, scriptView, useApp } from "./app-setup.ts";
import { defined, firstDifference } from "./game.ts";

useApp();

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
  // other edits of the room leave the script as it is shown (scrolled, the info line)
  app.setDark(true);
  expect(document.querySelector(".script-source")).toBe(source);
  app.setDark(false);
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
  // fill selects all, then types; under load CodeMirror may not have taken the selection
  // yet and the text is appended: retry until the editor holds exactly what was asked
  const fillSource = (text: string) =>
    expect
      .poll(async () => {
        await userEvent.fill(area, text);
        return [...area.element().querySelectorAll(".cm-line")]
          .map((line) => line.textContent)
          .join("\n");
      })
      .toBe(text);
  // keys typed there are text, not the editor's shortcuts (m: map, g: grid)
  await fillSource("");
  await userEvent.keyboard("gm");
  expect(area.element().textContent).toBe("gm");
  expect(app.mapView.element.hidden).toBe(true);
  await expect.element(page.getByRole("checkbox", { name: "Grid" })).not.toBeChecked();
  // completion: the function with its arguments as fields (Tab to the next)
  await fillSource("");
  await userEvent.keyboard("Mess");
  // picked by click: CodeMirror ignores Enter right after the list opens (interactionDelay)
  await page.getByRole("option", { name: /^Message/ }).click();
  await userEvent.keyboard("700{Tab}0");
  expect(area.element().textContent).toBe("Message(700, 0)");
  await fillSource("RoomWest = 42;\nMesage(1, 0);");
  await expect
    .poll(() => document.querySelector(".script-verdict")?.textContent)
    .toMatch(/unknown function Mesage/);
  await expect.element(scriptView().getByRole("button", { name: "Apply" })).toBeDisabled();
  // a syntax error is marked where it is
  await fillSource("RoomWest = 42;\nRoomEast = ;");
  await expect
    .poll(() => document.querySelector(".script-verdict")?.textContent)
    .toMatch(/at line 2, column 12/);
  await expect
    .poll(() => document.querySelector(".script-edit .script-error")?.textContent)
    .toBe(";");
  // handlers: a line above saying what they wait for, a warning where they run on
  await fillSource(
    "if (Event(EV_TAKE | EV_ROOM))\n   Message(1, 0);\nif (E_Area(1))\n   {\n   return;\n   }",
  );
  await expect.poll(() => document.querySelector(".script-verdict")?.textContent).toBe("Compiles.");
  const notes = (selector: string) =>
    [...document.querySelectorAll(`.script-edit ${selector}`)].map((e) => e.textContent);
  await expect
    .poll(() => notes(".script-handler-label"))
    .toEqual(["▸ on take · entering the room", "▸ on walk area 1"]);
  expect(notes(".script-handler-warning")).toEqual(["⚠ no return: registers line 3 again"]);
  expect(document.querySelector(".script-handler-warning")?.getAttribute("title")).toMatch(
    /^No return: after this handler the script runs on at line 3, and each time it registers the handler in line 3 once more/,
  );
  expect(document.querySelectorAll(".script-edit .cm-line.script-handler").length).toBe(6);
  const constant = [...document.querySelectorAll(".script-edit .constant")].find(
    (e) => e.textContent === "EV_ROOM",
  );
  expect(constant?.getAttribute("title")).toMatch(/^EV_ROOM = 8, event for Event\(mask\)/);
  await fillSource("RoomWest = 42;");
  await expect.poll(() => document.querySelector(".script-verdict")?.textContent).toBe("Compiles.");
  await scriptView().getByRole("button", { name: "Apply" }).click();
  expect(roomScript(defined(app.editor).room(1, 43))).toBe("RoomWest = 42;");
  // the exits follow the script; undo brings the old script back
  expect(document.querySelector('[data-direction="west"] .scripted')?.textContent).toBe("42");
  app.undo();
  expect(document.querySelector(".script-source")?.textContent).toContain("Message(700, 25)");
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

test("the Room tab edits the description of the room's name", async () => {
  await page.getByRole("tab", { name: "Room" }).click();
  const field = page.getByRole("textbox", { name: "Description" });
  const description = () => field.element() as HTMLTextAreaElement;
  expect(description().value).toBe("");
  await userEvent.fill(field, "Hier beginnt es.\nViel Glück!");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(app.editor?.roomName(1, 43)?.description).toBe("Hier beginnt es.\nViel Glück!");
  // Escape reverts what was typed
  await userEvent.fill(field, "Anders.");
  await userEvent.keyboard("{Escape}");
  expect(description().value).toBe("Hier beginnt es.\nViel Glück!");
  app.undo();
  expect(description().value).toBe("");
  expect(defined(app.editor).isEdited(1, 43)).toBe(false);
  // episode III: its "!" entries; caves show the description of the room above
  app.showEpisode(3, 111);
  expect(description().value).toMatch(/^Du entdeckst ein großes Haus/);
  expect(document.querySelector(".settings-view")?.textContent).toContain(
    "The description of room 11",
  );
  // rooms without a name have none
  app.showEpisode(2, 600);
  expect(description().disabled).toBe(true);
});

test("the script fits into the side column, long lines scroll inside the editor", async () => {
  app.showEpisode(4, 135); // a script with lines longer than the column is wide
  await page.getByRole("tab", { name: "Script" }).click();
  const panel = defined(document.querySelector<HTMLElement>(".side-script") ?? undefined);
  const fits = () => {
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    const right = panel.getBoundingClientRect().right + 0.5;
    for (const child of panel.querySelectorAll<HTMLElement>(".script-view > *"))
      expect(child.getBoundingClientRect().right, child.className).toBeLessThanOrEqual(right);
  };
  fits();
  const scroller = defined(panel.querySelector<HTMLElement>(".cm-scroller") ?? undefined);
  expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  await scriptView().getByRole("button", { name: "Edit" }).click();
  fits();
});
