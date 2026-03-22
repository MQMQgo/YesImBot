import { Schema } from "koishi";

export interface RoleServiceConfig {
  rolePath?: string;
  debugLevel?: number;
}

export const RoleServiceConfigSchema: Schema<RoleServiceConfig> = Schema.object({
  rolePath: Schema.path({ filters: ["directory"], allowCreate: true }).default(
    "data/yesimbot/roles",
  ),
  debugLevel: Schema.number().min(0).default(2),
});

export type PersonaServiceConfig = RoleServiceConfig;
export const PersonaServiceConfigSchema = RoleServiceConfigSchema;
