import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import { sha256 } from "../src/sha256.ts";
import { exe } from "./data.ts";

test("sha256 agrees with node:crypto, also at the padding's block boundaries", () => {
  const inputs = [0, 3, 55, 56, 63, 64, 119, 1000].map((n) =>
    Uint8Array.from({ length: n }, (_, i) => (i * 31) & 0xff),
  );
  for (const data of [...inputs, exe()]) {
    expect(sha256(data)).toBe(createHash("sha256").update(data).digest("hex"));
  }
});
