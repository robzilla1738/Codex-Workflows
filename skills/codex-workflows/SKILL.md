---
name: codex-workflows
description: Run Claude-style dynamic workflows in Codex for large fanout, ultracode-style review, release diff review, deep research, adversarial verification, or multi-agent orchestration.
---

# Codex Workflows

Use this skill when the user asks to run a workflow, use ultracode-style effort,
fan out many agents, perform release diff review, run deep research, or save a
repeatable multi-agent process.

## Workflow

1. Prefer existing saved workflows under `.codex-workflows/workflows/` or the
   built-in workflows under `workflows/`.
2. Validate or preview unfamiliar workflows with `workflow_validate` or
   `workflow_preview` before launch.
3. Start the workflow through the `codex-workflows` MCP server when available.
4. Expect `workflow_run` to open the live terminal dashboard automatically in
   the user's default terminal. Pass `openTui: false` only when the user asks
   for a headless run.
5. Use `adapter: "auto"` for real Codex runs unless the user explicitly asks
   for `sdk`, `exec`, or `simulate`. Auto tries SDK first and falls back to
   `codex exec` when SDK cannot launch.
6. When the user names subagent models, pass them as Codex model slugs:
   - `model` sets the default worker model and overrides workflow-file models.
   - `reasoning` sets default Codex reasoning effort.
   - `modelMap` maps phase id, agent id, or `phase:agent` to a model.
   - `promptSuffix` appends user-specific output instructions to every worker.
   - If the user gives shorthand such as `5.4-mini`, use the full Codex slug
     if known, such as `gpt-5.4-mini`. The runtime validates model names before
     fanout and will return a clear error if the model is unavailable.
7. For read-only review, do not pass `approval: "deny"`. That denies workflow
   launch. Rely on read-only worker sandboxing and explicit no-mutation
   instructions in `promptSuffix`.
8. Use the system-default/wide terminal defaults unless the user asks otherwise:
   `terminalApp: "default"`, `terminalColumns: 190`, `terminalRows: 42`.
   The plugin accepts explicit terminal sizes up to 500 columns by 120 rows.
9. Store normal bug-hunt run artifacts in Codex home by default. Use
   `storageScope: "project"` only when the user asks for project-local run
   logs or when saving a reusable workflow.
10. If MCP is unavailable in an installed plugin, ask the user to restart Codex
   or reinstall/enable the plugin before running workflows. Use the repo-local
   `pnpm cwf` CLI only when working inside the `codex-workflows` source repo.
11. Keep the main Codex thread concise. Poll status and summarize progress
   instead of pasting raw worker logs. The dashboard shows recent worker
   activity live, but exact token totals may remain pending until Codex emits
   usage metadata.
12. For bug finding, default to the bounded
    `workflows/bug-sweep.workflow.js`.
    Use `workflows/bug-sweep-deep.workflow.js` only when the user explicitly
    asks for a larger or deeper fanout.
13. For release review, default to `workflows/release-diff-review.workflow.js`.
14. For security review, default to `workflows/security-auth-review.workflow.js`.
15. Before write-capable workflows, state the sandbox mode and ask for approval.

## Source Repo CLI Fallback

Use this only when the current working directory is the `codex-workflows`
source checkout. Installed plugin users should use the MCP tools.

```bash
pnpm cwf validate workflows/bug-sweep.workflow.js
pnpm cwf run workflows/bug-sweep.workflow.js --watch \
  --adapter auto \
  --model gpt-5.5 \
  --reasoning xhigh \
  --model-map '{"find":"gpt-5.5-mini","synthesize":"gpt-5.5"}'
pnpm cwf watch <run-id>
pnpm cwf save <run-id> --name release-diff-review-v2
```

## Safety

Workflow scripts do not get direct filesystem, shell, network, process, or Node
built-in access. They define phases and agent prompts. The runtime launches
Codex workers under explicit sandbox and approval settings.
