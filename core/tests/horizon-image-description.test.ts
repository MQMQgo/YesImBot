import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Modality } from "@yesimbot/shared-model";
import type { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageHandler, type BuildContextOptions } from "../src/services/horizon/handlers";
import { ImageDescriber } from "../src/services/horizon/image-describer";
import {
  TimelineEventType,
  TimelinePriority,
  TimelineStage,
  type MessageRecord,
} from "../src/services/horizon/types";

function createMessageRecord(content: string): MessageRecord {
  return {
    id: "msg-1",
    timestamp: new Date("2026-03-15T16:10:00Z"),
    platform: "test",
    channelId: "channel-1",
    type: TimelineEventType.Message,
    priority: TimelinePriority.Normal,
    stage: TimelineStage.Active,
    data: {
      messageId: "native-1",
      senderId: "user-1",
      senderName: "Alice",
      content,
    },
  };
}

describe("horizon image description mode", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps image tags in message text and appends generated descriptions", async () => {
    const handler = new MessageHandler();
    const record = createMessageRecord('look <img id="img-001"/> please');

    const options: BuildContextOptions = {
      channelKey: "test:channel-1",
      imageConfig: {
        imageMode: "description",
        maxImagesInContext: 3,
        imageLifecycleCount: 3,
      },
      parseElements: (text: string) => {
        const matches = [...text.matchAll(/<img\s+id="([^"]+)"\s*\/>/g)];
        return matches.map((match) => ({
          type: "img",
          attrs: { id: match[1] },
          toString: () => match[0],
        }));
      },
      shouldEmbedImage: () => true,
      getImageCache: async (id: string) =>
        id === "img-001"
          ? {
              base64: "aGVsbG8=",
              mediaType: "image/png",
              status: "ok",
            }
          : undefined,
      describeImage: vi.fn(async () => "一只戴着墨镜的猫咪表情包，上面写着“OK”。"),
    };

    const result = await handler.handle(record, options);

    expect(result).toHaveLength(1);
    expect(typeof result[0]?.content).toBe("string");
    const content = String(result[0]?.content ?? "");
    expect(content).toContain('<img id="img-001"/>');
    expect(content).toContain("<image_descriptions>");
    expect(content).toContain('<image id="img-001">');
    expect(content).toContain("一只戴着墨镜的猫咪表情包");
  });

  it("caches generated image descriptions by image and config signature", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "yesimbot-image-description-"));
    tempDirs.push(baseDir);

    const modelCall = vi.fn(async () => ({
      text: "A cat wearing sunglasses with the text OK.",
    }));
    const getModelInfo = vi.fn(() => ({
      id: "vision-model",
      modalities: [Modality.Text, Modality.Image],
    }));

    const ctx = {
      baseDir,
      logger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      })),
      "yesimbot.model": {
        call: modelCall,
        getModelInfo,
      },
    } as unknown as Context;

    const describer = new ImageDescriber(ctx);
    const config = {
      model: "openai:vision-model",
      fallbackChain: ["google:gemini-2.5-flash"],
      detail: "high" as const,
      prompt: "Describe the image.",
      maxOutputTokens: 300,
    };

    const first = await describer.describeImage(
      "img-001",
      { base64: "aGVsbG8=", mediaType: "image/png", status: "ok" },
      config,
    );
    const second = await describer.describeImage(
      "img-001",
      { base64: "aGVsbG8=", mediaType: "image/png", status: "ok" },
      config,
    );

    expect(first).toBe("A cat wearing sunglasses with the text OK.");
    expect(second).toBe(first);
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(getModelInfo).toHaveBeenCalledWith("openai", "vision-model");
  });
});
