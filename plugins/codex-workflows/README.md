# Codex Workflows Plugin

This directory is the distributable Codex plugin bundle generated from the monorepo root.
Do not edit the bundled `dist/` files by hand. Change the source packages and run `pnpm validate:plugin` from the repo root.

Install from the repository marketplace:

```bash
codex plugin marketplace add robzilla1738/Codex-Workflows
codex plugin add codex-workflows@codex-workflows
```

The plugin includes bundled MCP and CLI entrypoints under `dist/`, the `codex-workflows` skill, and the built-in review workflow templates.
