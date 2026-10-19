import { expect, test } from "vitest";

import { scriptPlaces } from "../src/app.ts";
import { type ScriptViewEvents, markUp } from "../src/script-view.ts";

const events: ScriptViewEvents = {
  explain: (name) => (name === "Message" ? "Message(text, time)" : undefined),
  argument: (fn, index, args) => `${fn} ${index} ${args.map(String).join(" ")}`,
  compile: () => "",
  apply: () => undefined,
  hover: () => undefined,
};

test("markUp names what each piece is and explains whole number arguments", () => {
  const shown = markUp("if (NewRoom) Message(700, t + 1); /* hi */ n = -2;", events);
  const by = (text: string) => shown.find((s) => s.piece.text === text);
  expect(by("if")?.className).toBe("statement");
  expect(by("NewRoom")?.className).toBe("variable");
  expect(by("Message")).toMatchObject({ className: "function", title: "Message(text, time)" });
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
