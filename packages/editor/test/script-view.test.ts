import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";

import { scriptPlaces } from "../src/app.ts";
import { type ScriptViewEvents, markUp, scriptCompletions } from "../src/script-view.ts";

const events: ScriptViewEvents = {
  explain: (name) => (name === "Message" ? "Message(text, delay)" : undefined),
  argument: (fn, index, args) => `${fn} ${index} ${args.map(String).join(" ")}`,
  compile: () => "",
  apply: () => undefined,
  hover: () => undefined,
  names: () => [
    { name: "Message", kind: "function", args: ["text", "delay"] },
    { name: "Area", kind: "function", args: ["x", "y", "size"] },
    { name: "Area", kind: "function", args: ["x", "y", "w", "h"] },
    { name: "NewRoom", kind: "variable" },
    { name: "O_KEY", kind: "constant" },
  ],
};

test("markUp names what each piece is and explains whole number arguments", () => {
  const shown = markUp("if (NewRoom) Message(700, t + 1); /* hi */ n = -2;", events);
  const by = (text: string) => shown.find((s) => s.piece.text === text);
  expect(by("if")?.className).toBe("statement");
  expect(by("NewRoom")?.className).toBe("variable");
  expect(by("Message")).toMatchObject({ className: "function", title: "Message(text, delay)" });
  expect(by("Message")?.call).toEqual({ fn: "Message", args: [700, undefined] });
  expect(by("t")?.className).toBe("local");
  // the call's other arguments come along (undefined where not a plain number)
  expect(by("700")?.title).toBe("Message 0 700 undefined");
  // part of an expression: not explained
  expect(by("1")?.title).toBeUndefined();
  expect(by("/* hi */")?.className).toBe("comment");
  expect(shown.map((s) => s.piece.text).join("")).toBe(
    "if (NewRoom) Message(700, t + 1); /* hi */ n = -2;",
  );
});

test("calls with plain numbers name places in the room", () => {
  expect(scriptPlaces("SetWarea", [4, 13, 2, 1])).toEqual([{ x: 4, y: 13, w: 2, h: 1 }]);
  expect(scriptPlaces("SetObj", [21, 5, 3, 0])).toEqual([{ x: 5, y: 3, w: 1, h: 1 }]);
  expect(scriptPlaces("Area", [11, 6, 19])).toEqual([{ x: 11, y: 6, w: 19, h: 19 }]);
  // a variable coordinate: no place
  expect(scriptPlaces("SetObj", [21, undefined, 3, 0])).toEqual([]);
  expect(scriptPlaces("Message", [700, 25])).toEqual([]);
});

test("completion offers the game's names and the script's own variables", async () => {
  const complete = async (source: string, explicit = false) => {
    const state = EditorState.create({ doc: source });
    const context = new CompletionContext(state, source.length, explicit);
    return await scriptCompletions(events)(context);
  };
  const result = await complete("count = 1;\nif (NewRoom) Mes");
  expect(result?.from).toBe(24);
  const labels = result?.options.map((o) => `${o.label} ${o.type ?? ""} ${o.detail ?? ""}`);
  expect(labels).toEqual(
    expect.arrayContaining([
      "if keyword ",
      "Message function (text, delay)",
      // one option per form
      "Area function (x, y, size)",
      "Area function (x, y, w, h)",
      "NewRoom variable ",
      "O_KEY constant ",
      "count variable of this script",
    ]),
  );
  // the word being typed is not a variable of the script
  expect(labels).not.toContain("Mes variable of this script");
  // nothing in comments and strings, nothing without a word unless asked for
  expect(await complete("// Mes")).toBeNull();
  expect(await complete('Message("Mes')).toBeNull();
  expect(await complete("x = ")).toBeNull();
  expect((await complete("x = ", true))?.from).toBe(4);
});
