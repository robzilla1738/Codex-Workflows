#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pluginRoot = path.join(repoRoot, "plugins", "codex-workflows");
const distDir = path.join(pluginRoot, "dist");
const packageJson = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(repoRoot, "package.json"), "utf8")
  )
);

const commonBuildOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  logLevel: "info",
  banner: {
    js: "import { createRequire as __codexWorkflowsCreateRequire } from 'node:module';\nconst require = __codexWorkflowsCreateRequire(import.meta.url);"
  },
  plugins: [
    {
      name: "react-devtools-core-shim",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "codex-workflows-shims"
        }));
        build.onLoad({ filter: /.*/, namespace: "codex-workflows-shims" }, () => ({
          contents:
            "export default { initialize() {}, connectToDevTools() {} };",
          loader: "js"
        }));
      }
    }
  ],
  external: []
};

await rm(pluginRoot, { recursive: true, force: true });
await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
await mkdir(distDir, { recursive: true });

await Promise.all([
  build({
    ...commonBuildOptions,
    entryPoints: [path.join(repoRoot, "packages", "mcp-server", "src", "index.ts")],
    outfile: path.join(distDir, "mcp-server.js")
  }),
  build({
    ...commonBuildOptions,
    entryPoints: [path.join(repoRoot, "packages", "cli", "src", "index.tsx")],
    outfile: path.join(distDir, "cli.js")
  })
]);

await cp(
  path.join(
    path.dirname(require.resolve("@jitl/quickjs-wasmfile-release-sync")),
    "emscripten-module.wasm"
  ),
  path.join(distDir, "emscripten-module.wasm")
);

await cp(path.join(repoRoot, "skills"), path.join(pluginRoot, "skills"), {
  recursive: true
});
await cp(path.join(repoRoot, "workflows"), path.join(pluginRoot, "workflows"), {
  recursive: true
});
await cp(path.join(repoRoot, "LICENSE"), path.join(pluginRoot, "LICENSE"));

await writeFile(
  path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  `${JSON.stringify(
    {
      name: "codex-workflows",
      version: packageJson.version,
      description: "Workflow-as-code orchestration for Codex.",
      author: {
        name: "Robert Courson"
      },
      license: "MIT",
      repository: "https://github.com/robzilla1738/Codex-Workflows",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "Codex Workflows",
        shortDescription: "Run Claude-style dynamic workflows in Codex.",
        longDescription:
          "Codex Workflows runs JavaScript workflow definitions, starts Codex workers, exposes MCP tools, and opens a live terminal dashboard for multi-agent review work.",
        developerName: "Robert Courson",
        category: "Productivity",
        capabilities: [
          "workflow orchestration",
          "multi-agent fanout",
          "terminal dashboard",
          "MCP tools"
        ],
        defaultPrompt: "Use codex-workflows to run a workflow."
      }
    },
    null,
    2
  )}\n`
);

await writeFile(
  path.join(pluginRoot, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        "codex-workflows": {
          command: "node",
          args: ["dist/mcp-server.js"],
          cwd: ".",
          startup_timeout_sec: 20,
          tool_timeout_sec: 600
        }
      }
    },
    null,
    2
  )}\n`
);

await writeFile(
  path.join(pluginRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "codex-workflows-plugin",
      version: packageJson.version,
      private: true,
      type: "module",
      license: "MIT"
    },
    null,
    2
  )}\n`
);

await writeFile(
  path.join(pluginRoot, "README.md"),
  [
    "# Codex Workflows Plugin",
    "",
    "This directory is the distributable Codex plugin bundle generated from the monorepo root.",
    "",
    "Install from the repository marketplace:",
    "",
    "```bash",
    "codex plugin marketplace add robzilla1738/Codex-Workflows",
    "codex plugin add codex-workflows@codex-workflows",
    "```",
    "",
    "The plugin includes bundled MCP and CLI entrypoints under `dist/`, the `codex-workflows` skill, and built-in workflow templates.",
    ""
  ].join("\n")
);

console.log(`Built plugin bundle at ${pluginRoot}`);
