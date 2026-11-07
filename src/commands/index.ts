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
  registerDocsCommands(define, commands);
  return commands;
}
