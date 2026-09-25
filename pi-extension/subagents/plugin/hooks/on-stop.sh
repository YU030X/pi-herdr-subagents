#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Writes a sentinel file when Claude completes autonomously (no user interjection).

set -euo pipefail

# Read JSON input from stdin
input=$(cat)

# Guard: only act for pi-spawned sessions
if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

# JSON handling runs on node: pi already runs on it, while a python3 dependency
# silently disables this hook wherever python3 is missing.
printf '%s' "$input" | node -e '
const fs = require("node:fs");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Guard: if stop_hook_active is true, we are in a loop - bail out
  if (payload.stop_hook_active === true) process.exit(0);

  const sentinel = process.env.PI_CLAUDE_SENTINEL;
  if (!sentinel) process.exit(0);

  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || !transcriptPath) process.exit(0);

  // Only a regular file counts, matching the previous "[ ! -f ]" guard.
  let transcriptIsFile = false;
  try {
    transcriptIsFile = fs.statSync(transcriptPath).isFile();
  } catch {
    transcriptIsFile = false;
  }
  if (!transcriptIsFile) process.exit(0);

  // Always write the transcript path so the watcher can copy the session file
  try {
    fs.writeFileSync(sentinel + ".transcript", transcriptPath);
  } catch {}

  // Count real human messages in the transcript. Claude writes human input as
  // string content and tool results as array content with tool_result blocks.
  let humanMessages = 0;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    process.exit(0);
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // An absent content field counted as a human message before, and
    // undercounting is the unsafe direction: it would report an interactive
    // session as autonomously finished.
    const content = entry && entry.type === "user" ? entry.message?.content ?? "" : undefined;
    if (typeof content === "string") {
      humanMessages += 1;
    }
  }

  // Exactly one human message (the initial prompt) means this was autonomous.
  if (humanMessages === 1) {
    const summary = typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
    try {
      fs.writeFileSync(sentinel, summary);
    } catch {}
  }
});
'
