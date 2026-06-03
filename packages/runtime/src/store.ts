import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  type AgentSummary,
  type ControlCommand,
  ControlCommandSchema,
  type RunSummary,
  RunSummarySchema,
  type StorageScope,
  type WorkflowDefinition,
  type WorkflowEvent,
  WorkflowEventSchema
} from "@codex-workflows/schemas";
import { nowIso, slugify } from "./ids.js";

const elapsed = (startedAt?: string) =>
  startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;

const refreshSummaryCounts = (summary: RunSummary) => {
  summary.phases = summary.phases.map((phase) => {
    const agents = summary.agents.filter((agent) => agent.phaseId === phase.id);
    return {
      ...phase,
      completedAgents: agents.filter((agent) => agent.status === "completed").length,
      failedAgents: agents.filter((agent) => agent.status === "failed").length
    };
  });
  summary.totals = {
    totalAgents: summary.agents.length,
    completedAgents: summary.agents.filter((agent) => agent.status === "completed").length,
    failedAgents: summary.agents.filter((agent) => agent.status === "failed").length,
    runningAgents: summary.agents.filter((agent) => agent.status === "running").length,
    tokens: summary.agents.reduce((total, agent) => total + agent.tokens, 0),
    tools: summary.agents.reduce((total, agent) => total + agent.tools, 0),
    elapsedMs: elapsed(summary.startedAt)
  };
};

export interface RunStoreOptions {
  storageScope?: StorageScope;
  storeRoot?: string;
}

const projectStoreRoot = (cwd: string) => path.join(cwd, ".codex-workflows");

const codexHome = () => process.env.CODEX_HOME ?? path.join(homedir(), ".codex");

const projectHash = (cwd: string) =>
  createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);

export const defaultStoreRoot = (cwd: string, storageScope: StorageScope = "codex-home") =>
  storageScope === "project"
    ? projectStoreRoot(cwd)
    : path.join(codexHome(), "codex-workflows", "projects", projectHash(cwd));

const dirExists = (candidate: string) => existsSync(candidate);

export class RunStore {
  readonly root: string;
  readonly storageScope: StorageScope;
  private readonly projectRoot: string;

  constructor(readonly cwd: string, options: RunStoreOptions = {}) {
    this.storageScope = options.storageScope ?? "codex-home";
    this.projectRoot = projectStoreRoot(cwd);
    this.root = options.storeRoot ?? defaultStoreRoot(cwd, this.storageScope);
  }

  runDir(runId: string) {
    const primary = path.join(this.root, "runs", runId);
    const legacy = path.join(this.projectRoot, "runs", runId);
    if (primary !== legacy && !dirExists(primary) && dirExists(legacy)) {
      return legacy;
    }
    return primary;
  }

  statusPath(runId: string) {
    return path.join(this.runDir(runId), "status.json");
  }

  eventsPath(runId: string) {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  controlPath(runId: string) {
    return path.join(this.runDir(runId), "control.json");
  }

  trustPath() {
    return path.join(this.root, "trust.json");
  }

  agentDir(runId: string, agentId: string) {
    return path.join(this.runDir(runId), "agents", agentId);
  }

  async ensure() {
    await mkdir(path.join(this.root, "runs"), { recursive: true });
    await mkdir(path.join(this.root, "workflows"), { recursive: true });
  }

  async initRun(
    summary: RunSummary,
    definition: WorkflowDefinition,
    args: unknown,
    source: string,
    launch?: unknown
  ) {
    await this.ensure();
    await mkdir(this.runDir(summary.id), { recursive: true });
    await mkdir(path.join(this.runDir(summary.id), "agents"), { recursive: true });
    await writeFile(
      path.join(this.runDir(summary.id), "manifest.json"),
      `${JSON.stringify(
        {
          definition,
          args,
          launch,
          storage: {
            storageScope: this.storageScope,
            storeRoot: this.root
          }
        },
        null,
        2
      )}\n`
    );
    await writeFile(path.join(this.runDir(summary.id), "script.workflow.js"), source);
    await this.writeSummary(summary);
    await writeFile(this.eventsPath(summary.id), "");
  }

  async readManifest(runId: string) {
    return JSON.parse(await readFile(path.join(this.runDir(runId), "manifest.json"), "utf8")) as {
      definition: WorkflowDefinition;
      args: unknown;
      launch?: Record<string, unknown>;
      storage?: Record<string, unknown>;
    };
  }

  async readTrust() {
    const contents = await readFile(this.trustPath(), "utf8").catch(() => "{}");
    return JSON.parse(contents) as Record<
      string,
      { approvedAt: string; workflowPath: string; name: string; hash: string }
    >;
  }

  async trustWorkflow(name: string, workflowPath: string, hash: string) {
    await this.ensure();
    const trust = await this.readTrust();
    const key = `${name}:${hash}`;
    trust[key] = { approvedAt: nowIso(), workflowPath, name, hash };
    await writeFile(this.trustPath(), `${JSON.stringify(trust, null, 2)}\n`);
    return trust[key];
  }

  async writeSummary(summary: RunSummary) {
    const parsed = RunSummarySchema.parse({
      ...summary,
      storageScope: summary.storageScope ?? this.storageScope,
      storeRoot: summary.storeRoot ?? this.root,
      updatedAt: nowIso()
    });
    const statusPath = this.statusPath(summary.id);
    const tmpPath = `${statusPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`);
    await rename(tmpPath, statusPath);
  }

  async readSummary(runId: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return RunSummarySchema.parse(JSON.parse(await readFile(this.statusPath(runId), "utf8")));
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw lastError;
  }

  async appendEvent(event: WorkflowEvent) {
    const parsed = WorkflowEventSchema.parse(event);
    await writeFile(this.eventsPath(parsed.runId), `${JSON.stringify(parsed)}\n`, {
      flag: "a"
    });
  }

  async readEvents(runId: string, cursor = 0) {
    const contents = await readFile(this.eventsPath(runId), "utf8").catch(() => "");
    const lines = contents.split(/\r?\n/).filter(Boolean);
    return {
      cursor: lines.length,
      events: lines.slice(cursor).map((line) => WorkflowEventSchema.parse(JSON.parse(line)))
    };
  }

  async listRuns() {
    await this.ensure();
    const dirs = [path.join(this.root, "runs")];
    const legacy = path.join(this.projectRoot, "runs");
    if (legacy !== dirs[0]) {
      dirs.push(legacy);
    }
    const runIds = new Set<string>();
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          runIds.add(entry.name);
        }
      }
    }
    const runs = await Promise.all(
      Array.from(runIds).map((runId) => this.readSummary(runId).catch(() => null))
    );
    return runs
      .filter((run): run is RunSummary => run !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async writeControl(runId: string, command: ControlCommand) {
    await writeFile(this.controlPath(runId), `${JSON.stringify(command, null, 2)}\n`);
  }

  async readControl(runId: string) {
    const contents = await readFile(this.controlPath(runId), "utf8").catch(() => "");
    if (!contents.trim()) {
      return null;
    }
    return ControlCommandSchema.parse(JSON.parse(contents));
  }

  async clearControl(runId: string) {
    await rm(this.controlPath(runId), { force: true });
  }

  async writeAgentResult(runId: string, agent: AgentSummary) {
    const dir = this.agentDir(runId, agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "prompt.md"), `${agent.prompt}\n`);
    await writeFile(path.join(dir, "result.json"), `${JSON.stringify(agent, null, 2)}\n`);
  }

  async writeFinalReport(runId: string, markdown: string) {
    const finalReportPath = path.join(this.runDir(runId), "final.md");
    await writeFile(finalReportPath, markdown);
    return finalReportPath;
  }

  async markAgentForRestart(runId: string, agentId: string) {
    const summary = await this.readSummary(runId);
    const agent = summary.agents.find((item) => item.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    summary.status = "running";
    summary.completedAt = undefined;
    summary.finalReportPath = undefined;
    summary.agents = summary.agents.map((item) =>
      item.id === agentId
        ? {
            ...item,
            status: "pending",
            error: undefined,
            result: undefined,
            rawResult: undefined,
            findings: undefined,
            completedAt: undefined,
            attempts: 0
          }
        : item
    );
    summary.phases = summary.phases.map((phase) =>
      phase.id === agent.phaseId
        ? {
            ...phase,
            status: "pending",
            completedAt: undefined
          }
        : phase
    );
    refreshSummaryCounts(summary);
    await this.writeSummary(summary);
    return summary;
  }

  async saveRunAsWorkflow(runId: string, rawName: string) {
    const name = slugify(rawName);
    if (!name) {
      throw new Error("Saved workflow name must include a letter or number.");
    }
    const workflowPath = path.join(this.projectRoot, "workflows", `${name}.workflow.js`);
    const skillDir = path.join(this.cwd, ".agents", "skills", name);
    const skillPath = path.join(skillDir, "SKILL.md");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await copyFile(path.join(this.runDir(runId), "script.workflow.js"), workflowPath);
    await writeFile(
      skillPath,
      [
        "---",
        `name: ${name}`,
        `description: Run saved Codex workflow ${name}.`,
        "---",
        "",
        `Run the saved workflow \`${name}\` through codex-workflows.`,
        "",
        "```bash",
        `pnpm cwf run .codex-workflows/workflows/${name}.workflow.js --watch`,
        "```",
        ""
      ].join("\n")
    );
    await this.appendEvent({
      type: "workflow_saved",
      runId,
      at: nowIso(),
      name,
      skillPath,
      workflowPath
    });
    return { name, workflowPath, skillPath };
  }
}
