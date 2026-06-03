#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRunId,
  loadWorkflowDefinition,
  nowIso,
  RunStore,
  validateWorkflowDefinition
} from "@codex-workflows/runtime";

const cwdSchema = z.string().optional();

interface TerminalOpenResult {
  opened: boolean;
  command: string;
  columns: number;
  rows: number;
  app?: "SystemDefault" | "Harness" | "Terminal";
  scriptPath?: string;
  error?: string;
}

const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const quoteAppleScript = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const serverDir = path.dirname(fileURLToPath(import.meta.url));

const firstExistingPath = (candidates: string[]) => {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] as string;
};

const cliPathFor = (projectRoot: string) =>
  firstExistingPath([
    // Distributable plugin bundle: plugins/codex-workflows/dist/{mcp-server,cli}.js
    path.resolve(serverDir, "cli.js"),
    // Monorepo build output: packages/mcp-server/dist/index.js -> packages/cli/dist/index.js
    path.resolve(serverDir, "../../cli/dist/index.js"),
    // Fallback for direct repo development.
    path.resolve(projectRoot, "packages/cli/dist/index.js")
  ]);

const resolveWorkflowPath = (projectRoot: string, workflowPath: string) => {
  if (path.isAbsolute(workflowPath)) {
    return workflowPath;
  }
  return firstExistingPath([
    path.resolve(projectRoot, workflowPath),
    // Distributable plugin bundle: plugins/codex-workflows/workflows/*.workflow.js
    path.resolve(serverDir, "..", workflowPath),
    // Monorepo build output: packages/mcp-server/dist/index.js -> repo/workflows/*.workflow.js
    path.resolve(serverDir, "../../..", workflowPath)
  ]);
};

const dashboardCommand = (root: string, runId: string) => {
  const cliPath = cliPathFor(root);
  return [
    "cd",
    quoteShell(root),
    "&&",
    quoteShell(process.execPath),
    quoteShell(cliPath),
    "watch",
    quoteShell(runId),
    "--cwd",
    quoteShell(root)
  ].join(" ");
};

const encodeLaunch = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const startWorkflowWorker = (
  root: string,
  launch: {
    cwd: string;
    workflowPath: string;
    args?: unknown;
    adapter?: string;
    runId: string;
    defaultModel?: string;
    reasoningEffort?: string;
    modelMap?: Record<string, string>;
    promptSuffix?: string;
    approval?: "once" | "always" | "deny";
    resume?: boolean;
  }
) => {
  const child = spawn(process.execPath, [cliPathFor(root), "__run-worker", encodeLaunch(launch)], {
    cwd: root,
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return child.pid;
};

const waitForRunInitialized = async (store: RunStore, runId: string) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await store.readSummary(runId);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Workflow worker did not initialize run ${runId}: ${message}`);
};

const writeDashboardCommand = async (
  root: string,
  runId: string,
  columns: number,
  rows: number
) => {
  const scriptPath = path.resolve(root, ".codex-workflows", "runs", runId, "watch.command");
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    [
      "#!/bin/zsh",
      `printf '\\033[8;${rows};${columns}t'`,
      `cd ${quoteShell(root)} || exit 1`,
      `exec ${quoteShell(process.execPath)} ${quoteShell(cliPathFor(root))} watch ${quoteShell(
        runId
      )} --cwd ${quoteShell(root)}`,
      ""
    ].join("\n")
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const openCommandFile = async (
  root: string,
  runId: string,
  columns: number,
  rows: number,
  app: "SystemDefault" | "Harness",
  openArgs: string[]
): Promise<TerminalOpenResult> => {
  const command = dashboardCommand(root, runId);
  const scriptPath = await writeDashboardCommand(root, runId, columns, rows);
  return new Promise((resolve) => {
    const child = spawn("open", [...openArgs, scriptPath], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        opened: false,
        command,
        columns,
        rows,
        app,
        scriptPath,
        error: error.message
      });
    });
    child.on("close", (code) => {
      resolve({
        opened: code === 0,
        command,
        columns,
        rows,
        app,
        scriptPath,
        error: code === 0 ? undefined : stderr.trim() || `open exited with code ${code}`
      });
    });
    child.unref();
  });
};

const openDefaultDashboard = (
  root: string,
  runId: string,
  columns: number,
  rows: number
) => openCommandFile(root, runId, columns, rows, "SystemDefault", []);

const openHarnessDashboard = (
  root: string,
  runId: string,
  columns: number,
  rows: number
) => openCommandFile(root, runId, columns, rows, "Harness", ["-b", "com.robert.harness"]);

const openMacTerminalDashboard = async (
  root: string,
  runId: string,
  columns: number,
  rows: number
): Promise<TerminalOpenResult> => {
  const command = dashboardCommand(root, runId);
  if (process.platform !== "darwin") {
    return {
      opened: false,
      command,
      columns,
      rows,
      app: "Terminal",
      error: "Automatic dashboard launch is currently implemented for macOS terminal apps."
    };
  }

  const script = [
    'tell application "Terminal"',
    "activate",
    `do script "${quoteAppleScript(command)}"`,
    "delay 0.2",
    "try",
    `set number of columns of selected tab of front window to ${columns}`,
    `set number of rows of selected tab of front window to ${rows}`,
    "end try",
    "try",
    "set bounds of front window to {20, 40, 2040, 920}",
    "end try",
    "end tell"
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ opened: false, command, columns, rows, app: "Terminal", error: error.message });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ opened: true, command, columns, rows, app: "Terminal" });
        return;
      }
      resolve({
        opened: false,
        command,
        columns,
        rows,
        app: "Terminal",
        error: stderr.trim() || `osascript exited with code ${code}`
      });
    });
    child.unref();
  });
};

const openDashboard = async (
  root: string,
  runId: string,
  columns: number,
  rows: number,
  terminalApp: "default" | "auto" | "harness" | "terminal"
) => {
  if (process.platform !== "darwin") {
    return openMacTerminalDashboard(root, runId, columns, rows);
  }
  if (terminalApp === "default" || terminalApp === "auto") {
    const opened = await openDefaultDashboard(root, runId, columns, rows);
    if (opened.opened) {
      return opened;
    }
    return openMacTerminalDashboard(root, runId, columns, rows);
  }
  if (terminalApp === "harness") {
    return openHarnessDashboard(root, runId, columns, rows);
  }
  return openMacTerminalDashboard(root, runId, columns, rows);
};

const text = (payload: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
    }
  ]
});

const server = new McpServer(
  {
    name: "codex-workflows",
    version: "0.1.0"
  },
  {
    instructions:
      "Run and inspect Codex workflow-as-code jobs. Prefer workflow_run for release review fanout, workflow_status for concise progress, and workflow_events only when raw event history is needed."
  }
);

server.registerTool(
  "workflow_run",
  {
    title: "Run workflow",
    description: "Start a Codex workflow run.",
    inputSchema: {
      workflowPath: z.string().default("workflows/release-diff-review.workflow.js"),
      args: z.unknown().optional(),
      adapter: z.enum(["simulate", "exec", "sdk"]).default("simulate"),
      model: z.string().optional(),
      reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
      modelMap: z.record(z.string(), z.string()).optional(),
      promptSuffix: z.string().optional(),
      approval: z.enum(["once", "always", "deny"]).default("once"),
      openTui: z.boolean().default(true),
      terminalApp: z.enum(["default", "auto", "harness", "terminal"]).default("default"),
      terminalColumns: z.number().int().min(100).max(300).default(190),
      terminalRows: z.number().int().min(24).max(80).default(42),
      cwd: cwdSchema
    }
  },
  async ({
    workflowPath,
    args,
    adapter,
    model,
    reasoning,
    modelMap,
    promptSuffix,
    approval,
    openTui,
    terminalApp,
    terminalColumns,
    terminalRows,
    cwd
  }) => {
    const root = path.resolve(cwd ?? process.cwd());
    const absoluteWorkflowPath = resolveWorkflowPath(root, workflowPath);
    const loaded = await loadWorkflowDefinition(absoluteWorkflowPath);
    if (approval === "deny") {
      return text({
        cancelled: true,
        reason: "Workflow launch denied by approval=deny.",
        workflowPath: absoluteWorkflowPath
      });
    }
    const runId = createRunId(loaded.definition.name);
    const store = new RunStore(root);
    if (approval === "always") {
      await store.trustWorkflow(loaded.definition.name, absoluteWorkflowPath, loaded.hash);
    }
    const workerPid = startWorkflowWorker(root, {
      cwd: root,
      workflowPath: absoluteWorkflowPath,
      args,
      adapter,
      defaultModel: model,
      reasoningEffort: reasoning,
      modelMap,
      promptSuffix,
      approval,
      runId
    });
    await waitForRunInitialized(store, runId);
    const dashboard = openTui
      ? await openDashboard(root, runId, terminalColumns, terminalRows, terminalApp)
      : {
          opened: false,
          command: `${quoteShell(process.execPath)} ${quoteShell(
            cliPathFor(root)
          )} watch ${quoteShell(runId)} --cwd ${quoteShell(root)}`,
          columns: terminalColumns,
          rows: terminalRows,
          app:
            terminalApp === "terminal"
              ? "Terminal"
              : terminalApp === "harness"
                ? "Harness"
                : "SystemDefault",
          error: "Automatic dashboard launch disabled by openTui=false."
        };
    return text({
      runId,
      cwd: root,
      workflowPath: absoluteWorkflowPath,
      workerPid,
      dashboard,
      platform: os.platform()
    });
  }
);

server.registerTool(
  "workflow_validate",
  {
    title: "Validate workflow",
    description: "Validate a workflow script without running it.",
    inputSchema: {
      workflowPath: z.string().default("workflows/release-diff-review.workflow.js"),
      cwd: cwdSchema
    }
  },
  async ({ workflowPath, cwd }) => {
    const root = path.resolve(cwd ?? process.cwd());
    const absoluteWorkflowPath = resolveWorkflowPath(root, workflowPath);
    return text(await validateWorkflowDefinition(absoluteWorkflowPath));
  }
);

server.registerTool(
  "workflow_preview",
  {
    title: "Preview workflow",
    description: "Load a workflow and preview phases, agents, limits, and model defaults.",
    inputSchema: {
      workflowPath: z.string().default("workflows/release-diff-review.workflow.js"),
      cwd: cwdSchema
    }
  },
  async ({ workflowPath, cwd }) => {
    const root = path.resolve(cwd ?? process.cwd());
    const absoluteWorkflowPath = resolveWorkflowPath(root, workflowPath);
    const loaded = await loadWorkflowDefinition(absoluteWorkflowPath);
    return text({
      name: loaded.definition.name,
      description: loaded.definition.description,
      maxConcurrency: loaded.definition.maxConcurrency,
      maxAgents: loaded.definition.maxAgents,
      totalAgents: loaded.definition.phases.reduce((total, phase) => total + phase.agents.length, 0),
      phases: loaded.definition.phases.map((phase) => ({
        id: phase.id,
        title: phase.title,
        agents: phase.agents.map((agent) => ({
          id: agent.id,
          title: agent.title,
          model: agent.model,
          reasoningEffort: agent.reasoningEffort,
          sandbox: agent.sandbox
        }))
      })),
      hash: loaded.hash
    });
  }
);

server.registerTool(
  "workflow_status",
  {
    title: "Workflow status",
    description: "Read the current run summary.",
    inputSchema: {
      runId: z.string(),
      cwd: cwdSchema
    }
  },
  async ({ runId, cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    return text(await store.readSummary(runId));
  }
);

server.registerTool(
  "workflow_events",
  {
    title: "Workflow events",
    description: "Read workflow JSONL events after a cursor.",
    inputSchema: {
      runId: z.string(),
      cursor: z.number().int().nonnegative().default(0),
      cwd: cwdSchema
    }
  },
  async ({ runId, cursor, cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    return text(await store.readEvents(runId, cursor));
  }
);

server.registerTool(
  "workflow_agent_detail",
  {
    title: "Workflow agent detail",
    description: "Read prompt, status, and result for one workflow agent.",
    inputSchema: {
      runId: z.string(),
      agentId: z.string(),
      cwd: cwdSchema
    }
  },
  async ({ runId, agentId, cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    const summary = await store.readSummary(runId);
    const agent = summary.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return text(agent);
  }
);

for (const command of ["pause", "resume", "stop"] as const) {
  server.registerTool(
    `workflow_${command}`,
    {
      title: `Workflow ${command}`,
      description: `Request workflow ${command}.`,
      inputSchema: {
        runId: z.string(),
        cwd: cwdSchema
      }
    },
    async ({ runId, cwd }) => {
      const root = path.resolve(cwd ?? process.cwd());
      const store = new RunStore(root);
      await store.writeControl(runId, { type: command, at: nowIso() });
      if (command === "resume") {
        const summary = await store.readSummary(runId);
        if (["completed", "failed", "stopped"].includes(summary.status)) {
          const manifest = await store.readManifest(runId);
          const launch = manifest.launch ?? {};
          const workerPid = startWorkflowWorker(root, {
            cwd: root,
            workflowPath: summary.workflowPath,
            args: manifest.args,
            runId,
            adapter: typeof launch.adapter === "string" ? launch.adapter : undefined,
            defaultModel:
              typeof launch.defaultModel === "string" ? launch.defaultModel : undefined,
            reasoningEffort:
              typeof launch.reasoningEffort === "string" ? launch.reasoningEffort : undefined,
            modelMap:
              typeof launch.modelMap === "object" && launch.modelMap !== null
                ? (launch.modelMap as Record<string, string>)
                : undefined,
            promptSuffix:
              typeof launch.promptSuffix === "string" ? launch.promptSuffix : undefined,
            resume: true
          });
          return text({ runId, command, workerPid });
        }
      }
      return text({ runId, command });
    }
  );
}

server.registerTool(
  "workflow_stop_agent",
  {
    title: "Stop workflow agent",
    description: "Request cancellation for one running workflow agent.",
    inputSchema: {
      runId: z.string(),
      agentId: z.string(),
      cwd: cwdSchema
    }
  },
  async ({ runId, agentId, cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    await store.writeControl(runId, { type: "stop-agent", at: nowIso(), agentId });
    return text({ runId, agentId, command: "stop-agent" });
  }
);

server.registerTool(
  "workflow_restart_agent",
  {
    title: "Restart workflow agent",
    description: "Request restart for a workflow agent.",
    inputSchema: {
      runId: z.string(),
      agentId: z.string(),
      cwd: cwdSchema
    }
  },
  async ({ runId, agentId, cwd }) => {
    const root = path.resolve(cwd ?? process.cwd());
    const store = new RunStore(root);
    const summary = await store.markAgentForRestart(runId, agentId);
    const manifest = await store.readManifest(runId);
    const launch = manifest.launch ?? {};
    const workerPid = startWorkflowWorker(root, {
      cwd: root,
      workflowPath: summary.workflowPath,
      args: manifest.args,
      runId,
      adapter: typeof launch.adapter === "string" ? launch.adapter : undefined,
      defaultModel: typeof launch.defaultModel === "string" ? launch.defaultModel : undefined,
      reasoningEffort:
        typeof launch.reasoningEffort === "string" ? launch.reasoningEffort : undefined,
      modelMap:
        typeof launch.modelMap === "object" && launch.modelMap !== null
          ? (launch.modelMap as Record<string, string>)
          : undefined,
      promptSuffix: typeof launch.promptSuffix === "string" ? launch.promptSuffix : undefined,
      resume: true
    });
    await store.writeControl(runId, {
      type: "restart-agent",
      at: nowIso(),
      agentId
    });
    return text({ runId, agentId, command: "restart-agent", workerPid });
  }
);

server.registerTool(
  "workflow_save",
  {
    title: "Save workflow",
    description: "Save a completed workflow run as a project workflow and skill.",
    inputSchema: {
      runId: z.string(),
      name: z.string(),
      cwd: cwdSchema
    }
  },
  async ({ runId, name, cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    return text(await store.saveRunAsWorkflow(runId, name));
  }
);

server.registerTool(
  "workflow_list",
  {
    title: "List workflows",
    description: "List recent workflow runs.",
    inputSchema: {
      cwd: cwdSchema
    }
  },
  async ({ cwd }) => {
    const store = new RunStore(path.resolve(cwd ?? process.cwd()));
    return text(await store.listRuns());
  }
);

await server.connect(new StdioServerTransport());
