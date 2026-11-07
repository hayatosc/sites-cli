// Command registration. Each stage adds its command modules here.

import type { CommandDefinition, DefineCommand } from "../types.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerSiteCommands } from "./sites.ts";
import { registerInitCommands } from "./init.ts";
import { registerCreateCommands } from "./create.ts";
import { registerDeployCommands } from "./deploy.ts";

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
  return commands;
}
