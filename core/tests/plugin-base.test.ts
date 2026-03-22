import type { Context } from "koishi";
import { describe, expect, it, vi } from "vitest";

import type { HookService } from "../src/services/hook/service";
import { YesImPlugin } from "../src/services/plugin/plugin";

class MinimalPlugin extends YesImPlugin {
  static inject = ["yesimbot.plugin"];
}

describe("YesImPlugin", () => {
  it("uses ctx.get() to read optional hook service without direct property access", async () => {
    let readyHandler: (() => Promise<void>) | undefined;
    const directHookGetter = vi.fn(() => undefined);

    const hookService = {
      registerFromDecorators: vi.fn(),
    } as unknown as HookService;

    const ctx = {
      get: vi.fn((name: string) => {
        if (name === "yesimbot.hook") return hookService;
        return undefined;
      }),
      on: vi.fn((event: string, listener: () => Promise<void>) => {
        if (event === "ready") {
          readyHandler = listener;
        }
        return () => true;
      }),
      "yesimbot.plugin": {
        registerPlugin: vi.fn(),
        unregisterPlugin: vi.fn(),
      },
    } as unknown as Context;

    Object.defineProperty(ctx, "yesimbot.hook", {
      configurable: true,
      get: directHookGetter,
    });

    const plugin = new MinimalPlugin(ctx);
    await readyHandler?.();

    expect(ctx.get).toHaveBeenCalledWith("yesimbot.hook");
    expect(hookService.registerFromDecorators).toHaveBeenCalledTimes(1);
    expect((hookService.registerFromDecorators as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      ctx,
    );
    expect((hookService.registerFromDecorators as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe(
      plugin,
    );
    expect(ctx["yesimbot.plugin"].registerPlugin).toHaveBeenCalledTimes(1);
    expect(ctx["yesimbot.plugin"].registerPlugin.mock.calls[0]?.[0]).toBe(plugin);
    expect(directHookGetter).not.toHaveBeenCalled();
  });
});
