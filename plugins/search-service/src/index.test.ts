import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", () => {
  const createSchemaChain = () => {
    const chain = {
      default: vi.fn(() => chain),
      required: vi.fn(() => chain),
      description: vi.fn(() => chain),
      role: vi.fn(() => chain),
      hidden: vi.fn(() => chain),
      i18n: vi.fn(() => chain),
    };
    return chain;
  };

  return {
    Context: class {},
    Schema: {
      object: vi.fn(() => createSchemaChain()),
      string: vi.fn(() => createSchemaChain()),
      number: vi.fn(() => createSchemaChain()),
    },
  };
});

vi.mock("koishi-plugin-yesimbot/services/plugin", () => {
  const FunctionType = {
    Tool: "tool",
    Action: "action",
  };

  class YesImPlugin {
    ctx: Record<string, unknown>;
    tools = new Map<string, Record<string, unknown>>();

    constructor(ctx: Record<string, unknown>) {
      this.ctx = ctx;
      const proto = Object.getPrototypeOf(this) as Record<string, unknown>;
      for (const entry of (proto.__staticTools as Array<Record<string, unknown>> | undefined) ??
        []) {
        const methodKey = entry.methodKey as string;
        const handler = (this as Record<string, unknown>)[methodKey] as (
          ...args: unknown[]
        ) => unknown;
        this.tools.set(entry.name as string, {
          ...entry,
          type: entry.type ?? FunctionType.Tool,
          handler: handler.bind(this),
        });
      }
    }

    getFunctions(): Map<string, Record<string, unknown>> {
      return new Map(this.tools);
    }

    registerTool(def: Record<string, unknown>): void {
      this.tools.set(def.name as string, def);
    }
  }

  return {
    Failed: (message: string) => ({ success: false, status: "failed", error: message }),
    FunctionType,
    Metadata:
      (meta: Record<string, unknown>) => (target: { prototype: Record<string, unknown> }) => {
        target.prototype.__pluginMetadata = meta;
      },
    Success: (content?: unknown) => ({ success: true, status: "success", content }),
    Tool:
      (opts: Record<string, unknown>) =>
      (target: Record<string, unknown>, propertyKey: string | symbol) => {
        if (!target.__staticTools) target.__staticTools = [];
        (target.__staticTools as Array<Record<string, unknown>>).push({
          ...opts,
          type: FunctionType.Tool,
          methodKey: String(propertyKey),
        });
      },
    withInnerThoughts: (params: Record<string, unknown>) => params,
    YesImPlugin,
  };
});

vi.mock("koishi-plugin-yesimbot/services/skill", () => ({
  loadSkillsFromDir: vi.fn(() => [{ name: "search" }]),
}));

import SearchPlugin from "./index";

interface MockContext {
  on: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof vi.fn>;
  http: ReturnType<typeof vi.fn>;
  baseDir: string;
  "yesimbot.plugin": {
    registerPlugin: ReturnType<typeof vi.fn>;
    unregisterPlugin: ReturnType<typeof vi.fn>;
  };
  "yesimbot.skill": {
    register: ReturnType<typeof vi.fn>;
  };
  "yesimbot.hook": {
    register: ReturnType<typeof vi.fn>;
  };
}

function createMockContext(): MockContext {
  return {
    on: vi.fn(),
    logger: vi.fn(() => ({
      level: 2,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    })),
    http: vi.fn(),
    baseDir: "D:/tmp",
    "yesimbot.plugin": {
      registerPlugin: vi.fn(),
      unregisterPlugin: vi.fn(),
    },
    "yesimbot.skill": {
      register: vi.fn(() => vi.fn()),
    },
    "yesimbot.hook": {
      register: vi.fn(() => vi.fn()),
    },
  };
}

describe("search-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the hidden search skill through the agent-start hook", async () => {
    const ctx = createMockContext();
    const plugin = new SearchPlugin(ctx as never, {
      provider: "tavily",
      apiKey: "test-key",
      jinaApiKey: "jina-key",
    });

    await (plugin as unknown as { start: () => Promise<void> }).start();

    expect(ctx["yesimbot.hook"].register).toHaveBeenCalledTimes(1);
    const registration = ctx["yesimbot.hook"].register.mock.calls[0]?.[1] as {
      handler: (ctx: {
        params: {
          traits?: Array<{ dimension: string; value: string; metadata?: Record<string, unknown> }>;
          loadSkill?: (skillName: string) => Promise<unknown>;
          getLoadedSkills?: () => Array<{ name: string }>;
        };
      }) => Promise<void>;
    };

    const loadSkill = vi.fn(async () => ({ status: "loaded" }));
    await registration.handler({
      params: {
        traits: [
          {
            dimension: "scene",
            value: "group-chat",
            metadata: { triggerContent: "Please look up the current Bitcoin price." },
          },
        ],
        loadSkill,
        getLoadedSkills: () => [],
      },
    });

    expect(loadSkill).toHaveBeenCalledWith("search");
  });

  it("does not auto-load the search skill for casual chat", async () => {
    const ctx = createMockContext();
    const plugin = new SearchPlugin(ctx as never, {
      provider: "tavily",
      apiKey: "test-key",
      jinaApiKey: "jina-key",
    });

    await (plugin as unknown as { start: () => Promise<void> }).start();

    const registration = ctx["yesimbot.hook"].register.mock.calls[0]?.[1] as {
      handler: (ctx: {
        params: {
          traits?: Array<{ dimension: string; value: string; metadata?: Record<string, unknown> }>;
          loadSkill?: (skillName: string) => Promise<unknown>;
          getLoadedSkills?: () => Array<{ name: string }>;
        };
      }) => Promise<void>;
    };

    const loadSkill = vi.fn(async () => ({ status: "loaded" }));
    await registration.handler({
      params: {
        traits: [
          {
            dimension: "scene",
            value: "group-chat",
            metadata: { triggerContent: "hello there" },
          },
        ],
        loadSkill,
        getLoadedSkills: () => [],
      },
    });

    expect(loadSkill).not.toHaveBeenCalled();
  });

  it("fetch uses the full HTTP response object and validates URLs", async () => {
    const ctx = createMockContext();
    ctx.http.mockResolvedValue({
      status: 200,
      statusText: "OK",
      data: "parsed page content",
    });

    const plugin = new SearchPlugin(ctx as never, {
      provider: "tavily",
      apiKey: "test-key",
      jinaApiKey: "jina-key",
    });

    const fetchTool = plugin.getFunctions().get("fetch") as
      | {
          handler: (
            params: Record<string, unknown>,
            ctx: unknown,
          ) => Promise<Record<string, unknown>>;
        }
      | undefined;

    expect(fetchTool).toBeDefined();

    const success = await fetchTool!.handler({ url: "https://example.com" }, {});
    expect(success).toEqual({
      success: true,
      status: "success",
      content: "parsed page content",
    });
    expect(ctx.http).toHaveBeenCalledWith(
      `https://r.jina.ai/${encodeURIComponent("https://example.com/")}`,
      expect.objectContaining({
        responseType: "text",
        timeout: 15000,
      }),
    );

    const failed = await fetchTool!.handler({ url: "javascript:alert(1)" }, {});
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/valid http\/https url/i);
  });
});
