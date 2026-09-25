import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan, ThinkingLevel } from "../../runtime-routing.ts";
import { extractPaneSummary } from "../pane-summary.ts";

/**
 * Resolve the pi agent config directory, respecting PI_CODING_AGENT_DIR.
 * Kept local on purpose: importing the extension entry module from a harness
 * driver would create an import cycle.
 */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    // Resolve the destination from the agent config dir. $HOME with a POSIX
    // "/tmp" fallback writes to the current drive root on Windows, and
    // splitting on "/" never finds a basename in a Windows path.
    const sessionsDir = join(getAgentConfigDir(), "sessions", "claude-code");
    mkdirSync(sessionsDir, { recursive: true });
    const filename = basename(transcriptPath) || `claude-${Date.now()}.jsonl`;
    copyFileSync(transcriptPath, join(sessionsDir, filename));
    return filename;
  } catch {
    return null;
  }
}

export class ClaudeHarnessDriver implements HarnessDriver {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.modelId;
  }

  validateRuntimePlan(runtimePlan: ResolvedRuntimePlan, parentThinking: ThinkingLevel): void {
    if (runtimePlan.thinkingSource !== "parent" || runtimePlan.thinking !== parentThinking) {
      throw new Error(
        "Thinking-level overrides are not supported for Claude CLI subagents; omit thinking or use a Pi-backed agent.",
      );
    }
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      effectiveModel,
      subagentsDir,
      effectiveCwd,
      surface,
      artifactDir,
      shellQuote,
    } = context;

    // Keep the sentinel beside the run's artifacts and use forward slashes: the
    // child is Git Bash, where a literal "/tmp" resolves to the Windows temp
    // directory, while Node resolves the same string to the current drive root.
    const sentinelFile = join(artifactDir, `pi-claude-${params.id}-done`).replace(/\\/g, "/");
    mkdirSync(dirname(sentinelFile), { recursive: true });
    const pluginDir = join(subagentsDir, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellQuote(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellQuote(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellQuote(effectiveModel));
    }

    const sp = params.systemPrompt ?? agentDefs?.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellQuote(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--resume", shellQuote(params.resumeSessionId));
    }

    // Pass the task as prompt
    cmdParts.push(shellQuote(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      sentinelFile,
      cli: "claude",
      launchScriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ],
    };
  }

  async extractResult(context: SubagentResultContext): Promise<HarnessResult | null> {
    const { running } = context;
    let summary = "";

    if (running.sentinelFile) {
      try {
        summary = readFileSync(running.sentinelFile, "utf-8").trim();
      } catch {}
    }

    if (!summary) {
      summary = extractPaneSummary(context, this.name);
    }

    let sessionId: string | null = null;
    if (running.sentinelFile) {
      sessionId = copyClaudeSession(running.sentinelFile);
      try { unlinkSync(running.sentinelFile); } catch {}
      try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
    }

    return {
      summary,
      sessionId: sessionId ?? undefined,
      details: sessionId ? { claudeSessionId: sessionId } : undefined,
    };
  }
}
