# Architecture

Codex Workflows has two jobs:

1. Let Codex start and inspect durable workflow runs through MCP.
2. Give users a terminal dashboard that feels close to Claude Code workflows.

The code is split so those two jobs do not get tangled.

## Packages

- `@codex-workflows/schemas`: Zod schemas and TypeScript types for workflows,
  runs, agents, phases, events, and controls.
- `@codex-workflows/codex-adapter`: workers for simulated runs, `codex exec
  --json`, and the Codex SDK.
- `@codex-workflows/runtime`: workflow loading, QuickJS validation, scheduling,
  events, checkpoints, saved workflows, and final reports.
- `@codex-workflows/cli`: the `cwf` command and Ink dashboard.
- `@codex-workflows/mcp-server`: MCP tools Codex calls from the plugin.

## Run state

By default, read-only workflow runs write under
`${CODEX_HOME:-~/.codex}/codex-workflows/projects/<project-hash>/runs/<run-id>/`
so bug hunts do not dirty the target checkout. Project-local storage is still
available with `storageScope: "project"` or `--storage-scope project`, and
legacy `.codex-workflows/runs/<run-id>/` directories remain readable.

Each run directory contains:

- `manifest.json`: workflow definition, args, and launch options.
- `status.json`: current summary for the TUI and MCP status calls.
- `events.jsonl`: append-only event history.
- `control.json`: pause, resume, stop, stop-agent, or restart-agent requests.
- `agents/<agent-id>/`: worker prompt and result files.
- `final.md`: final report.

The dashboard reads `status.json` and `events.jsonl`, so it can attach to a run
started by either the CLI or MCP server.

MCP launches use a detached worker process. That matters: a workflow should keep
running if the Codex thread disconnects or the MCP request finishes.
Detached workers write heartbeats into `status.json`; status/list/dashboard
reads reconcile stale runs when the recorded runner process is gone and the
heartbeat has aged out.

## Resume and restart

Completed agent results are cached in `status.json` and
`agents/<agent-id>/result.json`.

Resume skips completed agents and reruns work that is pending, failed,
cancelled, or explicitly restarted. `restart-agent` marks one agent pending and
relaunches the workflow in resume mode.

## Workflow scripts

Workflow scripts are loaded in QuickJS. The script can define workflow metadata,
phases, and agent prompts. It does not get Node globals, direct filesystem
access, shell access, network access, process env, or dynamic imports.
Workflow definitions may request up to 64 concurrent workers and 2000 total
agents; the actual worker count is still determined by the agents declared in
the workflow phases.

Actual code review work happens in Codex worker adapters, under explicit sandbox
and approval settings.

Agents may declare `contextFrom` to receive prior phase findings. Built-in
workflows use that for verify, probe, and synthesize phases so later agents
review concrete earlier claims instead of generic instructions.

## Generated plugin

`pnpm validate:plugin` builds the TypeScript packages, bundles the CLI and MCP
server into `plugins/codex-workflows/dist`, copies the built-in workflows and
skill, and validates the final plugin shape.

The generated plugin is committed so a GitHub marketplace install works without
asking users to build anything locally.
