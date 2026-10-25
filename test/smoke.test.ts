import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("smoke", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("VERSION is a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
