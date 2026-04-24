import type { FragmentStability, PromptSectionName } from "../prompt/types";
import type { TraitSignal } from "../shared/types";
import type { SkillDefinition } from "./types";

export interface MatchNode {
  match: { dimension: string; value: string };
}

export interface AndNode {
  and: ConditionNode[];
}

export interface OrNode {
  or: ConditionNode[];
}

export interface NotNode {
  not: ConditionNode;
}

export type ConditionNode = MatchNode | AndNode | OrNode | NotNode;

export type LifecycleStrategy = "per-turn" | "sticky" | "trait-bound";

export interface StyleEffect {
  content: string;
}

export interface ToolFilter {
  include?: string[];
  exclude?: string[];
}

export interface SkillEffects {
  prompt?: string;
  style?: StyleEffect;
  tools?: ToolFilter;
}

export interface SkillFragmentMetadata {
  section: PromptSectionName;
  stability?: FragmentStability;
  priority?: number;
  cacheable?: boolean;
}

export interface SkillStyleFragmentMetadata {
  section?: Extract<PromptSectionName, "identity" | "policy">;
  stability?: FragmentStability;
  priority?: number;
  cacheable?: boolean;
}

export type SkillWithLegacyMetadata = SkillDefinition & {
  conditions?: ConditionNode;
  activate?: (signals: TraitSignal[]) => boolean;
  lifecycle?: LifecycleStrategy;
  stickyTimeout?: number;
  promptFragment?: SkillFragmentMetadata;
  styleFragment?: SkillStyleFragmentMetadata;
  effects?: SkillEffects;
};
