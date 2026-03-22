import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", () => {
  class Service {
    ctx: Record<string, unknown>;
    config: unknown;
    logger: Record<string, unknown>;

    constructor(ctx: Record<string, unknown>, _name: string, _immediate?: boolean) {
      this.ctx = ctx;
      this.config = {};
      this.logger = (ctx.logger as (name: string) => Record<string, unknown>)("mock-agent");
    }
  }

  return {
    Context: class {},
    Service,
    Random: { id: () => "mock-rand" },
  };
});

vi.mock("../src/services/agent/loop", () => ({
  ThinkActLoop: class ThinkActLoop {
    run = vi.fn().mockResolvedValue({ totalTokens: 0, totalToolCalls: 0 });
  },
}));

vi.mock("../src/services/agent/willingness", () => ({
  TokenBucket: class TokenBucket {
    consume() {
      return true;
    }
  },
  WillingnessEngine: class WillingnessEngine {
    tick() {}
    processMessage() {
      return {
        probability: 1,
        shouldReply: true,
        debug: {
          prevWillingness: 0,
          newWillingness: 1,
          gain: 1,
          keywordHit: false,
          fatigue: 1,
          triggerType: "mention",
        },
      };
    }
    recordBotReply() {}
  },
  WillingnessSchema: {},
}));

import { AgentCore } from "../src/services/agent/service";

type TimerRecord = {
  callback: () => void;
  canceled: boolean;
  delay: number;
};

function createMockContext() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const timers: TimerRecord[] = [];

  const ctx: Record<string, unknown> = {
    logger: vi.fn(() => ({
      level: 2,
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    command: vi.fn(() => ({})),
    setInterval: vi.fn(() => vi.fn()),
    setTimeout: vi.fn((callback: () => void, delay: number) => {
      const timer: TimerRecord = { callback, canceled: false, delay };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    bots: [],
  };

  return { ctx, handlers, timers };
}

function createMessageEvent(messageId: string) {
  return {
    platform: "discord",
    channelId: "channel-1",
    timestamp: new Date("2026-03-22T00:00:00Z"),
    triggerType: "mention" as const,
    payload: {
      messageId,
      senderId: "user-1",
      senderName: "Alice",
      content: "hello bot",
    },
    runtime: {
      session: {
        isDirect: false,
      },
    },
  };
}

describe("AgentCore inbound message dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores duplicate horizon/message events for the same channel messageId", async () => {
    const { ctx, handlers, timers } = createMockContext();
    const service = new AgentCore(ctx as never, { aggregationWindow: 10 });
    const enqueueSpy = vi.spyOn(service as never, "enqueue").mockImplementation(() => undefined);

    await (service as never).start();

    const handler = handlers.get("horizon/message");
    expect(handler).toBeTypeOf("function");

    const event = createMessageEvent("m-1");
    handler?.(event);
    handler?.(event);

    expect(ctx.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);

    timers[0]?.callback();

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      "discord:channel-1",
      expect.objectContaining({
        percept: expect.objectContaining({
          metadata: expect.objectContaining({ messageId: "m-1" }),
        }),
      }),
    );
  });

  it("still processes different messageIds independently", async () => {
    const { ctx, handlers, timers } = createMockContext();
    const service = new AgentCore(ctx as never, { aggregationWindow: 10 });

    await (service as never).start();

    const handler = handlers.get("horizon/message");
    expect(handler).toBeTypeOf("function");

    handler?.(createMessageEvent("m-1"));
    handler?.(createMessageEvent("m-2"));

    expect(ctx.setTimeout).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(2);
    expect(timers[0]?.canceled).toBe(true);
    expect(timers[1]?.canceled).toBe(false);
  });
});
