#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { render } from "ink";
import {
  createRunId,
  loadWorkflowDefinition,
  nowIso,
  runWorkflow,
  RunStore,
  validateWorkflowDefinition
} from "@codex-workflows/runtime";
import type { ReasoningEffort } from "@codex-workflows/schemas";
import { RunDashboard } from "./dashboard.js";

const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON args: ${message}`);
  }
};

const cliDir = path.dirname(fileURLToPath(import.meta.url));

const firstExistingPath = (candidates: string[]) => {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] as string;
};

const resolveCliWorkflowPath = (cwd: string, workflow: string) => {
  if (path.isAbsolute(workflow)) {
    return workflow;
  }
  return firstExistingPath([
    path.resolve(cwd, workflow),
    // Distributable plugin bundle: plugins/codex-workflows/workflows/*.workflow.js
    path.resolve(cliDir, "..", workflow),
    // Monorepo build output: packages/cli/dist/index.js -> repo/workflows/*.workflow.js
    path.resolve(cliDir, "../../..", workflow)
  ]);
};

interface WorkerLaunch {
  cwd: string;
  workflowPath: string;
  args?: unknown;
  adapter?: string;
  runId: string;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  modelMap?: Record<string, string>;
  promptSuffix?: string;
  resume?: boolean;
}

const decodeLaunch = (raw: string) =>
  JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as WorkerLaunch;

const program = new Command();

program
  .name("cwf")
  .description("Codex workflow-as-code runtime")
  .version("0.1.0");

program
  .command("__run-worker", { hidden: true })
  .argument("<launch>", "base64url encoded workflow launch")
  .action(async (launch: string) => {
    const options = decodeLaunch(launch);
    await runWorkflow(options);
  });

program
  .command("validate")
  .argument("[workflow]", "workflow script", "workflows/release-diff-review.workflow.js")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (workflow: string, options: { cwd: string }) => {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveCliWorkflowPath(cwd, workflow);
    const result = await validateWorkflowDefinition(workflowPath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .argument("[workflow]", "workflow script", "workflows/release-diff-review.workflow.js")
  .option("--args <json>", "JSON args passed to the workflow", "{}")
  .option("--adapter <name>", "worker adapter: simulate, exec, sdk", "simulate")
  .option("--model <model>", "default model for subagents")
  .option("--reasoning <effort>", "default reasoning effort for subagents")
  .option(
    "--model-map <json>",
    "JSON object mapping phase id, agent id, or phase:agent id to model"
  )
  .option("--prompt-suffix <text>", "extra instruction appended to every worker prompt")
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--watch", "watch the run in the terminal dashboard", true)
  .option("--no-watch", "do not open the terminal dashboard")
  .option("--resume", "resume an existing run id instead of starting fresh")
  .option("--run-id <runId>", "explicit run id for resume/background integrations")
  .action(async (workflow: string, options: { args: string; adapter: string; model?: string; reasoning?: string; modelMap?: string; promptSuffix?: string; cwd: string; watch: boolean; resume?: boolean; runId?: string }) => {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveCliWorkflowPath(cwd, workflow);
    const loaded = await loadWorkflowDefinition(workflowPath);
    const runId = options.runId ?? createRunId(loaded.definition.name);
    const done = runWorkflow({
      cwd,
      workflowPath,
      args: parseJson(options.args),
      adapter: options.adapter,
      runId,
      defaultModel: options.model,
      reasoningEffort: options.reasoning as never,
      modelMap: options.modelMap ? (parseJson(options.modelMap) as Record<string, string>) : undefined,
      promptSuffix: options.promptSuffix,
      resume: options.resume
    });

    if (options.watch) {
      const app = render(<RunDashboard cwd={cwd} runId={runId} exitOnComplete onExit={() => app.unmount()} />);
      await done.catch(() => undefined);
      await app.waitUntilExit();
    } else {
      const summary = await done;
      console.log(summary.id);
    }
  });

program
  .command("watch")
  .argument("<run-id>")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (runId: string, options: { cwd: string }) => {
    const cwd = path.resolve(options.cwd);
    const app = render(<RunDashboard cwd={cwd} runId={runId} onExit={() => app.unmount()} />);
    await app.waitUntilExit();
  });

program
  .command("workflows")
  .description("list built-in and saved workflows")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (options: { cwd: string }) => {
    const cwd = path.resolve(options.cwd);
    const store = new RunStore(cwd);
    const runs = await store.listRuns();
    console.log("Built-in workflows:");
    console.log("  workflows/bug-sweep.workflow.js");
    console.log("  workflows/release-diff-review.workflow.js");
    console.log("  workflows/security-auth-review.workflow.js");
    console.log("");
    console.log("Recent runs:");
    for (const run of runs.slice(0, 10)) {
      console.log(`  ${run.id}  ${run.status}  ${run.name}`);
    }
  });

const controlCommand = (name: "pause" | "resume" | "stop") => {
  program
    .command(name)
    .argument("<run-id>")
    .option("--cwd <path>", "working directory", process.cwd())
    .action(async (runId: string, options: { cwd: string }) => {
      const store = new RunStore(path.resolve(options.cwd));
      await store.writeControl(runId, { type: name, at: nowIso() });
      if (name === "resume") {
        const summary = await store.readSummary(runId);
        if (["completed", "failed", "stopped"].includes(summary.status)) {
          const manifest = await store.readManifest(runId);
          await runWorkflow({
            cwd: path.resolve(options.cwd),
            workflowPath: summary.workflowPath,
            args: manifest.args,
            adapter:
              typeof manifest.launch?.adapter === "string"
                ? manifest.launch.adapter
                : undefined,
            runId,
            defaultModel:
              typeof manifest.launch?.defaultModel === "string"
                ? manifest.launch.defaultModel
                : undefined,
            reasoningEffort:
              typeof manifest.launch?.reasoningEffort === "string"
                ? (manifest.launch.reasoningEffort as never)
                : undefined,
            modelMap:
              typeof manifest.launch?.modelMap === "object" && manifest.launch.modelMap !== null
                ? (manifest.launch.modelMap as Record<string, string>)
                : undefined,
            promptSuffix:
              typeof manifest.launch?.promptSuffix === "string"
                ? manifest.launch.promptSuffix
                : undefined,
            resume: true
          });
        }
      }
      console.log(`${name} requested for ${runId}`);
    });
};

controlCommand("pause");
controlCommand("resume");
controlCommand("stop");

program
  .command("stop-agent")
  .argument("<run-id>")
  .argument("<agent-id>")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (runId: string, agentId: string, options: { cwd: string }) => {
    const store = new RunStore(path.resolve(options.cwd));
    await store.writeControl(runId, { type: "stop-agent", at: nowIso(), agentId });
    console.log(`stop requested for ${agentId} in ${runId}`);
  });

program
  .command("restart-agent")
  .argument("<run-id>")
  .argument("<agent-id>")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (runId: string, agentId: string, options: { cwd: string }) => {
    const cwd = path.resolve(options.cwd);
    const store = new RunStore(cwd);
    const summary = await store.markAgentForRestart(runId, agentId);
    const manifest = await store.readManifest(runId);
    await runWorkflow({
      cwd,
      workflowPath: summary.workflowPath,
      args: manifest.args,
      adapter: typeof manifest.launch?.adapter === "string" ? manifest.launch.adapter : undefined,
      runId,
      defaultModel:
        typeof manifest.launch?.defaultModel === "string"
          ? manifest.launch.defaultModel
          : undefined,
      reasoningEffort:
        typeof manifest.launch?.reasoningEffort === "string"
          ? (manifest.launch.reasoningEffort as never)
          : undefined,
      modelMap:
        typeof manifest.launch?.modelMap === "object" && manifest.launch.modelMap !== null
          ? (manifest.launch.modelMap as Record<string, string>)
          : undefined,
      promptSuffix:
        typeof manifest.launch?.promptSuffix === "string"
          ? manifest.launch.promptSuffix
          : undefined,
      resume: true
    });
    await store.writeControl(runId, { type: "restart-agent", at: nowIso(), agentId });
    console.log(`restarted ${agentId} in ${runId}`);
  });

program
  .command("save")
  .argument("<run-id>")
  .requiredOption("--name <name>", "saved workflow name")
  .option("--cwd <path>", "working directory", process.cwd())
  .action(async (runId: string, options: { name: string; cwd: string }) => {
    const store = new RunStore(path.resolve(options.cwd));
    const saved = await store.saveRunAsWorkflow(runId, options.name);
    console.log(`Saved ${saved.name}`);
    console.log(`Workflow: ${saved.workflowPath}`);
    console.log(`Skill: ${saved.skillPath}`);
  });

await program.parseAsync(process.argv);
