// Command registration. Each stage adds its command modules here.

import type { CommandDefinition, DefineCommand } from "../types.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerSiteCommands } from "./sites.ts";
import { registerInitCommands } from "./init.ts";
import { registerCreateCommands } from "./create.ts";
import { registerDeployCommands } from "./deploy.ts";
import { registerVersionCommands } from "./versions.ts";
import { registerEnvCommands } from "./env.ts";
import { registerAccessCommands } from "./access.ts";
import { registerDomainCommands } from "./domains.ts";
import { registerAnalyticsCommands } from "./analytics.ts";
import { registerOpenDeleteCommands } from "./open.ts";
import { registerDoctorCommands } from "./doctor.ts";
import { registerDocsCommands } from "./docs.ts";
import { registerLocalCommands } from "./local.ts";
import { registerMigrationCommands } from "./migrations.ts";
import { registerTypeCommands } from "./types.ts";

export function createCommands(): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  const define: DefineCommand = <T>(command: CommandDefinition<T>): void => {
    commands.push(command as CommandDefinition);
  };
  registerAuthCommands(define);
  registerSiteCommands(define);
  registerInitCommands(define);
  registerCreateCommands(define);
  registerDeployCommands(define);
  registerVersionCommands(define);
  registerEnvCommands(define);
  registerAccessCommands(define);
  registerDomainCommands(define);
  registerAnalyticsCommands(define);
  registerOpenDeleteCommands(define);
  registerDoctorCommands(define);
  registerLocalCommands(define, commands);
  registerMigrationCommands(define);
  registerTypeCommands(define);
  registerDocsCommands(define, commands);
  const versionShow = commands.find((command) => command.path.join(" ") === "versions show");
  if (versionShow)
    define({
      ...versionShow,
      path: ["versions", "get"],
      hidden: true,
      usage: "sites versions get <version_id>",
    });
  const schema = commands.find((command) => command.path[0] === "schema");
  if (schema)
    define({
      ...schema,
      path: ["tools"],
      hidden: true,
      positionals: { min: 0, max: 0 },
      run: (ctx) => schema.run({ ...ctx, options: { ...ctx.options, list: true } }),
    });
  return commands;
}
