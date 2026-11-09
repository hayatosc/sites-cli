// Keep argv boundaries across native executables, shebangs and Windows .cmd shims.
import { x } from "tinyexec";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export function spawnCommand(
  file: string,
  args: string[],
  options: Omit<SpawnOptions, "shell" | "windowsVerbatimArguments">,
): ChildProcess {
  // tinyexec normally merges the parent environment and prepends local bins.
  // Preserve the explicit environment/PATH contract of the existing callers.
  const env = options.env && {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
    ...options.env,
  };
  const child = x(file, args, {
    nodePath: false,
    nodeOptions: { ...options, env, shell: false, windowsVerbatimArguments: false },
  }).process;
  // x() starts synchronously. Keep using the native handle so callers retain
  // close/error events, streaming, kill, unref and their own bounded timeouts.
  if (!child) throw new Error("tinyexec did not create a child process.");
  return child;
}
