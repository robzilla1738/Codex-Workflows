import path from "node:path";
import type { WorkerAdapter } from "@codex-workflows/codex-adapter";
import { createWorkerAdapter } from "@codex-workflows/codex-adapter";
import {
  type AgentDefinition,
  type AgentFinding,
  AgentFindingSchema,
  type AgentSummary,
  type PhaseSummary,
  type ReasoningEffort,
  type RunSummary,
  type WorkflowDefinition
} from "@codex-workflows/schemas";
import { createRunId, nowIso, resolveWorkflowPath } from "./ids.js";
import { loadWorkflowDefinition } from "./definition.js";
import { RunStore } from "./store.js";

export interface RunWorkflowOptions {
  cwd: string;
  workflowPath: string;
  args?: unknown;
  adapter?: string | WorkerAdapter;
  runId?: string;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  modelMap?: Record<string, string>;
  promptSuffix?: string;
  resume?: boolean;
}

export interface StartedWorkflowRun {
  runId: string;
  done: Promise<RunSummary>;
}

const elapsed = (startedAt?: string) =>
  startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;

const buildTotals = (summary: RunSummary) => ({
  totalAgents: summary.agents.length,
  completedAgents: summary.agents.filter((agent) => agent.status === "completed").length,
  failedAgents: summary.agents.filter((agent) => agent.status === "failed").length,
  runningAgents: summary.agents.filter((agent) => agent.status === "running").length,
  tokens: summary.agents.reduce((total, agent) => total + agent.tokens, 0),
  tools: summary.agents.reduce((total, agent) => total + agent.tools, 0),
  elapsedMs: elapsed(summary.startedAt)
});

const refreshPhaseCounts = (summary: RunSummary) => {
  summary.phases = summary.phases.map((phase) => {
    const agents = summary.agents.filter((agent) => agent.phaseId === phase.id);
    return {
      ...phase,
      completedAgents: agents.filter((agent) => agent.status === "completed").length,
      failedAgents: agents.filter((agent) => agent.status === "failed").length
    };
  });
  summary.totals = buildTotals(summary);
};

const createInitialSummary = (
  runId: string,
  definition: WorkflowDefinition,
  workflowPath: string,
  cwd: string,
  options: Pick<RunWorkflowOptions, "defaultModel" | "reasoningEffort" | "modelMap">
): RunSummary => {
  const phases: PhaseSummary[] = definition.phases.map((phase) => ({
    id: phase.id,
    title: phase.title,
    status: "pending",
    totalAgents: phase.agents.length,
    completedAgents: 0,
    failedAgents: 0
  }));
  const agents: AgentSummary[] = definition.phases.flatMap((phase) =>
    phase.agents.map((agent) => ({
      id: `${phase.id}:${agent.id}`,
      phaseId: phase.id,
      title: `${phase.id}:${agent.title}`,
      prompt: agent.prompt,
      model: resolveAgentModel(phase.id, agent, options),
      reasoningEffort: agent.reasoningEffort ?? options.reasoningEffort,
      sandbox: agent.sandbox,
      status: "pending",
      tokens: 0,
      tools: 0,
      elapsedMs: 0,
      attempts: 0
    }))
  );
  const createdAt = nowIso();
  return {
    id: runId,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    workflowPath,
    cwd,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    selectedPhaseId: phases[0]?.id,
    phases,
    agents,
    totals: {
      totalAgents: agents.length,
      completedAgents: 0,
      failedAgents: 0,
      runningAgents: 0,
      tokens: 0,
      tools: 0,
      elapsedMs: 0
    }
  };
};

const resolveAgentModel = (
  phaseId: string,
  agent: AgentDefinition,
  options: Pick<RunWorkflowOptions, "defaultModel" | "modelMap">
) =>
  options.modelMap?.[`${phaseId}:${agent.id}`] ??
  options.modelMap?.[agent.id] ??
  options.modelMap?.[phaseId] ??
  options.defaultModel ??
  agent.model;

const buildWorkerPrompt = (
  definition: WorkflowDefinition,
  phaseId: string,
  agent: AgentDefinition,
  args: unknown,
  options: Pick<RunWorkflowOptions, "promptSuffix">
) => {
  const payload = {
    workflow: definition.name,
    version: definition.version,
    phase: phaseId,
    agent: agent.id,
    args
  };
  return [
    `You are running as subagent ${phaseId}:${agent.id} inside Codex Workflows.`,
    "",
    "Task:",
    agent.prompt,
    "",
    "Workflow context:",
    JSON.stringify(payload, null, 2),
    "",
    "Output contract:",
    "- Be concrete and adversarial.",
    "- Do not invent findings. Mark uncertain claims as needs-human-review.",
    "- Return only JSON text, with this shape:",
    JSON.stringify(
      {
        findings: [
          {
            verdict: "confirmed | false-positive | needs-human-review",
            severity: "blocker | high | medium | low",
            summary: "short finding summary",
            evidence: ["file path, command, log, or explicit not inspected"],
            repro: "exact command or manual steps when available",
            confidence: 0.75,
            details: "concise rationale"
          }
        ]
      },
      null,
      2
    ),
    "- If this is a simulated run, produce realistic review-style JSON, not filler text.",
    options.promptSuffix ? ["", "Additional caller instructions:", options.promptSuffix].join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
};

const extractJsonText = (text: string) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
};

const parseAgentFindings = (
  raw: string,
  agentId: string,
  phaseId: string,
  model?: string
): AgentFinding[] => {
  const parsed = JSON.parse(extractJsonText(raw)) as unknown;
  const findings = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : [];
  if (findings.length === 0) {
    throw new Error("Worker output did not include a non-empty findings array.");
  }
  return findings.map((finding) =>
    AgentFindingSchema.parse({
      ...(finding as Record<string, unknown>),
      agentId,
      phaseId,
      model: (finding as { model?: unknown }).model ?? model
    })
  );
};

async function mapLimit<T>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await run(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}

export class WorkflowStoppedError extends Error {
  constructor() {
    super("Workflow stopped");
  }
}

export class WorkflowRunner {
  private summaryLock: Promise<void> = Promise.resolve();

  constructor(private readonly store: RunStore) {}

  async start(options: RunWorkflowOptions): Promise<StartedWorkflowRun> {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveWorkflowPath(cwd, options.workflowPath);
    const loaded = await loadWorkflowDefinition(workflowPath);
    const runId = options.runId ?? createRunId(loaded.definition.name);
    const done = this.run({ ...options, cwd, workflowPath, runId });
    return {
      runId,
      done
    };
  }

  async run(options: RunWorkflowOptions): Promise<RunSummary> {
    const cwd = path.resolve(options.cwd);
    const workflowPath = resolveWorkflowPath(cwd, options.workflowPath);
    const loaded = await loadWorkflowDefinition(workflowPath);
    const runId = options.runId ?? createRunId(loaded.definition.name);
    const adapter =
      typeof options.adapter === "string" || options.adapter === undefined
        ? createWorkerAdapter(options.adapter ?? "simulate")
        : options.adapter;
    let summary = options.resume
      ? await this.store.readSummary(runId)
      : createInitialSummary(runId, loaded.definition, workflowPath, cwd, options);

    if (!options.resume) {
      await this.store.initRun(summary, loaded.definition, options.args ?? {}, loaded.source, {
        adapter: typeof options.adapter === "string" ? options.adapter : options.adapter?.name,
        defaultModel: options.defaultModel,
        reasoningEffort: options.reasoningEffort,
        modelMap: options.modelMap,
        promptSuffix: options.promptSuffix
      });
      await this.store.appendEvent({
        type: "run_started",
        runId,
        at: nowIso(),
        name: loaded.definition.name
      });
    } else {
      summary = await this.mutateSummary(runId, (current) => {
        current.status = "running";
        current.completedAt = undefined;
        current.error = undefined;
        for (const agent of current.agents) {
          if (["failed", "cancelled", "running"].includes(agent.status)) {
            agent.status = "pending";
            agent.error = undefined;
            agent.completedAt = undefined;
          }
        }
        for (const phase of current.phases) {
          if (phase.status !== "completed") {
            phase.status = "pending";
            phase.completedAt = undefined;
          }
        }
      });
      await this.store.appendEvent({ type: "run_resumed", runId, at: nowIso() });
    }

    try {
      summary = {
        ...summary,
        status: "running",
        startedAt: nowIso()
      };
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);

      for (const phase of loaded.definition.phases) {
        await this.throwIfStopped(summary.id);
        await this.waitIfPaused(summary);
        summary = await this.startPhase(summary, phase.id);
        await mapLimit(phase.agents, loaded.definition.maxConcurrency, async (agent) => {
          const existing = (await this.store.readSummary(summary.id)).agents.find(
            (item) => item.id === `${phase.id}:${agent.id}`
          );
          if (existing?.status === "completed") {
            return;
          }
          await this.runAgent(summary, loaded.definition, phase.id, agent, adapter, options);
          summary = await this.store.readSummary(summary.id);
        });
        summary = await this.completePhase(summary, phase.id);
      }

      summary = await this.completeRun(summary);
      return summary;
    } catch (error) {
      if (error instanceof WorkflowStoppedError) {
        summary = await this.store.readSummary(runId);
        summary.status = "stopped";
        summary.completedAt = nowIso();
        refreshPhaseCounts(summary);
        await this.store.writeSummary(summary);
        await this.store.appendEvent({ type: "run_stopped", runId, at: nowIso() });
        return summary;
      }
      const message = error instanceof Error ? error.message : String(error);
      summary = await this.store.readSummary(runId);
      summary.status = "failed";
      summary.error = message;
      summary.completedAt = nowIso();
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);
      await this.store.appendEvent({ type: "run_failed", runId, at: nowIso(), error: message });
      throw error;
    }
  }

  private async startPhase(summary: RunSummary, phaseId: string) {
    const next = await this.mutateSummary(summary.id, (current) => {
      current.selectedPhaseId = phaseId;
      current.phases = current.phases.map((phase) =>
        phase.id === phaseId ? { ...phase, status: "running", startedAt: nowIso() } : phase
      );
    });
    await this.store.appendEvent({
      type: "phase_started",
      runId: next.id,
      phaseId,
      at: nowIso()
    });
    return next;
  }

  private async completePhase(summary: RunSummary, phaseId: string) {
    const next = await this.mutateSummary(summary.id, (current) => {
      const failed = current.agents.some(
        (agent) => agent.phaseId === phaseId && agent.status === "failed"
      );
      current.phases = current.phases.map((phase) =>
        phase.id === phaseId
          ? {
              ...phase,
              status: failed ? "failed" : "completed",
              completedAt: nowIso()
            }
          : phase
      );
    });
    await this.store.appendEvent({
      type: "phase_completed",
      runId: next.id,
      phaseId,
      at: nowIso()
    });
    return next;
  }

  private async runAgent(
    summary: RunSummary,
    definition: WorkflowDefinition,
    phaseId: string,
    agentDefinition: AgentDefinition,
    adapter: WorkerAdapter,
    options: RunWorkflowOptions
  ) {
    await this.throwIfStopped(summary.id);
    await this.waitIfPaused(summary);
    const agentId = `${phaseId}:${agentDefinition.id}`;
    const startedAt = nowIso();
    let next = await this.mutateSummary(summary.id, (current) => {
      current.agents = current.agents.map((agent) =>
        agent.id === agentId ? { ...agent, status: "running", startedAt } : agent
      );
    });
    await this.store.appendEvent({
      type: "agent_started",
      runId: next.id,
      phaseId,
      agentId,
      at: startedAt
    });
    let lastRawOutput = "";
    const abortController = new AbortController();
    let cancelledByStopAgent = false;
    const controlTimer = setInterval(() => {
      void (async () => {
        const control = await this.store.readControl(summary.id);
        if (control?.type === "stop") {
          abortController.abort();
        }
        if (control?.type === "stop-agent" && control.agentId === agentId) {
          cancelledByStopAgent = true;
          abortController.abort();
        }
      })();
    }, 250);

    try {
      const model = resolveAgentModel(phaseId, agentDefinition, options);
      const workerSpec = {
        id: agentId,
        phaseId,
        title: agentDefinition.title,
        prompt: buildWorkerPrompt(
          definition,
          phaseId,
          agentDefinition,
          options.args ?? {},
          options
        ),
        cwd: next.cwd,
        model,
        reasoningEffort: agentDefinition.reasoningEffort ?? options.reasoningEffort,
        sandbox: agentDefinition.sandbox,
        expectedTokens: agentDefinition.expectedTokens,
        expectedTools: agentDefinition.expectedTools,
        durationMs: agentDefinition.durationMs
      };
      let result: Awaited<ReturnType<WorkerAdapter["runWorker"]>> | undefined;
      let findings: AgentFinding[] | undefined;
      let validationError = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        result = await adapter.runWorker(
          {
            ...workerSpec,
            prompt:
              attempt === 1
                ? workerSpec.prompt
                : `${workerSpec.prompt}\n\nPrevious output was invalid: ${validationError}\nReturn valid JSON text only.`
          },
          async (progress) => {
            const current = await this.mutateSummary(summary.id, (draft) => {
              draft.agents = draft.agents.map((agent) =>
                agent.id === agentId
                  ? {
                      ...agent,
                      tokens: progress.tokens ?? agent.tokens,
                      tools: progress.tools ?? agent.tools,
                      attempts: attempt
                    }
                  : agent
              );
            });
            await this.store.appendEvent({
              type: "agent_updated",
              runId: current.id,
              agentId,
              at: nowIso(),
              tokens: progress.tokens,
              tools: progress.tools,
              message: progress.message
            });
            if (progress.message) {
              await this.store.appendEvent({
                type: "agent_tool_event",
                runId: current.id,
                agentId,
                at: nowIso(),
                kind: "message",
                text: progress.message
              });
            }
          },
          abortController.signal
        );
        lastRawOutput = result.output;
        try {
          findings = parseAgentFindings(result.output, agentId, phaseId, model);
          break;
        } catch (error) {
          validationError = error instanceof Error ? error.message : String(error);
          await this.store.appendEvent({
            type: "agent_retried",
            runId: next.id,
            agentId,
            phaseId,
            at: nowIso(),
            error: validationError
          });
        }
      }
      if (!result || !findings) {
        throw new Error(`Worker result validation failed after retry: ${validationError}`);
      }
      let completedAgent: AgentSummary | undefined;
      next = await this.mutateSummary(summary.id, (current) => {
        current.agents = current.agents.map((agent) => {
          if (agent.id !== agentId) {
            return agent;
          }
          completedAgent = {
            ...agent,
            status: "completed",
            tokens: result.tokens,
            tools: result.tools,
            elapsedMs: result.elapsedMs,
            result: result.output,
            rawResult: result.output,
            findings,
            completedAt: nowIso()
          };
          return completedAgent;
        });
      });
      if (completedAgent) {
        await this.store.writeAgentResult(next.id, completedAgent);
      }
      await this.store.appendEvent({
        type: "agent_completed",
        runId: next.id,
        phaseId,
        agentId,
        at: nowIso(),
        tokens: result.tokens,
        tools: result.tools,
        elapsedMs: result.elapsedMs
      });
    } catch (error) {
      if (!cancelledByStopAgent) {
        const control = await this.store.readControl(summary.id);
        if (control?.type === "stop") {
          clearInterval(controlTimer);
          throw new WorkflowStoppedError();
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      next = await this.mutateSummary(summary.id, (current) => {
        current.agents = current.agents.map((agent) =>
          agent.id === agentId
            ? {
              ...agent,
                status: cancelledByStopAgent ? "cancelled" : "failed",
                error: cancelledByStopAgent ? undefined : message,
                rawResult: lastRawOutput || agent.rawResult,
                completedAt: nowIso()
              }
            : agent
        );
      });
      await this.store.appendEvent(
        cancelledByStopAgent
          ? {
              type: "agent_cancelled",
              runId: next.id,
              phaseId,
              agentId,
              at: nowIso()
            }
          : {
              type: "agent_failed",
              runId: next.id,
              phaseId,
              agentId,
              at: nowIso(),
              error: message
            }
      );
    } finally {
      clearInterval(controlTimer);
    }
  }

  private async completeRun(summary: RunSummary) {
    const next = await this.store.readSummary(summary.id);
    refreshPhaseCounts(next);
    next.status = next.totals.failedAgents > 0 ? "failed" : "completed";
    next.completedAt = nowIso();
    const markdown = this.buildFinalReport(next);
    const finalReportPath = await this.store.writeFinalReport(next.id, markdown);
    next.finalReportPath = finalReportPath;
    await this.store.writeSummary(next);
    await this.store.appendEvent({
      type: "run_completed",
      runId: next.id,
      at: nowIso(),
      finalReportPath
    });
    return next;
  }

  private buildFinalReport(summary: RunSummary) {
    const completed = summary.agents.filter((agent) => agent.status === "completed").length;
    const failed = summary.agents.filter((agent) => agent.status === "failed").length;
    const findings = summary.agents.flatMap((agent) => agent.findings ?? []);
    const confirmed = findings.filter((finding) => finding.verdict === "confirmed");
    const needsReview = findings.filter((finding) => finding.verdict === "needs-human-review");
    const falsePositive = findings.filter((finding) => finding.verdict === "false-positive");
    const modelCounts = new Map<string, number>();
    for (const agent of summary.agents) {
      const model = agent.model ?? "default";
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
    const lines = [
      `# ${summary.name}`,
      "",
      summary.description,
      "",
      `- Status: ${summary.status}`,
      `- Agents: ${completed}/${summary.agents.length} completed`,
      `- Failed: ${failed}`,
      `- Tokens: ${Math.round(summary.totals.tokens).toLocaleString()}`,
      `- Tools: ${summary.totals.tools.toLocaleString()}`,
      `- Models: ${Array.from(modelCounts.entries())
        .map(([model, count]) => `${model} (${count})`)
        .join(", ")}`,
      `- Confirmed findings: ${confirmed.length}`,
      `- Needs human review: ${needsReview.length}`,
      `- False positives filtered: ${falsePositive.length}`,
      "",
      "## Executive Summary",
      "",
      failed > 0
        ? `${failed} agent(s) failed. Review failed agent details before trusting this report.`
        : confirmed.length > 0
          ? `${confirmed.length} confirmed finding(s) survived workflow validation.`
          : "No confirmed findings survived validation. Review needs-human-review items before treating the run as clean.",
      "",
      "## Confirmed Findings",
      "",
      ...(confirmed.length
        ? confirmed.map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.summary}\n   Evidence: ${finding.evidence.join("; ")}${finding.repro ? `\n   Repro: ${finding.repro}` : ""}`
          )
        : ["None."]),
      "",
      "## Needs Human Review",
      "",
      ...(needsReview.length
        ? needsReview.map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.summary}\n   Evidence: ${finding.evidence.join("; ")}${finding.repro ? `\n   Repro: ${finding.repro}` : ""}`
          )
        : ["None."]),
      "",
      "## Phase Results",
      ""
    ];
    for (const phase of summary.phases) {
      lines.push(
        `### ${phase.title}`,
        "",
        `Status: ${phase.status}. Agents: ${phase.completedAgents}/${phase.totalAgents} completed, ${phase.failedAgents} failed.`,
        ""
      );
      for (const agent of summary.agents.filter((item) => item.phaseId === phase.id)) {
        lines.push(
          `#### ${agent.title}`,
          "",
          `- Status: ${agent.status}${agent.error ? ` (${agent.error})` : ""}`,
          `- Model: ${agent.model ?? "default"}`,
          `- Reasoning: ${agent.reasoningEffort ?? "default"}`,
          `- Tokens: ${Math.round(agent.tokens).toLocaleString()}`,
          `- Tools: ${agent.tools.toLocaleString()}`,
          ""
        );
        if (agent.findings?.length) {
          for (const finding of agent.findings) {
            lines.push(
              `- [${finding.verdict}/${finding.severity}] ${finding.summary}`,
              `  Evidence: ${finding.evidence.join("; ")}`,
              finding.repro ? `  Repro: ${finding.repro}` : "",
              ""
            );
          }
        } else if (agent.result) {
          lines.push(agent.result.split("\n").slice(0, 18).join("\n"), "");
        }
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  private async throwIfStopped(runId: string) {
    const control = await this.store.readControl(runId);
    if (control?.type === "stop") {
      throw new WorkflowStoppedError();
    }
  }

  private async waitIfPaused(summary: RunSummary) {
    let control = await this.store.readControl(summary.id);
    if (control?.type !== "pause") {
      return;
    }
    let next = await this.store.readSummary(summary.id);
    next.status = "paused";
    refreshPhaseCounts(next);
    await this.store.writeSummary(next);
    await this.store.appendEvent({ type: "run_paused", runId: summary.id, at: nowIso() });
    while (control?.type === "pause") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      control = await this.store.readControl(summary.id);
      if (control?.type === "stop") {
        throw new WorkflowStoppedError();
      }
    }
    next = await this.store.readSummary(summary.id);
    next.status = "running";
    refreshPhaseCounts(next);
    await this.store.writeSummary(next);
    await this.store.appendEvent({ type: "run_resumed", runId: summary.id, at: nowIso() });
  }

  private async mutateSummary(
    runId: string,
    mutate: (summary: RunSummary) => void
  ): Promise<RunSummary> {
    const task = this.summaryLock.then(async () => {
      const summary = await this.store.readSummary(runId);
      mutate(summary);
      refreshPhaseCounts(summary);
      await this.store.writeSummary(summary);
      return summary;
    });
    this.summaryLock = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
}

export async function runWorkflow(options: RunWorkflowOptions) {
  const store = new RunStore(path.resolve(options.cwd));
  const runner = new WorkflowRunner(store);
  return runner.run(options);
}
