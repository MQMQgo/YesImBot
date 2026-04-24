import { createHash } from "node:crypto";
import { join } from "node:path";

import { Modality, parseModelId } from "@yesimbot/shared-model";
import type { ImagePart } from "ai";
import { Context } from "koishi";

import { JsonDB } from "../../utils";
import type { CacheEntry } from "../image-cache/types";
import type { ModelService } from "../model/service";
import type { ImageDescriptionConfig } from "./types";
import {
  DEFAULT_IMAGE_DESCRIPTION_DETAIL,
  DEFAULT_IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
  DEFAULT_IMAGE_DESCRIPTION_PROMPT,
} from "./types";

interface ImageDescriptionRecord {
  key: string;
  imageId: string;
  model: string;
  text: string;
  updatedAt: number;
}

type ImageDescriptionStore = Record<string, ImageDescriptionRecord>;

interface ResolvedImageDescriptionConfig {
  model: string;
  fallbackChain: string[];
  detail: NonNullable<ImageDescriptionConfig["detail"]>;
  prompt: string;
  maxOutputTokens: number;
}

export class ImageDescriber {
  private readonly logger;
  private readonly db: JsonDB<ImageDescriptionStore>;
  private readonly cache = new Map<string, ImageDescriptionRecord>();
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private readonly warnedUnsupportedModels = new Set<string>();

  constructor(private readonly ctx: Context) {
    this.logger = ctx.logger("horizon.image-description");
    this.db = new JsonDB<ImageDescriptionStore>(
      join(ctx.baseDir, "data", "yesimbot", "cache", "image-descriptions.json"),
      {},
    );

    for (const [key, record] of Object.entries(this.db.getData())) {
      if (!record || typeof record.text !== "string" || !record.text.trim()) {
        continue;
      }
      this.cache.set(key, record);
    }
  }

  async describeImage(
    imageId: string,
    image: CacheEntry | undefined,
    config?: ImageDescriptionConfig,
  ): Promise<string | undefined> {
    const normalized = this.normalizeConfig(config);
    if (!normalized.model || !image || image.status === "failed") {
      return undefined;
    }

    const cacheKey = this.createCacheKey(imageId, normalized);
    const cached = this.cache.get(cacheKey);
    if (cached?.text) {
      return cached.text;
    }

    const inflight = this.pending.get(cacheKey);
    if (inflight) {
      return await inflight;
    }

    const task = this.describeAndCache(cacheKey, imageId, image, normalized);
    this.pending.set(cacheKey, task);

    try {
      return await task;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  private normalizeConfig(
    config?: ImageDescriptionConfig,
  ): ResolvedImageDescriptionConfig {
    return {
      model: config?.model?.trim() ?? "",
      fallbackChain: config?.fallbackChain ?? [],
      detail: config?.detail ?? DEFAULT_IMAGE_DESCRIPTION_DETAIL,
      prompt: config?.prompt?.trim() || DEFAULT_IMAGE_DESCRIPTION_PROMPT,
      maxOutputTokens:
        config?.maxOutputTokens ?? DEFAULT_IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
    };
  }

  private createCacheKey(
    imageId: string,
    config: ResolvedImageDescriptionConfig,
  ): string {
    const signature = createHash("sha1")
      .update(
        JSON.stringify({
          model: config.model,
          fallbackChain: config.fallbackChain,
          detail: config.detail,
          prompt: config.prompt,
          maxOutputTokens: config.maxOutputTokens,
        }),
      )
      .digest("hex")
      .slice(0, 16);

    return `${imageId}:${signature}`;
  }

  private async describeAndCache(
    cacheKey: string,
    imageId: string,
    image: CacheEntry,
    config: ResolvedImageDescriptionConfig,
  ): Promise<string | undefined> {
    const modelService = this.ctx["yesimbot.model"] as ModelService | undefined;
    if (!modelService) {
      return undefined;
    }

    if (!this.supportsImages(modelService, config.model)) {
      if (!this.warnedUnsupportedModels.has(config.model)) {
        this.warnedUnsupportedModels.add(config.model);
        this.logger.warn(
          `Image description model does not advertise image support: ${config.model}`,
        );
      }
      return undefined;
    }

    const imagePart: ImagePart = {
      type: "image",
      image: image.base64,
      mediaType: image.mediaType,
      providerOptions: {
        openai: {
          imageDetail: config.detail,
        },
      },
    };

    try {
      const result = await modelService.call(
        config.model,
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: config.prompt },
                imagePart,
              ],
            },
          ],
          temperature: 0.2,
          maxOutputTokens: config.maxOutputTokens,
        },
        config.fallbackChain,
      );

      const text = normalizeDescriptionText(result?.text ?? "");
      if (!text) {
        return undefined;
      }

      const record: ImageDescriptionRecord = {
        key: cacheKey,
        imageId,
        model: config.model,
        text,
        updatedAt: Date.now(),
      };

      this.cache.set(cacheKey, record);
      this.db.set(cacheKey, record).commit();
      return text;
    } catch (err: unknown) {
      this.logger.warn(
        `Image description failed for ${imageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private supportsImages(modelService: ModelService, model: string): boolean {
    const parsed = parseModelId(model);
    if (!parsed) {
      return true;
    }

    const modelInfo = modelService.getModelInfo(parsed.provider, parsed.model);
    if (!modelInfo?.modalities?.length) {
      return true;
    }

    return modelInfo.modalities.includes(Modality.Image);
  }
}

function normalizeDescriptionText(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
