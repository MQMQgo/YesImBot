import type { Context } from "koishi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HorizonView } from "../../core/src/services/horizon/types";
import type { ToolExecutionContext } from "../../core/src/services/plugin/types";
import type { Percept } from "../../core/src/services/runtime/contracts";
import {
  buildAgentContext,
  buildAgentRoundContext,
} from "../../core/src/services/shared/context-factory";

function createPercept(overrides: Partial<Percept> = {}): Percept {
  return {
    id: overrides.id ?? "percept-001",
    traceId: overrides.traceId ?? "test-trace-001",
    type: overrides.type ?? "direct",
    platform: overrides.platform ?? "test-platform",
    channelId: overrides.channelId ?? "test-channel",
    timestamp: overrides.timestamp ?? new Date("2026-03-14T00:00:00Z"),
    metadata: overrides.metadata,
  };
}

describe("Trait Removal Baseline", () => {
  const view: HorizonView = {
    self: { id: "bot-001", name: "Athena" },
    environment: {
      type: "group",
      id: "test-channel",
      name: "test-channel",
      platform: "test-platform",
      channelId: "test-channel",
    },
    entities: [],
    history: [],
  };

  let warn: ReturnType<typeof vi.fn>;
  let buildView: ReturnType<typeof vi.fn>;
  let ctx: Context;

  beforeEach(() => {
    warn = vi.fn();
    buildView = vi.fn().mockResolvedValue(view);
    ctx = {
      logger: () => ({ warn }),
      "yesimbot.horizon": {
        buildView,
      },
    } as unknown as Context;
  });

  it("builds agent context without TraitAnalyzer registered", async () => {
    const percept = createPercept();

    const toolCtx = await buildAgentContext(ctx, {
      platform: percept.platform,
      channelId: percept.channelId,
      percept,
    });

    expect(toolCtx).toBeDefined();
    expect(toolCtx.platform).toBe("test-platform");
    expect(toolCtx.channelId).toBe("test-channel");
    expect(toolCtx.percept).toBe(percept);
    expect(toolCtx.traits).toEqual([]);
    expect(toolCtx.scenario).toBeDefined();
    expect(buildView).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps legacy traits field as empty array", async () => {
    const percept = createPercept({ id: "percept-002", traceId: "test-trace-002" });

    const toolCtx = await buildAgentContext(ctx, {
      platform: percept.platform,
      channelId: percept.channelId,
      percept,
    });

    expect(Array.isArray(toolCtx.traits)).toBe(true);
    expect(toolCtx.traits).toEqual([]);
    expect(toolCtx.traits).not.toBeUndefined();
  });

  it("builds scenario successfully without trait signals", async () => {
    const percept = createPercept({
      id: "percept-003",
      traceId: "test-trace-003",
      channelId: "test-channel-3",
    });

    const toolCtx = await buildAgentContext(ctx, {
      platform: percept.platform,
      channelId: percept.channelId,
      percept,
    });

    expect(toolCtx.scenario).toBeDefined();
    expect(toolCtx.scenario?.raw.environment.platform).toBe("test-platform");
    expect(toolCtx.scenario?.raw.environment.channelId).toBe("test-channel");
    expect(toolCtx.scenario?.raw.scenarioTimeline).toBeDefined();
    expect(Array.isArray(toolCtx.scenario?.raw.scenarioTimeline.turns)).toBe(true);
  });

  describe("Legacy Compatibility", () => {
    it("preserves traits field for legacy traits.find usage", async () => {
      const percept = createPercept({
        id: "percept-legacy-001",
        traceId: "test-trace-legacy-001",
      });

      const toolCtx = await buildAgentContext(ctx, {
        platform: percept.platform,
        channelId: percept.channelId,
        percept,
      });

      expect(toolCtx.traits).toBeDefined();
      expect(typeof toolCtx.traits?.[Symbol.iterator]).toBe("function");

      const sceneSignal = toolCtx.traits?.find((t) => t.dimension === "scene");
      expect(sceneSignal).toBeUndefined();
    });

    it("normalizes inbound undefined traits to empty array", async () => {
      const percept = createPercept({
        id: "percept-legacy-002",
        traceId: "test-trace-legacy-002",
        channelId: "test-channel-legacy-2",
      });

      const inboundToolCtx = {
        platform: percept.platform,
        channelId: percept.channelId,
        traits: undefined,
      } as ToolExecutionContext;

      const result = await buildAgentRoundContext(ctx, {
        platform: percept.platform,
        channelId: percept.channelId,
        percept,
        toolCtx: inboundToolCtx,
      });

      expect(result.toolCtx.traits).toEqual([]);
      expect(result.toolCtx.traits).not.toBeUndefined();
    });
  });
});
