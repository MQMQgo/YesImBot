import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

const SERVICES_DIR = join(__dirname, "../src/services");

describe("Service module boundaries", () => {
  const topLevelDirs = readdirSync(SERVICES_DIR).filter((entry) =>
    statSync(join(SERVICES_DIR, entry)).isDirectory(),
  );
  const compatibilityDirs = ["runtime", "shared"];

  it("every top-level services/ directory has a service.ts file", () => {
    const missing: string[] = [];
    for (const dir of topLevelDirs) {
      if (compatibilityDirs.includes(dir)) {
        continue;
      }
      const servicePath = join(SERVICES_DIR, dir, "service.ts");
      if (!existsSync(servicePath)) {
        missing.push(dir);
      }
    }
    expect(missing).toEqual([]);
  });

  it("services/ allows only the explicit compatibility bucket directories", () => {
    const bucketNames = ["utils", "helpers", "common", "lib"];
    const found = topLevelDirs.filter((dir) => bucketNames.includes(dir));
    expect(found).toEqual([]);
    expect(topLevelDirs.filter((dir) => compatibilityDirs.includes(dir)).sort()).toEqual(
      compatibilityDirs,
    );
  });

  it("HookType enum includes message hooks alongside tool and agent hooks", async () => {
    const { HookType } = await import("../src/services/hook/types");
    const values = Object.values(HookType);
    expect(values).toContain("tool");
    expect(values).toContain("agent");
    expect(values).toContain("message");
    expect(values).toHaveLength(3);
  });

  it("shared/ and runtime/ exist at core/src/ level", () => {
    const srcDir = join(__dirname, "../src");
    expect(existsSync(join(srcDir, "shared"))).toBe(true);
    expect(existsSync(join(srcDir, "runtime"))).toBe(true);
    expect(existsSync(join(srcDir, "shared/context-factory.ts"))).toBe(true);
    expect(existsSync(join(srcDir, "shared/types.ts"))).toBe(true);
    expect(existsSync(join(srcDir, "runtime/contracts.ts"))).toBe(true);
    expect(existsSync(join(srcDir, "runtime/adapters.ts"))).toBe(true);
  });

  it("AgentCore declares yesimbot.session in static inject", async () => {
    const { AgentCore } = await import("../src/services/agent/service");
    expect(AgentCore.inject).toContain("yesimbot.session");
  });
});
