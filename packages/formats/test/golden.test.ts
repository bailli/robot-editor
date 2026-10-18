import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";

import { ROOT, sha256 } from "./data.ts";

test("golden/ matches the committed golden.sha256", () => {
  // golden.sha256 is committed: when the reference output of the Python tools changes,
  // the change is visible in review even if the TypeScript code changed in step.
  const hint = "run `pnpm golden` and review the diff of golden.sha256";
  const listed = new Map(
    readFileSync(new URL("golden.sha256", ROOT), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash = "", path = ""] = line.split(/\s+/);
        return [path, hash] as const;
      }),
  );
  const dir = new URL("golden/", ROOT);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(new URL(f, dir)).isFile())
    .map((f) => `golden/${f}`)
    .sort();
  assert.deepEqual(
    files,
    [...listed.keys()].sort(),
    `golden/ has other files than listed: ${hint}`,
  );
  for (const path of files) {
    assert.equal(sha256(readFileSync(new URL(path, ROOT))), listed.get(path), `${path}: ${hint}`);
  }
});
