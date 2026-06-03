# Plugin distribution

This repo is a Codex marketplace. The plugin users install is generated under
`plugins/codex-workflows`.

The bundle includes:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `dist/cli.js`
- `dist/mcp-server.js`
- `dist/emscripten-module.wasm`
- `skills/codex-workflows/SKILL.md`
- `workflows/*.workflow.js`

Users should be able to install from GitHub without cloning the repo or running
`pnpm`.

## Public install

```bash
codex plugin marketplace add robzilla1738/Codex-Workflows
codex plugin add codex-workflows@codex-workflows
```

Pinned install:

```bash
codex plugin marketplace add robzilla1738/Codex-Workflows --ref v0.1.0
codex plugin add codex-workflows@codex-workflows
```

After installing, start a new Codex thread and ask:

```text
Use codex-workflows to run the bug-sweep workflow with adapter sdk.
Open the live dashboard automatically and tell me the run id.
```

## Local install while developing

```bash
pnpm validate:plugin
codex plugin marketplace add /absolute/path/to/Codex-Workflows
codex plugin add codex-workflows@codex-workflows
```

If Codex already knows about the marketplace:

```bash
codex plugin marketplace upgrade codex-workflows
codex plugin add codex-workflows@codex-workflows
```

Start a new Codex thread after reinstalling. Existing threads do not always
reload plugin skills and MCP tools.

## Release checklist

1. Update the version in `package.json`.
2. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm validate:plugin
   ```

3. Confirm `plugins/codex-workflows/.codex-plugin/plugin.json` has the same
   version.
4. Smoke the generated plugin CLI:

   ```bash
   node plugins/codex-workflows/dist/cli.js validate workflows/bug-sweep.workflow.js --cwd /tmp
   node plugins/codex-workflows/dist/cli.js run workflows/bug-sweep.workflow.js --cwd /tmp --adapter simulate --no-watch
   ```

5. Smoke the generated MCP server from `plugins/codex-workflows`.
6. Run at least one real `adapter: sdk` workflow before tagging a release.
7. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

8. Verify the pinned GitHub marketplace install from a clean Codex session.

## OpenAI-curated plugin status

This project is packaged like a production Codex plugin, but the OpenAI-curated
plugin directory is not self-serve in the public Codex docs. If OpenAI accepts
it later, this repo should already have the pieces they need: a marketplace,
plugin manifest, bundled MCP server, skill, CI, license, and a repeatable
validation command.
