#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "codex-workflows");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");

const errors = [];

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(repoRoot, file)} is not valid JSON: ${error.message}`);
    return null;
  }
};

const assertFile = async (file) => {
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      errors.push(`${path.relative(repoRoot, file)} is not a file`);
    }
  } catch {
    errors.push(`${path.relative(repoRoot, file)} is missing`);
  }
};

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
};

await Promise.all([
  assertFile(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
  assertFile(path.join(pluginRoot, ".mcp.json")),
  assertFile(path.join(pluginRoot, "package.json")),
  assertFile(path.join(pluginRoot, "dist", "mcp-server.js")),
  assertFile(path.join(pluginRoot, "dist", "cli.js")),
  assertFile(path.join(pluginRoot, "dist", "emscripten-module.wasm")),
  assertFile(path.join(pluginRoot, "skills", "codex-workflows", "SKILL.md")),
  assertFile(path.join(pluginRoot, "workflows", "bug-sweep.workflow.js")),
  assertFile(path.join(pluginRoot, "workflows", "bug-sweep-deep.workflow.js")),
  assertFile(path.join(pluginRoot, "workflows", "release-diff-review.workflow.js")),
  assertFile(path.join(pluginRoot, "workflows", "security-auth-review.workflow.js"))
]);

const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
if (manifest) {
  if (manifest.name !== "codex-workflows") {
    errors.push("plugin.json name must be codex-workflows");
  }
  if (manifest.mcpServers !== "./.mcp.json") {
    errors.push("plugin.json mcpServers must point to ./.mcp.json");
  }
  if (manifest.skills !== "./skills/") {
    errors.push("plugin.json skills must point to ./skills/");
  }
  if (manifest.license !== "MIT") {
    errors.push("plugin.json license must be MIT");
  }
}

const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
const server = mcpConfig?.mcpServers?.["codex-workflows"];
if (!server) {
  errors.push(".mcp.json must define mcpServers.codex-workflows");
} else {
  if (server.command !== "node") {
    errors.push(".mcp.json command must be node");
  }
  if (JSON.stringify(server.args) !== JSON.stringify(["dist/mcp-server.js"])) {
    errors.push(".mcp.json args must be [\"dist/mcp-server.js\"]");
  }
  if (server.cwd !== ".") {
    errors.push(".mcp.json cwd must be relative plugin root '.'");
  }
}

const marketplace = await readJson(marketplacePath);
const entry = marketplace?.plugins?.find?.((item) => item.name === "codex-workflows");
if (!entry) {
  errors.push(".agents/plugins/marketplace.json must include codex-workflows");
} else {
  if (entry.source?.path !== "./plugins/codex-workflows") {
    errors.push("marketplace source.path must be ./plugins/codex-workflows");
  }
  if (entry.policy?.installation !== "AVAILABLE") {
    errors.push("marketplace policy.installation must be AVAILABLE");
  }
  if (entry.policy?.authentication !== "ON_INSTALL") {
    errors.push("marketplace policy.authentication must be ON_INSTALL");
  }
}

const pluginPackage = await readJson(path.join(pluginRoot, "package.json"));
if (pluginPackage?.type !== "module") {
  errors.push("plugin package.json must set type=module");
}

for (const file of await walk(pluginRoot)) {
  const relative = path.relative(repoRoot, file);
  const contents = await readFile(file, "utf8").catch(() => "");
  if (/\/Users\/[^\s"'`]+/.test(contents)) {
    errors.push(`${relative} contains a user-local absolute path`);
  }
  if (contents.includes("/Users/robert")) {
    errors.push(`${relative} contains /Users/robert`);
  }
}

if (errors.length > 0) {
  console.error("Plugin validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Plugin validation passed.");
