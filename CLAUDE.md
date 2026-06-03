# Claude instructions

This repo builds a Codex plugin, not a one-off demo. Treat generated artifacts,
plugin metadata, and install docs as part of the product.

## Project shape

- Source packages live under `packages/`.
- Built-in workflow templates live under `workflows/`.
- The installed plugin bundle is generated under `plugins/codex-workflows/`.
- Codex skill instructions live under `skills/codex-workflows/SKILL.md`.
- The repo marketplace is `.agents/plugins/marketplace.json`.

Do not edit `plugins/codex-workflows/dist/*` directly. Change source files,
then run `pnpm validate:plugin`.

## Commands

Use these before handing work back:

```bash
pnpm typecheck
pnpm test
pnpm validate:plugin
```

For a fast workflow smoke:

```bash
node plugins/codex-workflows/dist/cli.js validate workflows/bug-sweep.workflow.js --cwd /tmp
node plugins/codex-workflows/dist/cli.js run workflows/bug-sweep.workflow.js --cwd /tmp --adapter simulate --no-watch
```

For MCP smoke testing, start the generated server from
`plugins/codex-workflows` and call `workflow_validate`.

## Distribution rules

- Keep install docs pointed at `robzilla1738/Codex-Workflows`.
- Keep plugin names stable: marketplace `codex-workflows`, plugin
  `codex-workflows`.
- Keep the plugin bundle self-contained. Users should not need to run `pnpm`
  after installing from GitHub.
- Do not leave `/Users/...` paths, local cache paths, or machine-specific
  binaries in the plugin bundle.
- If package versions change, regenerate the plugin and commit the generated
  bundle.

## Runtime rules

- Workflow scripts are declarative. They define phases and worker prompts.
- Workflow scripts must not get direct filesystem, shell, network, process, or
  Node built-in access.
- Bug-finding workflows should default to read-only workers.
- Model overrides from the caller beat workflow defaults.
- Preserve durable run state under `.codex-workflows/runs/<run-id>/`.

## Writing style

Keep docs plain. Say what works, what does not, and how to verify it. Avoid
marketing filler, vague claims, and "official" language unless OpenAI has
actually accepted the plugin into a curated marketplace.
