import type { PromptFragment } from "../prompt/types";

export interface SkillResourceReference {
  path: string;
  description?: string;
}

export type SkillResourceMap = Record<string, SkillResourceReference>;

export interface SkillDefinition {
  name: string;
  description: string;
  guidance: string;
  allowedTools?: string[];
  resources?: SkillResourceMap;
  rootDir: string;
  source: "file" | "plugin";
}

export interface SkillMetadata {
  name: string;
  description: string;
  allowedTools?: string[];
  resources?: SkillResourceMap;
}

export type LoadResultStatus =
  | "loaded"
  | "already_loaded"
  | "not_found"
  | "invalid_definition"
  | "rejected_by_policy"
  | "loaded_but_inactive_effects";

export interface LoadResult {
  status: LoadResultStatus;
  skill?: SkillDefinition;
  reason?: string;
}

export interface LoadAttempt {
  name: string;
  status: LoadResultStatus | "unloaded";
  timestamp: number;
  caller?: string;
  reason?: string;
}

export interface AppliedSkillEffects {
  instructionBlocks: PromptFragment[];
  styleBlock: PromptFragment | null;
  toolVisibility: { include: string[]; exclude: string[] };
  metadata: {
    loadedSkills: string[];
    loadHistory: LoadAttempt[];
  };
}
