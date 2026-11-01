import { describe, expect, it } from "vitest";
import { CSWAP_VERSION, cswapExecutable, cswapWrapper, privateCswap } from "../../src/upstream/cswap-runtime.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("cswap runtime", () => {
  it("prefers the override, then the private copy, then PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "cswap-rt-"));
    expect(cswapExecutable({ HOME: home })).toBe("cswap");
    mkdirSync(dirname(privateCswap({ HOME: home })), { recursive: true });
    writeFileSync(privateCswap({ HOME: home }), "#!/bin/sh\n");
    expect(cswapExecutable({ HOME: home })).toBe(privateCswap({ HOME: home }));
    expect(cswapExecutable({ HOME: home, BRIDGE_CSWAP_EXECUTABLE: "/x/fake" })).toBe("/x/fake");
  });

  it("starts the pinned copy with the update check switched off", () => {
    const script = cswapWrapper("/a b/venv/bin/python");
    expect(script).toContain("'/a b/venv/bin/python'");
    expect(script).toContain("check_for_update = lambda");
    expect(script).toContain('"$@"');
    expect(CSWAP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
