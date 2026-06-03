# Claude Code Dynamic Workflows to Codex Parity

Date: 2026-06-03

This document analyzes Claude Code dynamic workflows and maps them to a Codex implementation that can be open-sourced on GitHub.

Primary sources:

- Claude Code dynamic workflows docs: https://code.claude.com/docs/en/workflows
- Claude dynamic workflows launch blog: https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- Claude custom subagents docs: https://code.claude.com/docs/en/sub-agents
- Codex manual: https://developers.openai.com/codex/codex-manual.md

## Executive decision

Build this as a Codex plugin, not as a skill alone.

A skill can teach Codex when to use a workflow and can carry scripts, examples, and templates. It cannot provide a durable background runtime, job registry, progress UI, pause/resume controls, token accounting, saved workflow management, or a JavaScript orchestration sandbox. Codex docs describe skills as the authoring format for reusable workflows and plugins as the installable distribution unit for reusable skills, apps, MCP servers, and related integrations.

The open-source artifact should therefore be:

```text
codex-workflows/
  .codex-plugin/plugin.json
  skills/codex-workflows/SKILL.md
  mcp-server/
  packages/runtime/
  packages/cli/
  workflows/deep-research.workflow.js
  schemas/
  examples/
  docs/
```

The plugin bundles the skill plus an MCP server. The MCP server starts and manages workflow runs. The runtime executes approved JavaScript workflow scripts. The CLI gives users the missing native workflow UI as `cwf workflows`, `cwf watch`, `cwf run`, and `cwf save`.

## What Claude Code ships

Claude dynamic workflows are a workflow-as-code runtime:

- Triggered by `/deep-research`, saved workflow commands, natural language like "use a workflow", the `ultracode` keyword, or `/effort ultracode`.
- Claude writes a JavaScript script for the requested task.
- The script runs in an isolated environment, separate from the main conversation.
- The script can coordinate many subagents while storing intermediate results in script variables instead of the conversation context.
- Runs execute in the background while the session remains responsive.
- A workflow progress view lists phases, agent counts, token totals, elapsed time, agent details, recent tool calls, pause/resume, stop, restart, and save controls.
- Saved workflows live in `.claude/workflows/` or `~/.claude/workflows/` and become slash commands.
- Saved workflows receive structured input through a global `args`.
- The runtime has guardrails: no direct filesystem or shell access from the workflow script, no mid-run user input, up to 16 concurrent agents, and up to 1,000 agents total per run.
- A run can resume after a pause inside the same Claude session. Completed agents return cached results.
- The launch prompt shows planned phases and lets the user run once, trust the workflow for that project, view the raw script, or cancel.

The key idea is that the plan moves from the model's conversational context into deterministic code. The model still writes and runs agents, but loops, branching, fan-out, voting, and intermediate state live in the script.

## Codex primitives we can reuse

Codex already has most of the lower-level pieces:

- Skills: reusable task instructions with optional scripts and references.
- Plugins: the distribution unit for skills, MCP servers, and integrations.
- Subagents: Codex can spawn specialized parallel agents, surface activity in CLI/app, and inspect active agent threads with `/agent`.
- Custom agents: project or user TOML files can define agent roles, model, reasoning effort, sandbox mode, MCP servers, and skill config.
- App server and SDK: programmatic APIs can start/resume threads, run turns, stream agent events, and set sandbox presets.
- `codex exec --json`: a scriptable fallback that emits JSONL events including turns, tool calls, file changes, agent messages, and token usage.
- Hooks and rules: useful for policy, trust, logging, and lifecycle integration, but not enough to build the workflow runtime by themselves.

## Parity table

| Claude feature | Codex open-source equivalent | Parity |
| --- | --- | --- |
| Claude writes JS workflow scripts | Skill instructs Codex to generate a `.workflow.js` script against our DSL | Full |
| Isolated JS runtime | `packages/runtime` runs scripts in QuickJS or another JS isolate with only approved host APIs | Full |
| Script cannot use shell/fs directly | Runtime exposes no Node APIs, only workflow host functions | Full |
| Spawn subagents | Runtime uses Codex SDK/app-server or `codex exec --json` workers | Full |
| Dozens/hundreds of agents | Configurable scheduler with defaults matching Claude: 16 concurrent, 1,000 total | Full |
| Script variables hold intermediate results | Workflow process owns state and checkpoints outside main conversation | Full |
| Background run keeps main session responsive | MCP tool starts daemonized run and returns a run id | Full in plugin path |
| `/workflows` native UI | External CLI TUI: `cwf workflows` and `cwf watch <run>` | Partial |
| Native task panel / side pane | External TUI plus MCP `workflow_status` summaries | Partial |
| Pause/resume/stop/restart | Runtime job controller and agent process control | Full |
| Resume completed agents from cache | Persist each agent result and checkpoint in run state | Full, can exceed Claude by resuming across sessions |
| Phase list, agent counts, token totals, elapsed | Runtime event log plus app-server/exec usage events | Full |
| Drill into prompt, tool calls, result | Persist worker prompts, JSONL event stream, final output, patches | Full |
| Save workflow as command | Generate a project/user skill plus optional local custom prompt | Mostly full |
| Saved slash command `/<name>` | Native Codex plugin cannot mint arbitrary slash commands today; generated skill is invoked through skill UI / `$name` | Partial |
| `args` global | Runtime injects frozen structured `args` into JS context | Full |
| `/deep-research` bundled workflow | Ship `workflows/deep-research.workflow.js` and a matching skill entry | Mostly full |
| `ultracode` keyword | Skill description triggers on `ultracode` and "use a workflow" | Mostly full |
| `/effort ultracode` auto mode | Not available through plugin API today | Not full |
| Per-run approval card | Skill-driven approval prompt plus trust store keyed by workflow hash, cwd, and capabilities | Mostly full |
| File edits auto-approved in subagents | Use explicit Codex sandbox/approval profile per worker; do not silently bypass parent policy | Partial by design |
| Disable workflows | `CODEX_WORKFLOWS_DISABLE=1`, config file, and plugin disable | Full |

## The exact product shape

The user-facing commands should be:

```bash
cwf run workflows/deep-research.workflow.js --args '{"question":"..."}'
cwf workflows
cwf watch <run-id>
cwf pause <run-id>
cwf resume <run-id>
cwf stop <run-id>
cwf restart-agent <run-id> <agent-id>
cwf save <run-id> --name branch-review --scope project
```

The Codex-facing MCP tools should be:

```text
workflow_create_script(prompt, constraints) -> { script_path, manifest }
workflow_run(script_path, args, options) -> { run_id }
workflow_status(run_id) -> summary
workflow_events(run_id, cursor?) -> events
workflow_agent_detail(run_id, agent_id) -> prompt, recent_events, result
workflow_pause(run_id)
workflow_resume(run_id)
workflow_stop(run_id)
workflow_restart_agent(run_id, agent_id)
workflow_save(run_id, name, scope)
workflow_list()
```

The skill should teach Codex:

- When the user says "use a workflow", "ultracode", "deep research", "fan out", "parallel agents", "adversarial verification", or asks for dozens of independent checks, use the plugin.
- First draft a workflow script and manifest.
- Show the user the phase list, max concurrency, agent cap, capability requirements, and script path.
- Ask for approval before launching unless the workflow hash is already trusted.
- Start the workflow through MCP, then keep the main thread concise by polling status rather than pasting raw worker logs.
- Report the final synthesis only after verifier/synthesis phases finish.

## Workflow script API

Use a small DSL that mirrors Claude's model while staying vendor-neutral:

```js
export default workflow({
  name: "branch-review",
  version: "1",
  maxConcurrency: 16,
  maxAgents: 1000,
  async run({ args, agent, phase, checkpoint, budget }) {
    const files = args.files;

    const findings = await phase("review", async () => {
      return mapLimit(files, 16, async (file) => {
        return agent({
          role: "reviewer",
          prompt: `Review ${file} for correctness, security, and test gaps.`,
          sandbox: "read-only",
          outputSchema: "schemas/finding.schema.json"
        });
      });
    });

    const verified = await phase("verify", async () => {
      return mapLimit(findings, 16, async (finding) => {
        return agent({
          role: "verifier",
          prompt: "Adversarially verify this finding against the codebase.",
          input: finding,
          sandbox: "read-only"
        });
      });
    });

    return synthesize({ findings, verified });
  }
});
```

Host APIs:

- `agent(spec)`: start one Codex worker and return structured result.
- `agents(specs)`: run many workers under scheduler control.
- `phase(name, fn)`: record phase boundaries, elapsed time, counts, tokens, and errors.
- `checkpoint(key, value)`: persist resumable state.
- `mapLimit(items, limit, fn)`: deterministic fan-out helper.
- `budget.reserve()` / `budget.used()`: enforce token and agent count caps.
- `emit(event)`: publish progress events for TUI and MCP status.

Not exposed:

- `fs`
- `child_process`
- raw network APIs
- process environment
- dynamic imports
- Node built-ins

## Runtime design

Use a supervisor process:

1. Load and validate the workflow script.
2. Evaluate it in an isolate with only the DSL globals.
3. Build a manifest: name, phases, max concurrency, estimated agent count, worker roles, required tools, sandbox needs, and write permissions.
4. Require approval for the script hash and capabilities.
5. Execute phases.
6. Spawn workers through Codex SDK/app-server, with `codex exec --json` as fallback.
7. Persist all events to the run store, defaulting to
   `${CODEX_HOME:-~/.codex}/codex-workflows/projects/<project-hash>/runs/<run-id>/events.jsonl`
   so read-only runs do not dirty target repos.
8. Persist checkpoints, agent results, token usage, patches, and final report.
9. Expose status through MCP and the `cwf` CLI.

Suggested project-local run directory when `storageScope: "project"` is used:

```text
.codex-workflows/runs/2026-06-03T20-12-48Z-abc123/
  manifest.json
  script.workflow.js
  args.json
  status.json
  checkpoints.json
  events.jsonl
  agents/
    agent-001/
      prompt.md
      events.jsonl
      result.json
      usage.json
      patch.diff
  final.md
```

## Write-heavy workflows

For coding migrations, run write-capable agents in git worktrees:

1. Runtime creates one temporary worktree per implementation agent.
2. Worker runs with `workspace-write` inside that worktree.
3. Runtime captures patch and test evidence.
4. A verifier agent reviews each patch.
5. Runtime applies non-conflicting patches to the parent checkout only after approval.
6. Conflicting patches are summarized for the main Codex thread instead of being applied automatically.

This gives us Claude's worktree isolation behavior without depending on Codex core to isolate each worker.

## Saved workflows

Saving a run should create:

```text
.agents/skills/<name>/SKILL.md
.codex-workflows/workflows/<name>.workflow.js
```

The generated skill calls the saved script through MCP. This is the shareable Codex-native equivalent of `.claude/workflows/<name>` becoming `/<name>`.

For local-only slash parity, optionally also generate a deprecated custom prompt in `~/.codex/prompts/<name>.md` that says:

```md
---
description: Run saved workflow <name>
argument-hint: [ARGS_JSON]
---

Use the codex-workflows skill to run saved workflow <name> with args: $ARGUMENTS
```

Do not rely on custom prompts for GitHub distribution because Codex docs mark them deprecated and local-user scoped.

## Open-source positioning

Repository name: `Codex-Workflows`

Tagline: "Workflow-as-code orchestration for Codex."

License: MIT.

Do not market it as an Anthropic or Claude compatibility layer. The honest positioning is:

- Inspired by dynamic workflow patterns.
- Built for Codex extension surfaces.
- Vendor-neutral workflow scripts where possible.
- Uses OpenAI Codex SDK/app-server/CLI for worker execution.

## Milestones

### M0: Spec and scaffold

- Write public README, parity doc, and architecture doc.
- Add plugin manifest, skill stub, and marketplace test file.
- Define workflow script schema and run-state schema.

### M1: Local runtime

- Implement JS isolate.
- Implement `phase`, `agent`, `agents`, `mapLimit`, `checkpoint`, and `emit`.
- Implement run-state persistence and resume from checkpoints.
- Implement CLI run/list/watch/pause/stop.

### M2: Codex workers

- Implement worker adapter through `@openai/codex-sdk`.
- Add fallback adapter using `codex exec --json`.
- Track token usage and worker event logs.
- Add read-only research workflows.

### M3: Plugin integration

- Add MCP server tools.
- Bundle skill and MCP server in plugin.
- Add local marketplace entry.
- Verify install in Codex CLI and app.

### M4: Deep research parity

- Ship `deep-research.workflow.js`.
- Fan out search angles.
- Fetch and summarize sources.
- Run adversarial claim verification.
- Produce cited report with unsupported claims filtered out.

### M5: Write-heavy workflows

- Add git worktree manager.
- Capture and review patches.
- Add merge/apply policy.
- Add conflict handling.

### M6: Public release

- CI on macOS and Linux.
- Golden tests for workflow scripts.
- Runtime security tests proving no fs/shell access from scripts.
- Demo GIF or asciinema.
- Publish GitHub repo and install instructions.

## Main risk

The only major non-parity area is Codex native UI. A plugin can bundle skills and MCP servers, and a skill can appear in Codex's skill surfaces, but current public Codex plugin docs do not describe a way to add arbitrary native slash commands, a `/workflows` browser, `/effort ultracode`, or a task-panel progress UI. We can match the runtime behavior and expose equivalent controls through MCP plus a CLI TUI. True native UI parity would require Codex core changes or a future plugin UI API.

## Recommendation

Proceed with the plugin-plus-runtime design.

Do not spend time on a skill-only implementation except as a thin trigger layer. It will look like a prompt recipe, not like Claude workflows. The runtime is the product: JavaScript orchestration, Codex worker spawning, resumable state, progress inspection, approval/trust, saved workflow packaging, and a bundled deep-research workflow.
