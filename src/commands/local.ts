// Shell completion for the Sites CLI.

import os from "node:os";
import path from "node:path";
import { commandCompletions } from "../args.ts";
import { usageError } from "../errors.ts";
import type { CommandDefinition, CommandResult, DefineCommand } from "../types.ts";

const COMPLETION_SCRIPTS: Record<string, string> = {
  bash: `_sites_complete() {
  local IFS=$'\\n'
  COMPREPLY=($(sites complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}"))
}
complete -F _sites_complete sites
`,
  zsh: `#compdef sites
_sites_complete() {
  local -a candidates
  candidates=("\${(@f)$(sites complete -- "\${words[@]:1}")}")
  compadd -- "\${candidates[@]}"
}
compdef _sites_complete sites
`,
  fish: `complete -c sites -f -a '(sites complete -- (commandline -opc)[2..-1] (commandline -ct))'
`,
  powershell: `Register-ArgumentCompleter -Native -CommandName sites -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if (-not $wordToComplete) { $words += '' }
  sites complete -- @words | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`,
};

export function registerLocalCommands(define: DefineCommand, commands: CommandDefinition[]): void {
  define({
    path: ["complete"],
    positionals: { min: 0, max: Number.POSITIVE_INFINITY, names: ["shell|words.."] },
    summary: "Generate shell completion scripts or completion candidates",
    usage: "sites complete [bash|zsh|fish|powershell]  or  sites complete -- <words..>",
    run: async (ctx): Promise<CommandResult<{ shell: string } | string[]>> => {
      const shell = ctx.positionals[0];
      const runtime = ctx.argv.includes("--");
      if (!runtime && ctx.positionals.length === 1) {
        if (!Object.hasOwn(COMPLETION_SCRIPTS, shell))
          throw usageError("USAGE_UNSUPPORTED_SHELL", `Unsupported shell: ${shell}`, {
            hint: "Use bash, zsh, fish, or powershell.",
          });
        return { data: { shell }, raw: COMPLETION_SCRIPTS[shell] };
      }
      if (!runtime && !ctx.positionals.length) {
        const detected = path.basename(
          ctx.env.SHELL ?? (os.platform() === "win32" ? "powershell" : "bash"),
        );
        if (!Object.hasOwn(COMPLETION_SCRIPTS, detected))
          throw usageError("USAGE_UNSUPPORTED_SHELL", `Unsupported shell: ${detected}`, {
            hint: "Use bash, zsh, fish, or powershell.",
          });
        return { data: { shell: detected }, raw: COMPLETION_SCRIPTS[detected] };
      }
      const candidates = commandCompletions(ctx.positionals, commands);
      return { data: candidates, raw: candidates.length ? candidates.join("\n") + "\n" : "" };
    },
  });
}
