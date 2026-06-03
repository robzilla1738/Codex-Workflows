# Contributing

Thanks for taking a look.

This project has two layers:

- Source code under `packages/`, `workflows/`, and `skills/`.
- The generated Codex plugin under `plugins/codex-workflows/`.

Change the source layer first. Then regenerate the plugin:

```bash
pnpm validate:plugin
```

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm validate:plugin
```

For plugin changes, also smoke the generated CLI:

```bash
node plugins/codex-workflows/dist/cli.js validate workflows/bug-sweep.workflow.js --cwd /tmp
node plugins/codex-workflows/dist/cli.js run workflows/bug-sweep.workflow.js --cwd /tmp --adapter simulate --no-watch
```

Keep docs specific. Avoid claiming this is an OpenAI-curated plugin unless that
actually happens. Today it is a GitHub-installable Codex marketplace plugin.
