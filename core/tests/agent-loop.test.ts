import { describe, expect, it, vi } from "vitest";

import type { Percept } from "../src/runtime/contracts";
import { ThinkActLoop } from "../src/services/agent/loop";
import { AgentSessionStore } from "../src/services/skill/session-store";
import type { SkillDefinition } from "../src/services/skill/types";

function createPercept(): Percept {
  return {
    id: "wake-1",
    traceId: "trace-1",
    type: "mention",
    platform: "discord",
    channelId: "c1",
    timestamp: new Date("2026-03-14T00:00:00Z"),
    metadata: { messageId: "m1", senderId: "u1" },
  };
}

function createSkillDefinition(name: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    guidance: `guidance for ${name}`,
    allowedTools: ["search"],
    source: "plugin",
    rootDir: `/skills/${name}`,
  };
}

describe("agent loop skill loading", () => {
  it("main loop runs without mandatory TraitAnalyzer stage", async () => {
    const traitAnalyze = vi.fn();
    const ctx = {
      baseDir: "/tmp",
      logger: vi.fn(() => ({
        level: 2,
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      "yesimbot.horizon": {
        buildView: vi.fn().mockResolvedValue({
          self: { id: "bot", name: "Athena" },
          environment: {
            type: "group",
            id: "c1",
            name: "General",
            platform: "discord",
            channelId: "c1",
          },
          entities: [],
          history: [],
        }),
        formatHorizonText: vi.fn().mockResolvedValue([]),
        events: {
          recordAgentResponse: vi.fn(),
          recordAgentAction: vi.fn(),
          recordMessage: vi.fn(),
          markAsActive: vi.fn(),
          archiveStale: vi.fn(),
        },
        compressor: undefined,
        config: { archiveThresholdMs: 86400000 },
      },
      "yesimbot.plugin": {
        getTools: vi.fn(() => []),
        getDefinition: vi.fn(),
        invoke: vi.fn(),
      },
      "yesimbot.prompt": {
        emitPromptBlocks: vi.fn().mockResolvedValue({
          sections: [],
          stableBlock: "",
          dynamicBlock: "",
          stableSignature: "sig",
        }),
        registerFragmentSource: vi.fn(() => () => undefined),
        inject: vi.fn(() => () => undefined),
      },
      "yesimbot.model": {
        getProvider: vi.fn(() => ({ providerType: "openai" })),
        call: vi.fn().mockResolvedValue({ text: JSON.stringify({ actions: [] }), usage: {} }),
      },
      "yesimbot.trait": undefined,
      "yesimbot.skill": {
        get: vi.fn(),
        resolve: vi.fn().mockReturnValue({
          activeSkills: [],
          instructionBlocks: [],
          styleBlock: null,
          toolFilter: { include: [], exclude: [] },
        }),
      },
      "yesimbot.arousal": undefined,
    } as unknown as ConstructorParameters<typeof ThinkActLoop>[0];

    const loop = new ThinkActLoop(ctx, { model: "openai:gpt", fallbackChain: [], maxRounds: 1 });
    await expect(
      loop.run(createPercept(), {
        platform: "discord",
        channelId: "c1",
        session: { isDirect: false, quote: undefined },
        bot: { selfId: "bot-1", user: { name: "Athena" } },
      } as never),
    ).resolves.toEqual({ totalTokens: 0, totalToolCalls: 0 });
    expect(traitAnalyze).not.toHaveBeenCalled();
  });

  it("main loop projects session-loaded skills into committed round skill state", async () => {
    const skill = createSkillDefinition("test-skill");
    const executeAgentEnd = vi.fn();
    const sessionStore = new AgentSessionStore({
      logger: vi.fn(() => ({ info: vi.fn() })),
    } as never);
    sessionStore.loadSkill("discord", "c1", skill);
    const ctx = {
      baseDir: "/tmp",
      logger: vi.fn(() => ({
        level: 2,
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      "yesimbot.horizon": {
        buildView: vi.fn().mockResolvedValue({
          self: { id: "bot", name: "Athena" },
          environment: {
            type: "group",
            id: "c1",
            name: "General",
            platform: "discord",
            channelId: "c1",
          },
          entities: [],
          history: [],
        }),
        formatHorizonText: vi.fn().mockResolvedValue([]),
        events: {
          recordAgentResponse: vi.fn(),
          recordAgentAction: vi.fn(),
          recordMessage: vi.fn(),
          markAsActive: vi.fn(),
          archiveStale: vi.fn(),
        },
        compressor: undefined,
        config: { archiveThresholdMs: 86400000 },
      },
      "yesimbot.plugin": { getTools: vi.fn(() => []), getDefinition: vi.fn(), invoke: vi.fn() },
      "yesimbot.prompt": {
        emitPromptBlocks: vi.fn().mockResolvedValue({
          sections: [],
          stableBlock: "",
          dynamicBlock: "",
          stableSignature: "sig",
        }),
        registerFragmentSource: vi.fn(() => () => undefined),
        inject: vi.fn(() => () => undefined),
      },
      "yesimbot.model": {
        getProvider: vi.fn(() => ({ providerType: "openai" })),
        call: vi.fn().mockResolvedValue({ text: JSON.stringify({ actions: [] }), usage: {} }),
      },
      "yesimbot.trait": { analyze: vi.fn().mockResolvedValue([]) },
      "yesimbot.skill": {
        all: vi.fn(() => [skill]),
        get: vi.fn((name: string) => (name === "test-skill" ? skill : undefined)),
      },
      "yesimbot.hook": {
        executeAgentStart: vi.fn(async (params: Record<string, unknown>) => ({
          skipped: false,
          params,
        })),
        executeAgentEnd,
      },
      "yesimbot.session": sessionStore,
      "yesimbot.arousal": undefined,
    } as unknown as ConstructorParameters<typeof ThinkActLoop>[0];

    const loop = new ThinkActLoop(ctx, { model: "openai:gpt", fallbackChain: [], maxRounds: 1 });
    await loop.run(createPercept(), { platform: "discord", channelId: "c1" } as never);

    const endParams = executeAgentEnd.mock.calls[0]?.[0] as {
      roundContext?: { skillState?: { active?: string[] } };
    };
    expect(endParams.roundContext?.skillState?.active).toContain("test-skill");
  });

  it("reads optional session store via ctx.get without direct property access", async () => {
    const sessionStore = new AgentSessionStore({
      logger: vi.fn(() => ({ info: vi.fn() })),
    } as never);
    const directSessionGetter = vi.fn(() => {
      throw new Error("direct session property access should not be used");
    });

    const ctx = {
      baseDir: "/tmp",
      logger: vi.fn(() => ({
        level: 2,
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      get: vi.fn((name: string) => {
        if (name === "yesimbot.session") return sessionStore;
        return undefined;
      }),
      "yesimbot.horizon": {
        buildView: vi.fn().mockResolvedValue({
          self: { id: "bot", name: "Athena" },
          environment: {
            type: "group",
            id: "c1",
            name: "General",
            platform: "discord",
            channelId: "c1",
          },
          entities: [],
          history: [],
        }),
        formatHorizonText: vi.fn().mockResolvedValue([]),
        events: {
          recordAgentResponse: vi.fn(),
          recordAgentAction: vi.fn(),
          recordMessage: vi.fn(),
          markAsActive: vi.fn(),
          archiveStale: vi.fn(),
        },
        compressor: undefined,
        config: { archiveThresholdMs: 86400000 },
      },
      "yesimbot.plugin": {
        getTools: vi.fn(() => []),
        getDefinition: vi.fn(),
        invoke: vi.fn(),
      },
      "yesimbot.prompt": {
        emitPromptBlocks: vi.fn().mockResolvedValue({
          sections: [],
          stableBlock: "",
          dynamicBlock: "",
          stableSignature: "sig",
        }),
        registerFragmentSource: vi.fn(() => () => undefined),
        inject: vi.fn(() => () => undefined),
      },
      "yesimbot.model": {
        getProvider: vi.fn(() => ({ providerType: "openai" })),
        call: vi.fn().mockResolvedValue({ text: JSON.stringify({ actions: [] }), usage: {} }),
      },
      "yesimbot.trait": { analyze: vi.fn().mockResolvedValue([]) },
      "yesimbot.skill": {
        get: vi.fn(),
        resolve: vi.fn().mockReturnValue({
          activeSkills: [],
          instructionBlocks: [],
          styleBlock: null,
          toolFilter: { include: [], exclude: [] },
        }),
      },
      "yesimbot.arousal": undefined,
    } as unknown as ConstructorParameters<typeof ThinkActLoop>[0];

    Object.defineProperty(ctx, "yesimbot.session", {
      configurable: true,
      get: directSessionGetter,
    });

    const loop = new ThinkActLoop(ctx, { model: "openai:gpt", fallbackChain: [], maxRounds: 1 });
    await expect(
      loop.run(createPercept(), {
        platform: "discord",
        channelId: "c1",
        session: { isDirect: false, quote: undefined },
        bot: { selfId: "bot-1", user: { name: "Athena" } },
      } as never),
    ).resolves.toEqual({ totalTokens: 0, totalToolCalls: 0 });
    expect((ctx.get as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([["yesimbot.session"]]),
    );
    expect(directSessionGetter).not.toHaveBeenCalled();
  });

  it("passes loop skill catalog and tool fragments as request-local prompt fragments", async () => {
    const skill = createSkillDefinition("fragment-skill");
    const registerFragmentSource = vi.fn(() => () => undefined);
    const emitPromptBlocks = vi.fn().mockResolvedValue({
      sections: [],
      stableBlock: "",
      dynamicBlock: "",
      stableSignature: "sig",
    });
    const sessionStore = new AgentSessionStore({
      logger: vi.fn(() => ({ info: vi.fn() })),
    } as never);
    sessionStore.loadSkill("discord", "c1", skill);
    const ctx = {
      baseDir: "/tmp",
      logger: vi.fn(() => ({
        level: 2,
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      "yesimbot.horizon": {
        buildView: vi.fn().mockResolvedValue({
          self: { id: "bot", name: "Athena" },
          environment: {
            type: "group",
            id: "c1",
            name: "General",
            platform: "discord",
            channelId: "c1",
          },
          entities: [],
          history: [],
        }),
        formatHorizonText: vi.fn().mockResolvedValue([]),
        events: {
          recordAgentResponse: vi.fn(),
          recordAgentAction: vi.fn(),
          recordMessage: vi.fn(),
          markAsActive: vi.fn(),
          archiveStale: vi.fn(),
        },
        compressor: undefined,
        config: { archiveThresholdMs: 86400000 },
      },
      "yesimbot.plugin": { getTools: vi.fn(() => []), getDefinition: vi.fn(), invoke: vi.fn() },
      "yesimbot.prompt": {
        emitPromptBlocks,
        registerFragmentSource,
        inject: vi.fn(() => () => undefined),
      },
      "yesimbot.model": {
        getProvider: vi.fn(() => ({ providerType: "openai" })),
        call: vi.fn().mockResolvedValue({ text: JSON.stringify({ actions: [] }), usage: {} }),
      },
      "yesimbot.trait": { analyze: vi.fn().mockResolvedValue([]) },
      "yesimbot.skill": {
        all: vi.fn(() => [skill]),
        get: vi.fn((name: string) => (name === "fragment-skill" ? skill : undefined)),
      },
      "yesimbot.hook": {
        executeAgentStart: vi.fn(async (params: Record<string, unknown>) => ({
          skipped: false,
          params,
        })),
        executeAgentEnd: vi.fn(),
      },
      "yesimbot.session": sessionStore,
      "yesimbot.arousal": undefined,
    } as unknown as ConstructorParameters<typeof ThinkActLoop>[0];

    const loop = new ThinkActLoop(ctx, { model: "openai:gpt", fallbackChain: [], maxRounds: 1 });
    await loop.run(createPercept(), { platform: "discord", channelId: "c1" } as never);

    const promptOptions = emitPromptBlocks.mock.calls[0]?.[2] as
      | { localFragments?: Array<{ id: string; content: string }> }
      | undefined;

    expect(registerFragmentSource).not.toHaveBeenCalled();
    expect(promptOptions?.localFragments?.some((fragment) => fragment.id === "skill.catalog")).toBe(
      true,
    );
    expect(
      promptOptions?.localFragments?.some((fragment) => fragment.id === "tooling.protocol"),
    ).toBe(true);
    expect(
      promptOptions?.localFragments?.some((fragment) => fragment.id === "tooling.available"),
    ).toBe(true);
  });
});
