import fs from "node:fs";
import { publish } from "./bus.ts";
import { appendTranscript, listTranscript, updateSession } from "./store.ts";

type ContentBlock = { type?: string; text?: string; name?: string };

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

function linesFromRecord(record: Record<string, unknown>): string[] {
  const message = record.message as { content?: unknown } | undefined;
  if (record.type === "user") {
    const text = textOf(message?.content);
    if (!text || text.startsWith("<")) return [];
    return [`You: ${text}`];
  }
  if (record.type === "assistant") {
    const text = textOf(message?.content);
    return text ? [text] : [];
  }
  return [];
}

export function followTranscript(sessionId: string, filePath: string): void {
  let offset = 0;
  let remainder = "";
  const seenBodies = new Set(listTranscript(sessionId).map((line) => line.body));

  const read = () => {
    if (!fs.existsSync(filePath)) return;
    const size = fs.statSync(filePath).size;
    if (size < offset) {
      offset = 0;
      remainder = "";
    }
    if (size === offset) return;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    remainder += buf.toString("utf8");
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    let sawReply = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const body of linesFromRecord(record)) {
        if (seenBodies.has(body)) continue;
        seenBodies.add(body);
        const saved = appendTranscript(sessionId, body);
        publish({ type: "transcript", sessionId, ...saved });
        if (!body.startsWith("You: ")) sawReply = true;
      }
    }
    if (sawReply) {
      const session = updateSession(sessionId, { status: "idle" });
      publish({ type: "session", session });
    }
  };

  read();
  fs.watchFile(filePath, { interval: 500 }, read);
}
