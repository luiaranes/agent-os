# Agent OS

A local dashboard for Claude Code sessions on this machine. Add a project from a folder, start a session in that folder, and read the transcript in the browser. A session runs `claude remote-control` so the Claude app can attach. The machine has to stay awake.

## Run

You need Node.js with the built-in `node:sqlite` module, and Claude Code on `PATH` with `claude remote-control`. Sign in with `claude` / `/login`. An API key does not register a phone session.

```sh
npm install
npm run dev
```

The server listens on `127.0.0.1` and port `4317` unless `PORT` is set. Open http://127.0.0.1:4317.

`npm run typecheck` runs the TypeScript check.

The dashboard has no login. It is only on this machine.

## What you can do

**Home.** The folder field starts as the server's working directory. Enter a folder that exists and add the project. The name is that folder's basename. The page lists projects. A folder that is already a project is rejected.

**Project** (`#` plus the project id). Start a session with a title and an optional prompt. The prompt is stored and shown on the session. It is not passed to the spawned `claude remote-control` process. The list is only that project's sessions. Select one to see its status and transcript. The transcript updates while the server is running. Stop ends a session that is starting, running, or idle. When Remote Control prints a session link, the page shows it.

The top of the page reports whether `claude remote-control` is available.

## Sessions

Start spawns `claude remote-control` in the project folder. The title is the session name (`--name`). The process uses `--permission-mode default`, so tool approval prompts go to the Claude app.

Sleep or shutdown stops the process. Quit the dashboard and those child processes stop with it. The next time the server starts, sessions still marked `starting`, `running`, or `idle` are marked `stopped`. Transcript lines already stored stay.

## Data

Projects, sessions, and transcript lines are SQLite through `node:sqlite` at `data/agent-os.sqlite`. The server creates `data/` on startup. `data/` is gitignored. Claude's own transcript stays under `~/.claude/projects/`.

Later work is listed in `docs/plan.md`.
