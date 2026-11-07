// Command registration. Each stage adds its command modules here.

import type { CommandDefinition, DefineCommand } from "../types.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerSiteCommands } from "./sites.ts";

export function createCommands(): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  const define: DefineCommand = (command) => {
    commands.push(command);
  };
  registerAuthCommands(define);
  registerSiteCommands(define);
  return commands;
}
