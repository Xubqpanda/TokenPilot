import type { ModuleScheduleDecision, ModuleScheduler, RuntimeModule } from "./interfaces.js";
import type { RuntimeTurnContext } from "./types.js";

export type FixedScheduleProfile = {
  id: string;
  moduleNames: string[];
  match: (ctx: RuntimeTurnContext) => boolean;
  reason?: string;
};

export type FixedModuleSchedulerConfig = {
  name?: string;
  defaultModuleNames?: string[];
  profiles?: FixedScheduleProfile[];
};

function resolveModulesByName(moduleNames: string[], availableModules: RuntimeModule[]): RuntimeModule[] {
  const byName = new Map(availableModules.map((mod) => [mod.name, mod]));
  return moduleNames
    .map((name) => byName.get(name))
    .filter((mod): mod is RuntimeModule => Boolean(mod));
}

export function createFixedModuleScheduler(cfg: FixedModuleSchedulerConfig = {}): ModuleScheduler {
  const schedulerName = cfg.name ?? "fixed-module-scheduler";
  const profiles = cfg.profiles ?? [];
  const defaultModuleNames = cfg.defaultModuleNames ?? [];

  return {
    name: schedulerName,
    async selectModules(ctx, availableModules): Promise<ModuleScheduleDecision> {
      const matchedProfile = profiles.find((profile) => profile.match(ctx));
      if (matchedProfile) {
        return {
          modules: resolveModulesByName(matchedProfile.moduleNames, availableModules),
          scheduleId: matchedProfile.id,
          reason: matchedProfile.reason ?? "fixed-profile-match",
        };
      }

      if (defaultModuleNames.length > 0) {
        return {
          modules: resolveModulesByName(defaultModuleNames, availableModules),
          scheduleId: "fixed-default",
          reason: "fixed-default-module-names",
        };
      }

      return {
        modules: availableModules,
        scheduleId: "fixed-all",
        reason: "fixed-fallback-all-modules",
      };
    },
  };
}
