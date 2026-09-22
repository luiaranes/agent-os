import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { followTranscript } from "./follow.ts";
import { publish } from "./bus.ts";
import {
  appendTranscript,
  getSession,
  updateSession,
  type SessionRecord,
} from "./store.ts";

const active = new Map<string, ChildProcess>();
const seen = new Map<string, Set<string>>();

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
};

function note(sessionId: string, body: string): void {
  const line = appendTranscript(sessionId, body);
  publish({ type: "transcript", sessionId, ...line });
}

function save(id: string, patch: Parameters<typeof updateSession>[1]): SessionRecord {
  const session = updateSession(id, patch);
  publish({ type: "session", session });
  return session;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = block as ContentBlock;
      if (item.type === "text" && item.text?.trim()) return item.text.trim();
      if (item.type === "tool_use" && item.name) return `Using ${item.name}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function remember(sessionId: string, uuid: unknown): boolean {
  if (typeof uuid !== "string") return true;
  const ids = seen.get(sessionId) ?? new Set<string>();
  seen.set(sessionId, ids);
  if (ids.has(uuid)) return false;
  ids.add(uuid);
  return true;
}

function watchTranscript(sessionId: string, cwd: string, startedAt: number): void {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", slug);
  const timer = setInterval(() => {
    if (!fs.existsSync(dir)) return;
    const recent = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((file) => file.mtime >= startedAt - 5000)
      .sort((a, b) => b.mtime - a.mtime);
    const match = recent[0];
    if (!match) return;
    clearInterval(timer);
    save(sessionId, { claudeSessionId: match.name.replace(/\.jsonl$/, "") });
    followTranscript(sessionId, path.join(dir, match.name));
  }, 500);
  setTimeout(() => clearInterval(timer), 60_000).unref();
}

function releasePreviousBridge(cwd: string): void {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const pointer = path.join(os.homedir(), ".claude", "projects", slug, "bridge-pointer.json");
  if (!fs.existsSync(pointer)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.renameSync(pointer, `${pointer}.${stamp}`);
}

export function startSession(session: SessionRecord): void {
  releasePreviousBridge(session.cwd);
  seen.set(session.id, new Set());
  const child = spawn(
    "claude",
    [
      "remote-control",
      "--name",
      session.title,
      "--spawn",
      "session",
      "--permission-mode",
      "default",
      "--verbose",
    ],
    {
      cwd: session.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  active.set(session.id, child);
  watchTranscript(session.id, session.cwd, Date.now());

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) ingest(session.id, line);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
    const clean = stripAnsi(chunk).trim();
    if (/^Error:/i.test(clean) || /disabled by your organization/i.test(clean)) note(session.id, clean);
  });
  child.on("error", (error) => {
    note(session.id, error.message);
    save(session.id, { status: "error", error: error.message });
    active.delete(session.id);
  });
  child.on("exit", (code) => {
    active.delete(session.id);
    seen.delete(session.id);
    const current = getSession(session.id);
    if (!current || current.status === "stopped" || current.status === "error") return;
    if (code === 0) {
      save(session.id, { status: "done" });
      return;
    }
    save(session.id, {
      status: "error",
      error: stderr.trim() || `Claude exited with code ${code ?? "unknown"}.`,
    });
  });
}

function ingest(id: string, rawLine: string): void {
  const line = stripAnsi(rawLine).trim();
  if (!line) return;

  const url = line.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0];
  if (url && getSession(id)?.remoteUrl !== url) {
    save(id, { status: "running", remoteUrl: url });
    note(id, `Remote Control on. Open ${url}`);
  }

  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
  } catch {
    return;
  }

  const sessionId = typeof message.session_id === "string" ? message.session_id : null;
  const current = getSession(id);
  if (sessionId && current && current.claudeSessionId !== sessionId) {
    save(id, {
      claudeSessionId: sessionId,
      ...(current.status === "starting" ? { status: "running" as const } : {}),
    });
  }

  if (message.type === "user") {
    if (!remember(id, message.uuid)) return;
    const nested = message.message as { content?: unknown } | undefined;
    const text = textOf(nested?.content);
    if (text) note(id, `You: ${text}`);
    return;
  }

  if (message.type === "assistant") {
    if (!remember(id, message.uuid)) return;
    const nested = message.message as { content?: unknown } | undefined;
    const text = textOf(nested?.content);
    if (text) note(id, text);
    return;
  }

  if (message.type === "result") {
    const finished = getSession(id);
    if (!finished || finished.status === "stopped") return;
    const failed = message.is_error === true || message.subtype !== "success";
    save(id, {
      status: failed ? "error" : "idle",
      costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : finished.costUsd,
      error: failed ? String(message.subtype ?? "error") : null,
    });
  }
}

export function stopSession(id: string): boolean {
  const child = active.get(id);
  if (!child) return false;
  save(id, { status: "stopped", error: "Stopped from the dashboard." });
  note(id, "Stopped from the dashboard.");
  child.kill("SIGTERM");
  setTimeout(() => {
    if (active.has(id)) child.kill("SIGKILL");
  }, 2000).unref();
  return true;
}
