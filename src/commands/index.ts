// One native Gunshi registry supplies execution, help and command discovery.

import { define as defineGunshi, type Command, type CommandContext as GunshiContext } from "gunshi";
import { commandArgs } from "../args.ts";
import { usageError } from "../errors.ts";
import type { CommandDefinition, DefineCommand } from "../types.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerSiteCommands } from "./sites.ts";
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

export function createCommands(): CommandDefinition[] {
  const commands: CommandDefinition[] = [];
  const define: DefineCommand = <T>(command: CommandDefinition<T>): void => {
    commands.push({
      ...command,
      gunshi: defineGunshi({
        name: command.path.at(-1),
        description: command.summary,
        args: commandArgs(command),
        internal: command.hidden,
        toKebab: false,
        examples: command.usage,
      }),
    } as CommandDefinition);
  };
  registerAuthCommands(define);
  registerSiteCommands(define);
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

export function createCommandTree(
  commands: CommandDefinition[],
  execute: (command: CommandDefinition, ctx: Readonly<GunshiContext>) => Promise<void>,
): Map<string, Command> {
  const root = new Map<string, Command>();
  const groups = new Map<string, Map<string, Command>>();
  for (const command of commands) {
    let children = root;
    let prefix = "";
    for (const part of command.path.slice(0, -1)) {
      prefix += ` ${part}`;
      let nested = groups.get(prefix);
      if (!nested) {
        nested = new Map<string, Command>();
        groups.set(prefix, nested);
        children.set(
          part,
          defineGunshi({
            name: part,
            subCommands: nested,
            run: () => {
              throw usageError(
                "USAGE_MISSING_SUBCOMMAND",
                `Choose a ${part} subcommand; use --help.`,
              );
            },
          }),
        );
      }
      children = nested;
    }
    if (!command.gunshi) throw new Error(`Missing native command: ${command.path.join(" ")}`);
    command.gunshi.run = (ctx) => execute(command, ctx);
    children.set(command.path.at(-1) ?? "", command.gunshi);
  }
  return root;
}
