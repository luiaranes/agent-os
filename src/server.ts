import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { bus } from "./bus.ts";
import { checkRemoteControl, type RemoteControlStatus } from "./remote.ts";
import { startSession, stopSession } from "./runner.ts";
import {
  getProject,
  getProjectByFolder,
  insertProject,
  getSession,
  insertSession,
  listProjects,
  listSessions,
  listTranscript,
  markOrphansStopped,
  type ProjectRecord,
  type SessionRecord,
} from "./store.ts";

const port = Number(process.env.PORT ?? 4317);
const host = "127.0.0.1";

markOrphansStopped();

const app = Fastify({ logger: false });
let remoteControl: RemoteControlStatus = {
  available: false,
  detail: "Checking Remote Control…",
};

await app.register(fastifyStatic, {
  root: path.join(process.cwd(), "public"),
});

function isExistingDirectory(folder: string): boolean {
  const resolved = path.resolve(folder);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
}

app.get("/api/state", async () => ({
  remoteControl,
  defaultCwd: process.cwd(),
  projects: listProjects(),
  sessions: listSessions().map(withTranscript),
}));

app.post<{ Body: { folder?: string } }>("/api/projects", async (request, reply) => {
  const folder = request.body?.folder?.trim() ?? "";
  if (!folder || !isExistingDirectory(folder)) {
    return reply.code(400).send({ error: "Folder does not exist." });
  }
  const resolved = path.resolve(folder);
  if (getProjectByFolder(resolved)) {
    return reply.code(409).send({ error: "That folder is already a project." });
  }
  const basename = path.basename(resolved);
  const name = basename || resolved;
  const project: ProjectRecord = {
    id: crypto.randomUUID(),
    name,
    folder: resolved,
    createdAt: new Date().toISOString(),
  };
  insertProject(project);
  return reply.code(201).send(project);
});

app.post<{ Body: { title?: string; projectId?: string; prompt?: string } }>(
  "/api/sessions",
  async (request, reply) => {
    const title = request.body?.title?.trim() ?? "";
    const projectId = request.body?.projectId?.trim() ?? "";
    const prompt = request.body?.prompt?.trim() ?? "";
    if (!title) return reply.code(400).send({ error: "Title is required." });
    const project = getProject(projectId);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    if (!isExistingDirectory(project.folder)) {
      return reply.code(400).send({ error: "Folder does not exist." });
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      title,
      cwd: project.folder,
      projectId: project.id,
      prompt,
      status: "starting",
      claudeSessionId: null,
      remoteUrl: null,
      costUsd: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    insertSession(session);
    startSession(session);
    return reply.code(201).send(withTranscript(session));
  },
);

app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (request, reply) => {
  const session = getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found." });
  const stopped = await stopSession(session.id);
  if (!stopped) return reply.code(409).send({ error: "Session is not running." });
  return getSession(session.id);
});

app.get("/api/events", (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.raw.write("\n");
  const send = (event: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on("live", send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
  request.raw.on("close", () => {
    clearInterval(ping);
    bus.off("live", send);
  });
});

function withTranscript(session: SessionRecord) {
  return { ...session, transcript: listTranscript(session.id) };
}

remoteControl = await checkRemoteControl();

await app.listen({ port, host });
console.log(`Agent OS dashboard at http://${host}:${port}`);
