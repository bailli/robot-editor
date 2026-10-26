import { expect, test } from "vitest";

import { patchChildren } from "../src/patch.ts";

function select(values: string[], value: string): HTMLSelectElement {
  const element = document.createElement("select");
  for (const v of values) element.append(new Option(v, v));
  element.value = value;
  return element;
}

test("a patched select shows the new value, also on an option it gains", () => {
  const parent = document.createElement("div");
  parent.append(select(["0", "1"], "1"));
  const kept = parent.firstChild;
  patchChildren(parent, [select(["0", "1", "3"], "3")]);
  expect(parent.firstChild).toBe(kept);
  expect((kept as HTMLSelectElement).value).toBe("3");
  patchChildren(parent, [select(["0", "1"], "0")]);
  expect((kept as HTMLSelectElement).value).toBe("0");
});
