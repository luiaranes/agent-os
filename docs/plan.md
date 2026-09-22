# Agent OS plan

A local dashboard for Claude Code sessions, one project at a time. Each session turns on Remote Control so the Claude app on your phone can drive it. The machine hosting the session has to stay awake. Moving that host to an always-on VM is the last phase.

The custom phone app waits until this system is finished. Remote Control is how you reach a session until then.

## Tech stack

| Layer | Choice | Role |
| --- | --- | --- |
| Language | TypeScript on Node.js | Server, session supervisor, and the page script |
| Server | Fastify | HTTP API and the dashboard, bound to `127.0.0.1:4317` |
| UI | One static page in `public/` | Project and session screens. The server sends it as a file |
| Data | SQLite through `node:sqlite` | Projects, sessions, and transcript lines in `data/agent-os.sqlite` |
| Live updates | Server-sent events, plus a poll of `/api/state` | New transcript lines show up without a reload |
| Agent runtime | Claude Code CLI, `claude remote-control` | One process per session. The title is the name in the Claude app |
| Transcript | Claude's session file under `~/.claude/projects/` | The dashboard tails that file and stores the lines it shows |
| Account | Claude subscription, signed in with `claude` / `/login` | Remote Control uses that login. An API key does not register a phone session |

The Agent SDK package is installed and is not the session runtime. A session it starts does not register with Remote Control, so the server spawns the CLI instead.

Later phases stay on this stack. Encrypted agent environment variables are stored in SQLite. Phase 8 adds a CLI in this repo. Phase 9 runs the same server on a Linux VM. Object storage is added only when a session does not have the project folder.

## Architecture

```text
Browser (dashboard)
    │  create project, start session, read transcript
    ▼
Agent OS server (Fastify, this machine)
    │  one child process per live session
    ▼
claude remote-control --name "<title>"
    │  works in the project folder
    │  writes the transcript to ~/.claude/projects/
    ▼
Claude app and claude.ai/code
```

The server is the only process that starts and stops sessions. On create it spawns `claude remote-control` in the project folder, records the session in SQLite, and tails the session file. User and assistant text from that file are appended to the transcript and pushed to the page.

Remote Control keeps the phone attached to that same process. A message sent in the Claude app is written into the session file, and the tail picks it up. The laptop, and later the VM, is the machine that process runs on. Sleep or shutdown stops it.

One folder can host one Remote Control process. A second start in that folder is refused until the first process exits. Starting a session moves the previous bridge pointer aside so Claude creates a new named session instead of resuming the last one.

```text
project folder/
  repo files
  agent-os/          shared specs, plans, reviews, progress
~/.claude/projects/  Claude's own transcript for the session
data/agent-os.sqlite
  projects, sessions, transcript lines shown in the dashboard
```

## Running a session

Requirements on the host:

- Claude Code on `PATH`, recent enough to include `claude remote-control`.
- Signed in with `claude` / `/login` on a personal Pro, Max, Team, or Enterprise account. An organization can turn Remote Control off. The Sperling team login did that. The personal Pro login works. An API key does not.
- The project folder opened once in Claude Code so the workspace is trusted.
- The host stays awake and can reach Anthropic.

A session is started with `--permission-mode default`. Tool approval prompts go to the Claude app. The dashboard does not answer them.

The process inherits the host's Claude settings: user hooks, skills, plugins, and connected MCP servers. A new agent definition does not replace those until Phase 4 limits what a session loads.

Stopping the dashboard stops its child `claude remote-control` processes. On the next start, sessions left in `starting`, `running`, or `idle` are marked `stopped`. The transcript already stored in SQLite remains. `data/` is gitignored. Claude's own transcript stays under `~/.claude/projects/`.

Usage counts against the Claude plan. A Pro limit can stop a session even while the process is up. Phase 6 spend caps read the cost the session file already records.

## Security

The server listens on `127.0.0.1` only. The dashboard has no login. That is safe while the page is only reachable on this machine. Phase 9 adds access control before the same server is reachable from anywhere else. Session files and environment variables stay on the host. Agent secrets are encrypted in SQLite when Phase 4 stores them.

## What already works

- Create a session from the dashboard at `http://127.0.0.1:4317/`. It shows up in the Claude app under that title.
- Messages from the phone appear in the dashboard.
- One Remote Control process per folder. A second session in the same folder is refused until the first one stops.
- The laptop has to stay awake. Sleep pauses the session.

## How files are shared

Each project is one folder on the laptop, later on the VM. Two kinds of files sit there:

- The repo. Code the agents edit, and git history.
- A shared directory inside that folder, `agent-os/`, for work that passes between agents: specs, plans, reviews, and progress notes.

A session starts in that project folder, so every agent in the project sees the same disk. The plan agent writes `agent-os/plans/billing.md`. The implementer session starts later in the same folder and reads that file. The dashboard reads that same directory, and can open, edit, and download a file. The next session sees the edit because it is the same file.

An agent does not get the whole disk. Its definition lists folders:

| Grant | What the agent can do |
| --- | --- |
| Read | Open files in that folder |
| Write | Create and change files there |
| None | The folder is invisible to it |

Delete is not in the grant. Those rules are checked before the tool runs.

A task step names the files. The board does not pass the document around. The path does. Goals use the same directory for the progress log and the definition of done.

Object storage, such as Cloudflare R2, matters only when a session does not have this folder. While every session runs on this machine, the folder is the share. If a later session runs in a container or on another host, the same `agent-os/` paths sync to object storage and the grants stay the same.

## Phases

### Phase 1. Projects

Add a project from a folder. The home page lists projects. A project page shows only that project's sessions.

### Phase 2. Sessions

On the project page: hide failed runs, send a follow-up from the dashboard, reopen a session, show whether the Claude app is connected, and show the tool calls in the transcript, not only the final text.

### Phase 3. Shared files

Each project has an `agent-os/` directory for specs, plans, reviews, and progress notes. An agent gets read or write on specific folders. Delete is not granted. The project page can open, edit, and download those files.

### Phase 4. Agents

A project owns its agents. Each one has a name, model, prompt, skills, the tools and MCPs it may use, the file grants from Phase 3, and the other agents it may spawn. Environment variables for that agent are stored encrypted and injected when its session starts.

### Phase 5. Tasks

A board on the project: to do, doing, review, done. A task picks an agent, can run once or on a schedule, and can start from a template. Steps chain, and a step can require you to approve it before the next one starts. The template is where a flow like spec, plan, review, implement, and fix lives.

### Phase 6. Goals

A goal has a definition of done. After each session an orchestrator reads the shared files and starts the next agent until the checks pass. A goal has a spend cap, a time limit, and a stop when the same step repeats.

### Phase 7. Inbox and triggers

Agents write to an inbox on the project. You reply there, including a multiple-choice answer. A webhook or a cron run starts a task or a goal. Push to a separate phone app waits until this system is finished.

### Phase 8. The project as files

Agents, skills, and templates are YAML in the repo. A CLI pushes and pulls them, and can create a task or a goal from a local Claude session.

### Phase 9. Always on

Move this server to a Linux VM so sessions keep running when the laptop sleeps. Put access control on the dashboard before the port is reachable off that machine. If a session ever runs without this disk, the same `agent-os/` paths sync to object storage and the grants stay the same. Network limits and a fresh container per session belong here, because they only matter once the session is no longer on the shared folder.

## Later

A custom phone app, with its own push notifications, comes after these phases. Until then, the Claude app and Remote Control are the phone path.
