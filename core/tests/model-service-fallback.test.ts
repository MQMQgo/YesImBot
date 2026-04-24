import type { IModelProvider, ModelInfo } from "@yesimbot/shared-model";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  extractReasoningMiddleware: vi.fn(() => ({})),
  generateText: vi.fn(),
  streamText: vi.fn(),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
}));

vi.mock("ai", () => ({
  extractReasoningMiddleware: mocks.extractReasoningMiddleware,
  generateText: mocks.generateText,
  streamText: mocks.streamText,
  wrapLanguageModel: mocks.wrapLanguageModel,
}));

vi.mock("koishi", () => {
  function createSchemaChain() {
    return {
      default() {
        return this;
      },
      description() {
        return this;
      },
    };
  }

  class Context {}

  class Service {
    ctx: Record<string, unknown>;
    config: unknown;
    logger: Record<string, unknown>;

    constructor(ctx: Record<string, unknown>, _name: string, _immediate?: boolean) {
      this.ctx = ctx;
      this.config = {};
      this.logger = (ctx.logger as (name: string) => Record<string, unknown>)("mock");
    }
  }

  return {
    Context,
    Service,
    Schema: {
      const: () => createSchemaChain(),
      string: () => createSchemaChain(),
      union: () => createSchemaChain(),
    },
  };
});

import type { CallParams } from "../src/services/model/service";
import { ModelService } from "../src/services/model/service";

function createContext() {
  const logger = {
    level: 2,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const commandChain = {
    subcommand: vi.fn(() => commandChain),
    action: vi.fn(() => commandChain),
  };

  return {
    ctx: {
      logger: vi.fn(() => logger),
      command: vi.fn(() => commandChain),
      schema: {
        set: vi.fn(),
      },
    },
    logger,
  };
}

function createProvider(id: string, modelIds: string[]): IModelProvider {
  const models: ModelInfo[] = modelIds.map((modelId) => ({ id: modelId }));
  return {
    id,
    providerType: "test",
    models,
    listModels: () => Object.fromEntries(models.map((model) => [model.id, model])),
    getModel: (modelId: string) => ({ providerId: id, modelId }),
    getDefaultParams: () => ({}),
  };
}

function setProviders(service: ModelService, providers: Map<string, IModelProvider>) {
  (service as unknown as { providers: Map<string, IModelProvider> }).providers = providers;
}

function createParams(): CallParams {
  return {
    messages: [{ role: "user", content: "hello" }],
  } as CallParams;
}

describe("ModelService fallback chain", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
    mocks.streamText.mockReset();
    mocks.wrapLanguageModel.mockClear();
    mocks.extractReasoningMiddleware.mockClear();
  });

  it("falls back when the primary model identifier is invalid", async () => {
    const { ctx } = createContext();
    const service = new ModelService(ctx as never, { concurrency: 1 });
    setProviders(service, new Map([["backup", createProvider("backup", ["secondary"])]]));

    mocks.generateText.mockResolvedValue({
      text: "fallback-ok",
      usage: { totalTokens: 0 },
    });

    const result = await service.call("broken-model-id", createParams(), ["backup:secondary"]);

    expect(result?.text).toBe("fallback-ok");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(mocks.generateText.mock.calls[0]?.[0]?.model).toMatchObject({
      providerId: "backup",
      modelId: "secondary",
    });
  });

  it("falls back even when the primary model fails with a permanent error", async () => {
    const { ctx } = createContext();
    const service = new ModelService(ctx as never, { concurrency: 1 });
    setProviders(
      service,
      new Map([
        ["primary", createProvider("primary", ["main"])],
        ["backup", createProvider("backup", ["secondary"])],
      ]),
    );

    mocks.generateText.mockImplementation(async ({ model }: { model: { providerId: string } }) => {
      if (model.providerId === "primary") {
        const error = new Error("400 Bad Request") as Error & { status?: number };
        error.status = 400;
        throw error;
      }
      return {
        text: "fallback-ok",
        usage: { totalTokens: 0 },
      };
    });

    const result = await service.call("primary:main", createParams(), ["backup:secondary"]);

    expect(result?.text).toBe("fallback-ok");
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateText.mock.calls[1]?.[0]?.model).toMatchObject({
      providerId: "backup",
      modelId: "secondary",
    });
  });

  it("retries transient errors on fallback candidates before giving up", async () => {
    const { ctx } = createContext();
    const service = new ModelService(ctx as never, { concurrency: 1 });
    setProviders(
      service,
      new Map([
        ["primary", createProvider("primary", ["main"])],
        ["backup", createProvider("backup", ["secondary"])],
      ]),
    );

    let backupAttempts = 0;
    mocks.generateText.mockImplementation(async ({ model }: { model: { providerId: string } }) => {
      if (model.providerId === "primary") {
        const error = new Error("400 Bad Request") as Error & { status?: number };
        error.status = 400;
        throw error;
      }

      backupAttempts += 1;
      if (backupAttempts === 1) {
        const error = new Error("503 Service Unavailable") as Error & { status?: number };
        error.status = 503;
        throw error;
      }

      return {
        text: "fallback-after-retry",
        usage: { totalTokens: 0 },
      };
    });

    const result = await service.call("primary:main", createParams(), ["backup:secondary"]);

    expect(result?.text).toBe("fallback-after-retry");
    expect(backupAttempts).toBe(2);
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
  });

  it("applies the same fallback behavior to stream calls", async () => {
    const { ctx } = createContext();
    const service = new ModelService(ctx as never, { concurrency: 1 });
    setProviders(service, new Map([["backup", createProvider("backup", ["secondary"])]]));

    const streamResult = {
      textStream: [],
      usage: Promise.resolve({ totalTokens: 0 }),
    };
    mocks.streamText.mockResolvedValue(streamResult);

    const result = await service.streamCall(
      "broken-model-id",
      createParams(),
      ["backup:secondary"],
    );

    expect(result).toBe(streamResult);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(mocks.streamText.mock.calls[0]?.[0]?.model).toMatchObject({
      providerId: "backup",
      modelId: "secondary",
    });
  });
});
