// Detect agent harnesses from the environment, matching the cf CLI.
//
// Detection is advisory: it only decides whether help output includes the
// compact agent discovery block. It must never affect command behavior.

import type { Env } from "./types.ts";

export interface AgentHarness {
  id: string;
  name: string;
  surface?: string;
}

export interface AgentModel {
  id: string;
  provider?: string;
}

export interface AgentMatch {
  harness: AgentHarness;
  model?: AgentModel;
  sessionId?: string;
  invocationId?: string;
  signals: readonly string[];
}

export interface AgentContext {
  isAgentic: boolean;
  harness: AgentHarness | null;
  model: AgentModel | null;
  sessionId: string | null;
  invocationId: string | null;
  matches: readonly AgentMatch[];
}

const FALSE_LIKE_VALUES = new Set(["", "0", "false", "no", "off"]);

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  return FALSE_LIKE_VALUES.has(normalized.toLowerCase()) ? undefined : normalized;
}

function isExact(env: Env, name: string, expected: string): boolean {
  return env[name] === expected;
}

function match(
  harness: AgentHarness,
  signals: string[],
  metadata: Omit<AgentMatch, "harness" | "signals"> = {},
): AgentMatch {
  return { harness, ...metadata, signals };
}

function detectPi(env: Env): AgentMatch | null {
  const signals: string[] = [];
  if (isExact(env, "PI_CODING_AGENT", "true")) signals.push("PI_CODING_AGENT");
  if (isExact(env, "AI_AGENT", "pi")) signals.push("AI_AGENT");
  if (signals.length === 0) return null;
  const sessionId = value(env, "PI_SESSION_ID");
  if (sessionId) signals.push("PI_SESSION_ID");
  const provider = value(env, "PI_PROVIDER");
  const modelId = value(env, "PI_MODEL");
  if (provider) signals.push("PI_PROVIDER");
  if (modelId) signals.push("PI_MODEL");
  return match({ id: "pi", name: "Pi" }, signals, {
    model: modelId ? { id: modelId, provider } : undefined,
    sessionId,
  });
}

function detectClaudeCode(env: Env): AgentMatch | null {
  if (!isExact(env, "CLAUDECODE", "1")) return null;
  const signals = ["CLAUDECODE"];
  const sessionId = value(env, "CLAUDE_CODE_SESSION_ID");
  if (sessionId) signals.push("CLAUDE_CODE_SESSION_ID");
  return match({ id: "claude-code", name: "Claude Code" }, signals, { sessionId });
}

function detectCodex(env: Env): AgentMatch | null {
  const sessionId = value(env, "CODEX_THREAD_ID");
  if (!sessionId) return null;
  return match({ id: "codex", name: "OpenAI Codex" }, ["CODEX_THREAD_ID"], { sessionId });
}

function detectCursor(env: Env): AgentMatch | null {
  if (!isExact(env, "CURSOR_AGENT", "1")) return null;
  const signals = ["CURSOR_AGENT"];
  const sessionId = value(env, "CURSOR_CONVERSATION_ID");
  const invocationId = value(env, "CURSOR_TRACE_ID");
  if (sessionId) signals.push("CURSOR_CONVERSATION_ID");
  if (invocationId) signals.push("CURSOR_TRACE_ID");
  return match({ id: "cursor-agent", name: "Cursor Agent" }, signals, {
    sessionId,
    invocationId,
  });
}

function detectGemini(env: Env): AgentMatch | null {
  return isExact(env, "GEMINI_CLI", "1")
    ? match({ id: "gemini-agent", name: "Gemini CLI" }, ["GEMINI_CLI"])
    : null;
}

function detectOpenCode(env: Env): AgentMatch | null {
  return isExact(env, "OPENCODE", "1")
    ? match({ id: "opencode", name: "OpenCode" }, ["OPENCODE"])
    : null;
}

function detectQwen(env: Env): AgentMatch | null {
  const sessionId = value(env, "QWEN_CODE_SESSION_ID");
  if (!sessionId) return null;
  const signals = ["QWEN_CODE_SESSION_ID"];
  const modelId = value(env, "QWEN_CODE_MODEL");
  const agentId = value(env, "QWEN_CODE_AGENT_ID");
  const promptId = value(env, "QWEN_CODE_PROMPT_ID");
  if (modelId) signals.push("QWEN_CODE_MODEL");
  if (agentId) signals.push("QWEN_CODE_AGENT_ID");
  if (promptId) signals.push("QWEN_CODE_PROMPT_ID");
  return match({ id: "qwen-code", name: "Qwen Code" }, signals, {
    model: modelId ? { id: modelId } : undefined,
    sessionId,
    invocationId: agentId ?? promptId,
  });
}

function detectDeepSeek(env: Env): AgentMatch | null {
  if (!isExact(env, "DSH_SHELL", "1")) return null;
  const signals = ["DSH_SHELL"];
  const sessionId = value(env, "DSH_SESSION_ID");
  if (sessionId) signals.push("DSH_SESSION_ID");
  return match({ id: "deepseek-harness", name: "DeepSeek Harness" }, signals, { sessionId });
}

function detectAmp(env: Env): AgentMatch | null {
  const sessionId = value(env, "AMP_CURRENT_THREAD_ID");
  return sessionId
    ? match({ id: "amp", name: "Amp" }, ["AMP_CURRENT_THREAD_ID"], { sessionId })
    : null;
}

function detectAuggie(env: Env): AgentMatch | null {
  return isExact(env, "AUGMENT_AGENT", "1")
    ? match({ id: "auggie", name: "Auggie" }, ["AUGMENT_AGENT"])
    : null;
}

function detectCrush(env: Env): AgentMatch | null {
  const signals: string[] = [];
  if (isExact(env, "CRUSH", "1")) signals.push("CRUSH");
  if (isExact(env, "AI_AGENT", "crush")) signals.push("AI_AGENT");
  return signals.length > 0 ? match({ id: "crush", name: "Crush" }, signals) : null;
}

function detectCopilot(env: Env): AgentMatch | null {
  const signals: string[] = [];
  if (isExact(env, "AI_AGENT", "github_copilot_vscode_agent")) signals.push("AI_AGENT");
  if (isExact(env, "COPILOT_AGENT", "1")) signals.push("COPILOT_AGENT");
  return signals.length > 0
    ? match(
        { id: "vscode-copilot-agent", name: "GitHub Copilot in VS Code", surface: "vscode" },
        signals,
      )
    : null;
}

function detectWarp(env: Env): AgentMatch | null {
  const sessionId = value(env, "OZ_RUN_ID");
  return sessionId ? match({ id: "warp", name: "Warp" }, ["OZ_RUN_ID"], { sessionId }) : null;
}

const DETECTORS = [
  detectOpenCode,
  detectQwen,
  detectPi,
  detectDeepSeek,
  detectCursor,
  detectClaudeCode,
  detectCodex,
  detectAmp,
  detectGemini,
  detectAuggie,
  detectCrush,
  detectCopilot,
  detectWarp,
];

export function detectAgentContext(env: Env = process.env as Env): AgentContext {
  const matches: AgentMatch[] = [];
  for (const detector of DETECTORS) {
    try {
      const found = detector(env);
      if (found) matches.push(found);
    } catch {
      // Detection must never prevent a CLI request.
    }
  }
  return {
    isAgentic: matches.length > 0,
    harness: matches[0]?.harness ?? null,
    model: matches.find((entry) => entry.model)?.model ?? null,
    sessionId: matches.find((entry) => entry.sessionId)?.sessionId ?? null,
    invocationId: matches.find((entry) => entry.invocationId)?.invocationId ?? null,
    matches,
  };
}
