import { join } from "node:path";

import { Context, Schema } from "koishi";
import {
  Failed,
  FunctionType,
  Metadata,
  Success,
  Tool,
  type ToolResult,
  withInnerThoughts,
  YesImPlugin,
} from "koishi-plugin-yesimbot/services/plugin";
import { loadSkillsFromDir } from "koishi-plugin-yesimbot/services/skill";

import { TavilyBackend } from "./backends/tavily";
import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";
import type { SearchBackend, SearchPluginConfig } from "./types";

const builtinSkillsDir = join(__dirname, "../", "resources/skills");
const SEARCH_SKILL_NAME = "search";
const SEARCH_HINT_PATTERNS = [
  /\b(latest|current|today|news|price|pricing|version|release|docs?|documentation|look up|lookup|search|web|online|verify|fact[- ]?check|recent)\b/i,
  /https?:\/\//i,
  /(?:\u6700\u65b0|\u6700\u8fd1|\u4eca\u5929|\u4eca\u65e5|\u65b0\u95fb|\u67e5\u4e00\u4e0b|\u641c\u4e00\u4e0b|\u641c\u7d22|\u8054\u7f51|\u4e0a\u7f51|\u67e5\u8bc1|\u6838\u5b9e|\u4ef7\u683c|\u6c47\u7387|\u7248\u672c|\u6587\u6863|\u5b98\u7f51)/,
];

interface SearchTraitSignal {
  dimension: string;
  value: string;
  metadata?: Record<string, unknown>;
}

interface SearchSkillHookParams {
  traits?: SearchTraitSignal[];
  loadSkill?: (skillName: string) => Promise<unknown>;
  getLoadedSkills?: () => Array<{ name: string }>;
}

interface SearchHookService {
  register?: (
    ctx: Context,
    def: {
      type: "agent";
      phase: "before";
      metadata?: Record<string, unknown>;
      handler: (ctx: { params: SearchSkillHookParams }) => Promise<void>;
    },
  ) => () => void;
}

function extractTriggerContent(signals: SearchTraitSignal[]): string {
  for (let i = signals.length - 1; i >= 0; i--) {
    const content = signals[i]?.metadata?.triggerContent;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
  }

  return "";
}

function shouldActivateSearchSkill(signals: SearchTraitSignal[]): boolean {
  if (signals.some((signal) => signal.dimension === "intent" && signal.value === "search")) {
    return true;
  }

  const triggerContent = extractTriggerContent(signals);
  if (!triggerContent) {
    return false;
  }

  return SEARCH_HINT_PATTERNS.some((pattern) => pattern.test(triggerContent));
}

function readFetchUrl(params: Record<string, unknown>): string | null {
  const raw = params.url;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

@Metadata({ name: "search", description: "Web search tool" })
export default class SearchPlugin extends YesImPlugin {
  static name = "search";
  static inject = ["yesimbot.plugin", "yesimbot.skill", "yesimbot.hook"];
  static Config: Schema<SearchPluginConfig> = Schema.object({
    provider: Schema.string().default("tavily"),
    apiKey: Schema.string().required(),
    endpoint: Schema.string(),
    defaultLimit: Schema.number().default(5),
    jinaApiKey: Schema.string(),
  }).i18n({
    "zh-CN": zhCN,
    "en-US": enUS,
  });
  private config: SearchPluginConfig;

  private disposeSkills: Array<() => void> = [];
  private disposeHook: (() => void) | null = null;

  constructor(ctx: Context, config: SearchPluginConfig) {
    super(ctx);
    this.config = config;
    this.ctx.on("ready", async () => this.start());
    this.ctx.on("dispose", async () => this.dispose());
  }

  private async start(): Promise<void> {
    const backend: SearchBackend = new TavilyBackend(this.ctx, this.config);
    this.registerTool({
      name: SEARCH_SKILL_NAME,
      description:
        "Search the web for current information, news, facts, or web content. " +
        "Use when user asks about recent events, needs fact-checking, or requires information " +
        "that may not be in training data. Returns relevant results with titles, URLs, and snippets. " +
        "For detailed content from search results, use the 'fetch' tool with the URL.",
      type: FunctionType.Tool,
      hidden: true,
      parameters: withInnerThoughts({
        query: Schema.string()
          .required()
          .description("Search query - use clear, specific keywords for best results"),
        ...backend.getParameterSchema(),
      }),
      handler: async (params) => {
        const query = params.query as string;
        const limit = params.limit as number | undefined;
        const results = await backend.search(query, { limit });

        if (results.length === 0) return Success("No results found.");

        const formatted = results
          .map(
            (result, index) =>
              `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
          )
          .join("\n\n");

        return Success(formatted);
      },
    });

    const skills = loadSkillsFromDir(builtinSkillsDir);
    this.disposeSkills = skills.map((skill) => this.ctx["yesimbot.skill"].register(skill));

    const hookService = (this.ctx as Context & { "yesimbot.hook"?: SearchHookService })[
      "yesimbot.hook"
    ];

    if (!this.disposeHook && typeof hookService?.register === "function") {
      this.disposeHook = hookService.register(this.ctx, {
        type: "agent",
        phase: "before",
        metadata: { source: "search-service" },
        handler: async (hookCtx) => {
          const params = hookCtx.params;

          if (
            typeof params.getLoadedSkills === "function" &&
            params.getLoadedSkills().some((skill) => skill.name === SEARCH_SKILL_NAME)
          ) {
            return;
          }

          if (
            typeof params.loadSkill === "function" &&
            shouldActivateSearchSkill(params.traits ?? [])
          ) {
            await params.loadSkill(SEARCH_SKILL_NAME);
          }
        },
      });
    }
  }

  private async dispose(): Promise<void> {
    this.disposeSkills.forEach((dispose) => dispose());
    this.disposeHook?.();
    this.disposeHook = null;
  }

  @Tool({
    name: "fetch",
    description:
      "Fetch and parse a web page's full content using Jina AI Reader. " +
      "Use after 'search' to read detailed content from specific URLs. " +
      "Extracts main content while removing ads, navigation, and clutter.",
    parameters: withInnerThoughts({
      url: Schema.string()
        .required()
        .description("URL of the web page to fetch (must be a valid http/https URL)"),
    }),
    hidden: true,
  })
  private async fetch(params: Record<string, unknown>): Promise<ToolResult<string | unknown>> {
    const url = readFetchUrl(params);
    if (!url) {
      return Failed("Invalid URL. Please provide a valid http/https URL.");
    }

    try {
      const headers: Record<string, string> = {};
      if (this.config.jinaApiKey) {
        headers["Authorization"] = `Bearer ${this.config.jinaApiKey}`;
      }

      const response = await this.ctx.http<string>(`https://r.jina.ai/${encodeURIComponent(url)}`, {
        responseType: "text",
        timeout: 30000,
        validateStatus: () => true,
        headers,
      });

      if (response.status !== 200) {
        return Failed(`Failed to fetch URL: ${response.status} ${response.statusText}`);
      }

      if (typeof response.data !== "string") {
        return Failed("Unexpected response format from Jina AI Reader");
      }

      return Success(response.data);
    } catch (err) {
      return Failed(err instanceof Error ? err.message : String(err));
    }
  }
}
