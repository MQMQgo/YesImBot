import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Service } from "koishi";

import { JsonDB } from "../../utils";
import type { CacheEntry, ImageCacheCleanupResult, ImageCacheConfig, ImageMetadata } from "./types";
import { extFromMediaType, mediaTypeFromUrl } from "./types";

declare module "koishi" {
  interface Context {
    "yesimbot.image-cache": ImageCacheService;
  }
}

const SAFE_CACHE_ID_RE = /^[a-f0-9]{16}$/i;
const SAFE_CACHE_EXT_RE = /^(jpg|png|gif|webp)$/i;

export class ImageCacheService extends Service<ImageCacheConfig> {
  private index = new Map<string, ImageMetadata>();
  private urlIndex = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();
  private db!: JsonDB<Record<string, ImageMetadata>>;
  private cacheDir: string;
  private imagesDir: string;
  private flushTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(ctx: Context, config?: Partial<ImageCacheConfig>) {
    super(ctx, "yesimbot.image-cache", false);
    this.logger = ctx.logger("yesimbot.image-cache");
    this.cacheDir = join(ctx.baseDir, "data", "yesimbot", "cache");
    this.imagesDir = join(this.cacheDir, "images");
    this.config = {
      debugLevel: config?.debugLevel ?? 2,
      autoCleanupEnabled: config?.autoCleanupEnabled ?? true,
      maxCachedImages: config?.maxCachedImages ?? 1000,
      imageTtlMs: config?.imageTtlMs ?? 7 * 24 * 3600 * 1000,
      flushIntervalMs: config?.flushIntervalMs ?? 30_000,
      cleanupIntervalMs: config?.cleanupIntervalMs ?? 3_600_000,
    };
    this.logger.level = this.config.debugLevel ?? 2;

    if (typeof this.ctx.command === "function") {
      const command = this.ctx.command("yesimbot.cache.image", "图片缓存指令集", { authority: 3 });
      command.subcommand(".cleanup", "手动清理图片缓存").action(() => {
        const result = this.cleanupNow("manual");
        return formatCleanupResult(result);
      });
    }
  }

  async start(): Promise<void> {
    // Create cache directories
    await mkdir(this.imagesDir, { recursive: true });

    // Initialize JsonDB
    this.db = new JsonDB(join(this.cacheDir, "metadata.json"), {});

    // Preload index and clean orphans
    const metadata = this.db.getData();
    const orphanIds: string[] = [];

    for (const [id, meta] of Object.entries(metadata)) {
      const normalizedMeta = this.normalizeMetadataEntry(id, meta);
      if (!normalizedMeta) {
        orphanIds.push(id);
        this.logger.warn(`Removed invalid image cache metadata entry: ${id}`);
        continue;
      }

      const filePath = this.resolveImageFilePath(normalizedMeta);
      if (!filePath) {
        orphanIds.push(id);
        this.logger.warn(`Removed unsafe image cache metadata entry: ${id}`);
        continue;
      }
      try {
        await access(filePath);
        this.index.set(id, normalizedMeta);
        this.urlIndex.set(normalizedMeta.url, normalizedMeta.id);
      } catch {
        orphanIds.push(id);
      }
    }

    // Remove orphan metadata
    if (orphanIds.length > 0) {
      this.db.update((data) => {
        for (const id of orphanIds) {
          delete data[id];
        }
      });
      this.db.commit();
      this.logger.info(`Removed ${orphanIds.length} orphan metadata entries`);
    }

    // Start periodic timers
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    const startupLruRemoved = this.evictLRU();
    if (startupLruRemoved > 0) {
      this.flush();
      this.logger.info(`Evicted ${startupLruRemoved} images via startup capacity check`);
    }

    if (this.config.autoCleanupEnabled) {
      this.cleanupTimer = setInterval(
        () => this.cleanupNow("timer"),
        this.config.cleanupIntervalMs,
      );
    } else {
      this.logger.info("Automatic image cache cleanup disabled");
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.flushTimer = undefined;
    this.cleanupTimer = undefined;
    this.flush();
  }

  async get(id: string): Promise<CacheEntry | undefined> {
    const meta = this.index.get(id);
    if (!meta) return undefined;

    const filePath = this.resolveImageFilePath(meta);
    if (!filePath) {
      this.logger.warn(`Unsafe cache entry path for ${id}, removing metadata entry`);
      this.removeEntry(id);
      return undefined;
    }
    try {
      const buffer = await readFile(filePath);

      // Update access tracking immutably
      const updatedMeta: ImageMetadata = {
        ...meta,
        lastAccessedAt: Date.now(),
        accessCount: meta.accessCount + 1,
      };

      this.index.set(id, updatedMeta);
      this.db.set(id, updatedMeta);

      return {
        base64: buffer.toString("base64"),
        mediaType: meta.mediaType,
        status: "ok",
      };
    } catch (error) {
      this.logger.warn(`Failed to read image file ${filePath}, removing entry: ${error}`);
      this.removeEntry(id);
      return undefined;
    }
  }

  getSync(id: string): CacheEntry | undefined {
    const meta = this.index.get(id);
    if (!meta) return undefined;

    const filePath = this.resolveImageFilePath(meta);
    if (!filePath) return undefined;
    try {
      const buffer = readFileSync(filePath);
      return {
        base64: buffer.toString("base64"),
        mediaType: meta.mediaType,
        status: "ok",
      };
    } catch {
      return undefined;
    }
  }

  async download(url: string): Promise<string> {
    // Check if already cached
    const existing = this.urlIndex.get(url);
    if (existing && this.index.has(existing)) {
      return existing;
    }

    // Check if download is in progress
    const inflight = this.pending.get(url);
    if (inflight) {
      return await inflight;
    }

    // Start new download
    const promise = this.doDownload(url);
    this.pending.set(url, promise);

    try {
      return await promise;
    } finally {
      this.pending.delete(url);
    }
  }

  private async doDownload(url: string): Promise<string> {
    try {
      const { buffer, mediaType } = await this.readImageSource(url);

      // Compute content hash
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const contentId = contentHash.slice(0, 16);

      // Check if content already exists (content deduplication)
      if (this.index.has(contentId)) {
        this.urlIndex.set(url, contentId);
        return contentId;
      }

      // Determine media type and extension
      const ext = extFromMediaType(mediaType);

      // Write file to disk
      const filePath = join(this.imagesDir, `${contentId}.${ext}`);
      try {
        await writeFile(filePath, buffer);
      } catch (error) {
        this.logger.warn(`Failed to write image file ${filePath}: ${error}`);
        // Continue anyway - metadata is still valid for retry
      }

      // Create metadata
      const now = Date.now();
      const metadata: ImageMetadata = {
        id: contentId,
        url,
        contentHash,
        mediaType,
        ext,
        size: buffer.byteLength,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };

      // Store in index, urlIndex, and db
      this.index.set(contentId, metadata);
      this.urlIndex.set(url, contentId);
      this.db.set(contentId, metadata);

      // Trigger LRU eviction if over capacity
      this.evictLRU();

      return contentId;
    } catch (error) {
      // Network error - compute URL hash and return (don't persist)
      this.logger.warn(`Failed to download image from ${url}: ${error}`);
      const urlHash = createHash("sha256").update(url).digest("hex").slice(0, 16);
      return urlHash;
    }
  }

  private async readImageSource(url: string): Promise<{ buffer: Buffer; mediaType: string }> {
    if (url.startsWith("data:")) {
      return this.readDataUrl(url);
    }

    if (url.startsWith("file://")) {
      const filePath = fileURLToPath(url);
      const buffer = await readFile(filePath);
      return {
        buffer,
        mediaType: mediaTypeFromUrl(filePath),
      };
    }

    const ab = await this.ctx.http.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
    return {
      buffer: Buffer.from(ab),
      mediaType: mediaTypeFromUrl(url),
    };
  }

  private readDataUrl(url: string): { buffer: Buffer; mediaType: string } {
    const commaIndex = url.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Invalid data URL");
    }

    const header = url.slice(5, commaIndex);
    const payload = url.slice(commaIndex + 1);
    const parts = header.split(";");
    const mediaType = parts[0] || "image/jpeg";
    const isBase64 = parts.some((part) => part.toLowerCase() === "base64");

    return {
      buffer: isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload)),
      mediaType,
    };
  }

  urlToId(url: string): string {
    return this.urlIndex.get(url) ?? createHash("sha256").update(url).digest("hex").slice(0, 16);
  }

  private removeEntry(id: string, reason?: "ttl" | "lru" | "manual"): void {
    const meta = this.index.get(id);
    if (!meta) return;

    // Remove from index and urlIndex
    this.index.delete(id);
    this.urlIndex.delete(meta.url);

    // Remove from db
    this.db.update((data) => {
      delete data[id];
    });

    if (reason && typeof this.ctx.emit === "function") {
      this.ctx.emit("athena:cache.evicted", "image", id, reason);
    }

    // Delete file in background (ignore errors)
    const filePath = this.resolveImageFilePath(meta);
    if (!filePath) return;
    unlink(filePath).catch(() => {});
  }

  private flush(): void {
    try {
      this.db.commit();
    } catch (error) {
      this.logger.warn(`Failed to flush metadata: ${error}`);
    }
  }

  cleanupNow(trigger: "timer" | "manual" = "manual"): ImageCacheCleanupResult {
    const now = Date.now();
    const expiredIds: string[] = [];
    const scanned = this.index.size;

    for (const [id, meta] of this.index.entries()) {
      if (now - meta.createdAt > this.config.imageTtlMs) {
        expiredIds.push(id);
      }
    }

    if (expiredIds.length > 0) {
      for (const id of expiredIds) {
        this.removeEntry(id, "ttl");
      }
    }

    const lruRemoved = this.evictLRU();
    const totalRemoved = expiredIds.length + lruRemoved;
    if (totalRemoved > 0) {
      this.flush();
    }

    const result: ImageCacheCleanupResult = {
      trigger,
      scanned,
      expiredRemoved: expiredIds.length,
      lruRemoved,
      totalRemoved,
      remaining: this.index.size,
    };

    if (totalRemoved > 0 || trigger === "manual") {
      this.logger.info(
        `[${trigger}] image cache cleanup scanned=${result.scanned} expired=${result.expiredRemoved} lru=${result.lruRemoved} remaining=${result.remaining}`,
      );
    }

    return result;
  }

  private evictLRU(): number {
    if (this.index.size <= this.config.maxCachedImages) {
      return 0;
    }

    // Sort by lastAccessedAt ascending (oldest first)
    const entries = Array.from(this.index.values()).sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt,
    );

    // Remove oldest entries until we're at capacity
    const toRemove = this.index.size - this.config.maxCachedImages;
    for (let i = 0; i < toRemove; i++) {
      const entry = entries[i];
      if (!entry) break;
      this.removeEntry(entry.id, "lru");
    }

    this.logger.info(`Evicted ${toRemove} images via LRU`);
    return toRemove;
  }

  private normalizeMetadataEntry(id: string, meta: ImageMetadata): ImageMetadata | null {
    if (!SAFE_CACHE_ID_RE.test(id)) return null;
    if (!meta || meta.id !== id) return null;
    if (!SAFE_CACHE_ID_RE.test(meta.id)) return null;
    if (typeof meta.url !== "string" || meta.url.length === 0) return null;
    if (typeof meta.contentHash !== "string" || meta.contentHash.length === 0) return null;
    if (typeof meta.mediaType !== "string" || meta.mediaType.length === 0) return null;
    if (!SAFE_CACHE_EXT_RE.test(meta.ext)) return null;
    if (
      typeof meta.size !== "number" ||
      typeof meta.createdAt !== "number" ||
      typeof meta.lastAccessedAt !== "number" ||
      typeof meta.accessCount !== "number"
    ) {
      return null;
    }

    return meta;
  }

  private resolveImageFilePath(meta: Pick<ImageMetadata, "id" | "ext">): string | null {
    if (!SAFE_CACHE_ID_RE.test(meta.id)) return null;
    if (!SAFE_CACHE_EXT_RE.test(meta.ext)) return null;

    const baseDir = resolve(this.imagesDir);
    const filePath = resolve(baseDir, `${meta.id}.${meta.ext}`);
    if (!filePath.startsWith(`${baseDir}${sep}`)) {
      return null;
    }

    return filePath;
  }
}

function formatCleanupResult(result: ImageCacheCleanupResult): string {
  return [
    "图片缓存清理完成。",
    `触发方式：${result.trigger === "manual" ? "手动" : "定时"}`,
    `扫描条目：${result.scanned}`,
    `TTL 清理：${result.expiredRemoved}`,
    `LRU 淘汰：${result.lruRemoved}`,
    `本次删除：${result.totalRemoved}`,
    `剩余条目：${result.remaining}`,
  ].join("\n");
}
