import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SessionStatus = "starting" | "running" | "idle" | "done" | "error" | "stopped";

export type ProjectRecord = {
  id: string;
  name: string;
  folder: string;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  title: string;
  cwd: string;
  projectId: string | null;
  prompt: string;
  status: SessionStatus;
  claudeSessionId: string | null;
  remoteUrl: string | null;
  costUsd: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = {
  id: string;
  name: string;
  folder: string;
  created_at: string;
};

type SessionRow = {
  id: string;
  title: string;
  cwd: string;
  project_id: string | null;
  prompt: string;
  status: SessionStatus;
  claude_session_id: string | null;
  remote_url: string | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "agent-os.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    claude_session_id TEXT,
    cost_usd REAL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transcript (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
`);

const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
if (!columns.some((column) => column.name === "remote_url")) {
  db.exec("ALTER TABLE sessions ADD COLUMN remote_url TEXT");
}
if (!columns.some((column) => column.name === "project_id")) {
  db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
}

const cwdGroups = db
  .prepare(
    "SELECT cwd, MIN(created_at) AS created_at FROM sessions WHERE project_id IS NULL GROUP BY cwd",
  )
  .all() as { cwd: string; created_at: string }[];
const findProjectByFolder = db.prepare("SELECT id FROM projects WHERE folder = ?");
const insertProjectRow = db.prepare(
  "INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)",
);
for (const group of cwdGroups) {
  if (findProjectByFolder.get(group.cwd)) continue;
  const basename = path.basename(group.cwd);
  const name = basename || group.cwd;
  insertProjectRow.run(crypto.randomUUID(), name, group.cwd, group.created_at);
}
db.exec(
  "UPDATE sessions SET project_id = (SELECT id FROM projects WHERE folder = sessions.cwd) WHERE project_id IS NULL",
);

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    createdAt: row.created_at,
  };
}

export function listProjects(): ProjectRecord[] {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY created_at DESC")
    .all() as ProjectRow[];
  return rows.map(mapProject);
}

export function getProject(id: string): ProjectRecord | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? mapProject(row) : undefined;
}

export function getProjectByFolder(folder: string): ProjectRecord | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE folder = ?").get(folder) as
    | ProjectRow
    | undefined;
  return row ? mapProject(row) : undefined;
}

export function insertProject(project: ProjectRecord): void {
  db.prepare("INSERT INTO projects (id, name, folder, created_at) VALUES (?, ?, ?, ?)").run(
    project.id,
    project.name,
    project.folder,
    project.createdAt,
  );
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status,
    claudeSessionId: row.claude_session_id,
    remoteUrl: row.remote_url,
    costUsd: row.cost_usd,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSessions(): SessionRecord[] {
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
    .all() as SessionRow[];
  return rows.map(mapSession);
}

export function getSession(id: string): SessionRecord | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? mapSession(row) : undefined;
}

export function insertSession(session: SessionRecord): void {
  db.prepare(
    `INSERT INTO sessions (
      id, title, cwd, project_id, prompt, status, claude_session_id, remote_url, cost_usd, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.title,
    session.cwd,
    session.projectId,
    session.prompt,
    session.status,
    session.claudeSessionId,
    session.remoteUrl,
    session.costUsd,
    session.error,
    session.createdAt,
    session.updatedAt,
  );
}

export function updateSession(
  id: string,
  patch: Partial<Pick<SessionRecord, "status" | "claudeSessionId" | "remoteUrl" | "costUsd" | "error">>,
): SessionRecord {
  const current = getSession(id);
  if (!current) throw new Error(`Unknown session ${id}`);
  const next: SessionRecord = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE sessions
     SET status = ?, claude_session_id = ?, remote_url = ?, cost_usd = ?, error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(next.status, next.claudeSessionId, next.remoteUrl, next.costUsd, next.error, next.updatedAt, id);
  return next;
}

export function markOrphansStopped(): void {
  db.prepare(
    `UPDATE sessions
     SET status = 'stopped', updated_at = ?, error = COALESCE(error, 'Server restarted while this session was running.')
     WHERE status IN ('starting', 'running', 'idle')`,
  ).run(new Date().toISOString());
}

export function appendTranscript(sessionId: string, body: string): { id: number; body: string; createdAt: string } {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO transcript (session_id, body, created_at) VALUES (?, ?, ?)")
    .run(sessionId, body, createdAt);
  return { id: Number(result.lastInsertRowid), body, createdAt };
}

export function listTranscript(sessionId: string): { id: number; body: string; createdAt: string }[] {
  return db
    .prepare(
      "SELECT id, body, created_at AS createdAt FROM transcript WHERE session_id = ? ORDER BY id ASC",
    )
    .all(sessionId) as { id: number; body: string; createdAt: string }[];
}
