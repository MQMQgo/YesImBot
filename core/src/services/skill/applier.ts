import type { PromptFragment } from "../prompt/types";
import { specificity } from "./condition";
import type { SkillWithLegacyMetadata } from "./legacy-types";
import { LoadedSkillSet } from "./loaded-skill-set";
import { normalizePromptMetadata, normalizeStyleMetadata } from "./normalize";
import type { AppliedSkillEffects } from "./types";

interface CandidateStyleFragment {
  fragment: PromptFragment;
  specificity: number;
}

export class SkillEffectApplier {
  apply(loadedSkills: LoadedSkillSet): AppliedSkillEffects {
    const instructionBlocks: PromptFragment[] = [];
    const toolVisibility = { include: [] as string[], exclude: [] as string[] };

    let bestStyle: CandidateStyleFragment | null = null;

    for (const skill of loadedSkills.getLoaded()) {
      const legacySkill = skill as SkillWithLegacyMetadata;
      if (legacySkill.effects?.prompt) {
        const promptMeta = normalizePromptMetadata(legacySkill);
        instructionBlocks.push({
          id: `skill.${skill.name}.prompt`,
          content: `<skill name="${skill.name}">${legacySkill.effects.prompt}</skill>`,
          section: promptMeta.section,
          source: "skill",
          priority: promptMeta.priority,
          stability: promptMeta.stability,
          cacheable: promptMeta.cacheable,
        });
      }

      if (legacySkill.effects?.style?.content) {
        const styleMeta = normalizeStyleMetadata(legacySkill);
        const styleSpecificity = legacySkill.conditions ? specificity(legacySkill.conditions) : 0;
        if (!bestStyle || styleSpecificity >= bestStyle.specificity) {
          bestStyle = {
            specificity: styleSpecificity,
            fragment: {
              id: `skill.${skill.name}.style`,
              content: legacySkill.effects.style.content,
              section: styleMeta.section,
              source: "skill",
              priority: styleMeta.priority,
              stability: styleMeta.stability,
              cacheable: styleMeta.cacheable,
            },
          };
        }
      }

      if (legacySkill.effects?.tools?.include) {
        toolVisibility.include.push(...legacySkill.effects.tools.include);
      }

      if (legacySkill.effects?.tools?.exclude) {
        toolVisibility.exclude.push(...legacySkill.effects.tools.exclude);
      }
    }

    return {
      instructionBlocks,
      styleBlock: bestStyle?.fragment ?? null,
      toolVisibility,
      metadata: {
        loadedSkills: loadedSkills.getLoadedNames(),
        loadHistory: loadedSkills.getLoadHistory(),
      },
    };
  }
}

export type { AppliedSkillEffects };
