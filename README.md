# Codex Workflows

[![CI](https://github.com/robzilla1738/Codex-Workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/robzilla1738/Codex-Workflows/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Buy me a coffee](https://img.shields.io/badge/support-Buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=000)](https://www.buymeacoffee.com/robcourson)

Claude Code has workflows. Codex has subagents, skills, plugins, and MCP.

`codex-workflows` connects those pieces into a workflow-as-code runtime for
Codex: durable multi-agent runs, a live terminal dashboard, restartable agents,
saved workflow scripts, and bug-finding templates that are meant to be used on
real repos.

This is not a native Codex `/workflows` command. Codex does not expose that
plugin API today. This project ships the closest available surface: a Codex
plugin with an MCP server and a `cwf` terminal UI.

## Install

Once this repo is public, install it as a Codex marketplace:

```bash
codex plugin marketplace add robzilla1738/Codex-Workflows
codex plugin add codex-workflows@codex-workflows
```

Start a new Codex thread after installing. Then ask:

```text
Use codex-workflows to run the bug-sweep workflow with adapter auto.
Open the live dashboard automatically and tell me the run id and status.
```

Codex will call the bundled MCP server. The server starts the workflow, opens
the live TUI in your default terminal, and returns a run id you can inspect
from Codex or from the CLI.

## What it includes

- `bug-sweep`: broad codebase review, adversarial verification, repro planning,
  and synthesis.
- `release-diff-review`: release-blocker review against a branch or diff.
- `security-auth-review`: auth, permission, injection, secret, sandbox, and MCP
  boundary review.
- Live dashboard with phases, agent rows, token/tool/time metrics, detail view,
  pause/resume/stop/restart/save controls, and final report path.
- Durable run state under `${CODEX_HOME:-~/.codex}/codex-workflows/projects/<project-hash>/runs/<run-id>/`
  by default, so read-only bug hunts do not dirty the target repo.
- Project-local storage remains available with `storageScope: "project"` or
  `--storage-scope project`.
- Isolated workflow script loading through QuickJS. Workflow scripts define
  phases and agent prompts; they do not get direct filesystem, shell, network,
  process, or Node built-in access.

## Model controls

You can route models globally or by phase/agent:

```text
Use codex-workflows to run bug-sweep with adapter auto,
model gpt-5.5, reasoning xhigh,
and modelMap {"find":"gpt-5.4-mini","synthesize":"gpt-5.5"}.
```

Caller overrides win over workflow defaults:

- `model`: default worker model.
- `reasoning`: default Codex reasoning effort.
- `modelMap`: phase id, agent id, or `phase:agent` overrides.
- `promptSuffix`: extra instruction appended to every worker.

Model names are validated against the local `codex debug models` catalog before
any agents launch. Short names such as `5.4-mini` are rejected with a suggestion
like `gpt-5.4-mini`; they are not silently rewritten.

Bug-finding workflows default to read-only workers unless a workflow explicitly
declares otherwise.

## Local development

```bash
pnpm install
pnpm validate:plugin
pnpm test
pnpm cwf validate workflows/bug-sweep.workflow.js
pnpm cwf run workflows/bug-sweep.workflow.js --watch --adapter simulate
pnpm cwf run workflows/bug-sweep.workflow.js --watch --adapter auto --model gpt-5.4-mini
```

Useful local commands:

```bash
pnpm cwf workflows
pnpm cwf watch <run-id>
pnpm cwf pause <run-id>
pnpm cwf resume <run-id>
pnpm cwf stop <run-id>
pnpm cwf stop-agent <run-id> <agent-id>
pnpm cwf restart-agent <run-id> <agent-id>
pnpm cwf save <run-id> --name release-diff-review-v2
```

The generated plugin lives at `plugins/codex-workflows`. Do not edit the bundled
`dist` files by hand. Change the TypeScript packages, then run:

```bash
pnpm validate:plugin
```

That builds the packages, regenerates the plugin bundle, and checks that no
machine-local paths leaked into the distributable plugin.

## Plugin layout

```text
.agents/plugins/marketplace.json
plugins/codex-workflows/
  .codex-plugin/plugin.json
  .mcp.json
  dist/
  skills/codex-workflows/SKILL.md
  workflows/*.workflow.js
```

The plugin bundle is committed so users can install from GitHub without running
`pnpm install`.

## Docs

- [Plugin distribution](docs/plugin-distribution.md)
- [Architecture](docs/architecture.md)
- [Claude workflows parity analysis](docs/claude-workflows-parity.md)

## Support

If this saves you time, you can support the work here:
[buymeacoffee.com/robcourson](https://www.buymeacoffee.com/robcourson).
