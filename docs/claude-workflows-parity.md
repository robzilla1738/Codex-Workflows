# Claude Code workflow parity notes

Date: 2026-06-03
Last checked: 2026-06-05

This is a design note, not the install guide. It explains which Claude Code
workflow ideas this project borrows, what Codex can support today, and where the
current plugin still differs.

For current install and release steps, use [plugin distribution](plugin-distribution.md).

## Current shipped state

The repo now ships a GitHub-installable Codex marketplace plugin named
`codex-workflows`.

The generated plugin bundle lives under `plugins/codex-workflows/` and includes:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- bundled CLI and MCP server files under `dist/`
- `skills/codex-workflows/SKILL.md`
- built-in workflows under `workflows/`

The built-in workflow templates are:

- `bug-sweep.workflow.js`
- `bug-sweep-deep.workflow.js`
- `release-diff-review.workflow.js`
- `security-auth-review.workflow.js`

There is not a bundled `deep-research.workflow.js` template in the current
repo.

## What this plugin matches

Claude Code dynamic workflows move repeatable multi-agent work out of the main
chat and into a scriptable workflow runtime. `codex-workflows` follows that
shape where Codex exposes enough surface area:

- JavaScript workflow definitions describe phases and worker prompts.
- Workflow scripts run in QuickJS without direct filesystem, shell, network,
  process, or Node built-in access.
- Workers run through Codex adapters, with `adapter: "auto"` trying the SDK path
  and falling back to `codex exec`.
- Runs persist status, events, worker prompts, worker results, controls, and a
  final report.
- MCP tools let Codex start, inspect, pause, resume, stop, restart, save, and
  list runs.
- The CLI provides a live terminal dashboard through `cwf watch`.
- Normal run state defaults to
  `${CODEX_HOME:-~/.codex}/codex-workflows/projects/<project-hash>/runs/<run-id>/`
  so read-only runs do not dirty the target repo.

## What remains different

This is not a native Codex `/workflows` command. Current public Codex surfaces
support skills, plugins, MCP tools, custom CLIs, and repeatable workflows saved
as skills, but they do not document a plugin API for adding a native workflows
browser, arbitrary slash commands, `/effort ultracode`, or an in-app task panel.

The practical replacement is:

- use the `codex-workflows` skill as the trigger layer
- start runs through the bundled MCP server
- inspect progress through MCP status calls or the `cwf` terminal dashboard
- save reusable runs as project workflow files and skills

That is less integrated than Claude Code's native panel. It is also honest about
what Codex plugins can do today.

## Current user-facing commands

```bash
cwf workflows
cwf validate workflows/bug-sweep.workflow.js
cwf run workflows/bug-sweep.workflow.js --adapter auto --watch
cwf watch <run-id>
cwf pause <run-id>
cwf resume <run-id>
cwf stop <run-id>
cwf stop-agent <run-id> <agent-id>
cwf restart-agent <run-id> <agent-id>
cwf save <run-id> --name release-diff-review-v2
```

Installed plugin users normally do not call the CLI directly. They start a new
Codex thread and ask Codex to use the `codex-workflows` plugin.

Example:

```text
Use codex-workflows to run the bug-sweep workflow with adapter auto.
Open the live dashboard automatically and tell me the run id and status.
```

## Current MCP tools

The bundled MCP server exposes:

```text
workflow_run
workflow_validate
workflow_preview
workflow_status
workflow_events
workflow_agent_detail
workflow_pause
workflow_resume
workflow_stop
workflow_stop_agent
workflow_restart_agent
workflow_save
workflow_list
```

Earlier design sketches mentioned `workflow_create_script`. That tool is not in
the current server.

## Runtime rules

Workflow scripts are declarative. They define metadata, phases, agents, and
context flow. They do not get direct access to host capabilities.

Workers do the actual repo inspection or code review under explicit Codex
sandbox and approval settings. Bug-finding workflows should stay read-only by
default. Write-capable workflows need a separate approval path and should state
their sandbox mode before launch.

Caller model overrides beat workflow defaults:

- `model`
- `reasoning`
- `modelMap`
- `promptSuffix`

Model names are checked against the local Codex model catalog before agents
launch. Short aliases such as `5.4-mini` are rejected with a full-slug
suggestion when one is available.

## Product position

Repository name: `Codex-Workflows`

Tagline: "Workflow-as-code orchestration for Codex."

License: MIT.

This should not be described as an OpenAI-curated plugin unless that happens. It
is a GitHub-installable Codex marketplace plugin with a bundled MCP server,
skill, CLI dashboard, and review workflow templates.

It is fair to say the design is inspired by Claude Code dynamic workflows. It is
not a Claude compatibility layer.

## Practical next work

The main gaps are straightforward:

- Add golden tests for built-in workflow templates.
- Add more runtime isolation tests.
- Add a real MCP smoke script that starts `plugins/codex-workflows` and calls
  `workflow_validate`.
- Add write-capable workflows only after worktree isolation and patch review are
  implemented.
- Add a research workflow only when it can fetch, cite, and verify sources
  reliably.
