import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("skill prompt injection removal", () => {
  it("keeps loop-scoped skill fragments request-local instead of registering global sources", () => {
    const source = readFileSync(new URL("../src/services/agent/loop.ts", import.meta.url), "utf8");

    expect(source).not.toContain("__skill_effects_");
    expect(source).not.toContain("__loop_skill_catalog_");
    expect(source).not.toContain("registerPromptFragmentSource(");
    expect(source).toContain("buildRoundPromptFragments(");
    expect(source).toContain("renderSystemPrompt(");
  });
});
