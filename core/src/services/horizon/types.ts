import type { UserContent } from "ai";
import type { Session } from "koishi";

import type { ChannelKey, Scenario, TriggerType } from "../../runtime/contracts";

export type AllowedChannel = { platform: string; type: "private" | "guild"; id: string };

export type Role = "owner" | "admin" | "member";

// ---- Horizon Event ----

export interface HorizonMessageEvent {
  platform: string;
  channelId: string;
  timestamp: Date;
  payload: {
    messageId: string;
    senderId: string;
    senderName?: string;
    content: string;
    quoteId?: string;
  };
  triggerType: TriggerType;
  runtime?: { session: Session };
}

declare module "koishi" {
  interface Events {
    "horizon/message": (event: HorizonMessageEvent) => void;
  }
}

// ---- Timeline ----

export enum TimelineEventType {
  Message = "message",
  AgentResponse = "agent.response",
  AgentAction = "agent.action",
  Summary = "summary",
  Heartbeat = "heartbeat",
}

export enum TimelinePriority {
  Noise = 0,
  Normal = 1,
  Important = 2,
  Core = 3,
}

export enum TimelineStage {
  New = "new",
  Active = "active",
  Archived = "archived",
  Deleted = "deleted",
}

export interface BaseTimelineEntry<Type extends TimelineEventType, Data extends object> {
  id: string;
  timestamp: Date;
  platform: string;
  channelId: string;
  type: Type;
  priority: TimelinePriority;
  stage: TimelineStage;
  data: Data;
}

export interface MessageEventData {
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  replyTo?: string;
}

export type MessageRecord = BaseTimelineEntry<TimelineEventType.Message, MessageEventData>;

export interface AgentResponseData {
  rawText: string;
  error?: string;
}

export type AgentResponseRecord = BaseTimelineEntry<
  TimelineEventType.AgentResponse,
  AgentResponseData
>;

export interface AgentActionData {
  actions: Array<{ name: string; params?: Record<string, unknown> }>;
  toolResults: Array<{
    name: string;
    success: boolean;
    status?: string;
    result?: unknown;
    error?: string;
  }>;
}

export type AgentActionRecord = BaseTimelineEntry<TimelineEventType.AgentAction, AgentActionData>;

export interface SummaryData {
  content: string;
  coveredUntil: Date;
  previousSummaryId?: string;
}

export type SummaryRecord = BaseTimelineEntry<TimelineEventType.Summary, SummaryData>;

export interface HeartbeatData {
  triggeredBy: "global" | "manual";
  channelSummary?: string;
}

export type HeartbeatRecord = BaseTimelineEntry<TimelineEventType.Heartbeat, HeartbeatData>;

export type TimelineEntry =
  | MessageRecord
  | AgentResponseRecord
  | AgentActionRecord
  | SummaryRecord
  | HeartbeatRecord;

// ---- Entity ----

export interface EntityRecord {
  id: string;
  type: "user" | "member";
  name: string;
  userId: string;
  username: string;
  nickname?: string;
  parentId?: string;
  refId?: string;
  attributes: Record<string, unknown>;
  updatedAt: Date;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  userId?: string;
  username?: string;
  nickname?: string;
  attributes?: Record<string, unknown>;
}

export interface Environment {
  type: string;
  id: string;
  name: string;
  platform: string;
  channelId: string;
  description?: string;
}

export interface SelfInfo {
  id: string;
  name: string;
  role?: Role;
}

// ---- Image Config ----

export type ImageMode = "native" | "description" | "off";
export type ImageDescriptionDetail = "low" | "high" | "auto";

export const DEFAULT_IMAGE_DESCRIPTION_PROMPT = [
  "请为另一个只能读取文本的聊天模型描述这张图片。",
  "请客观描述可见内容、人物或物体、动作、场景、表情、画面中的文字，",
  "如果这是表情包、梗图或截图，也请说明它传达的语气和关键上下文。",
  "输出简洁但信息充分，不要臆测看不见的细节。",
].join("");

export const DEFAULT_IMAGE_DESCRIPTION_DETAIL: ImageDescriptionDetail = "low";
export const DEFAULT_IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS = 256;

export interface ImageDescriptionConfig {
  model?: string;
  fallbackChain?: string[];
  detail?: ImageDescriptionDetail;
  prompt?: string;
  maxOutputTokens?: number;
}

export interface ImageConfig {
  imageMode: ImageMode;
  maxImagesInContext: number;
  imageLifecycleCount: number;
  description?: ImageDescriptionConfig;
}

// ---- Observation (TEMPORARY - will be removed in Plan 02) ----

export interface MessageObservation {
  type: "message";
  timestamp: Date;
  sender: Entity;
  messageId: string;
  content: string | UserContent;
  stage?: string;
  replyTo?: string;
}

export interface AgentResponseObservation {
  type: "agent.response";
  timestamp: Date;
  data: AgentResponseData;
}

export interface AgentActionObservation {
  type: "agent.action";
  timestamp: Date;
  data: AgentActionData;
}

export type Observation = MessageObservation | AgentResponseObservation | AgentActionObservation;

// ---- ViewOptions ----

export interface ViewOptions {
  session?: Session;
  selfId?: string;
  selfName?: string;
}

// ---- HorizonView ----

export interface HorizonView {
  self: SelfInfo;
  environment: Environment;
  entities: Entity[];
  history: TimelineEntry[];
}

/**
 * Horizon data remains an internal read model and feeds public runtime `Scenario`
 * through adapter boundaries.
 */
export const HORIZON_SCENARIO_BOUNDARY = "internal-scenario-adapter" as const;

export interface HorizonScenarioAdapterSource {
  view: HorizonView;
  stimulusSource: Scenario["raw"]["stimulusSource"];
}

export interface HorizonScenarioProjection {
  raw: Scenario["raw"];
  derived: Scenario["derived"];
}

// ---- Query ----

export interface EventQueryOptions {
  key?: ChannelKey;
  types?: TimelineEventType[];
  stages?: TimelineStage[];
  limit?: number;
  since?: Date;
  until?: Date;
  orderBy?: "asc" | "desc";
}
