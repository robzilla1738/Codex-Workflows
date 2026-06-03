import { useEffect, useMemo, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, useInput, useStdout } from "ink";
import type { AgentSummary, RunSummary } from "@codex-workflows/schemas";
import { nowIso, RunStore } from "@codex-workflows/runtime";
import { formatCount, formatDuration, truncateMiddle } from "./format.js";

export interface DashboardProps {
  cwd: string;
  runId: string;
  exitOnComplete?: boolean;
  onExit?: () => void;
}

const statusMark = (status: AgentSummary["status"]) => {
  if (status === "completed") {
    return "\u2713";
  }
  if (status === "running") {
    return "\u25B8";
  }
  if (status === "failed") {
    return "x";
  }
  return "\u25CF";
};

const statusColor = (status: AgentSummary["status"]) => {
  if (status === "completed") {
    return "green";
  }
  if (status === "running") {
    return "blue";
  }
  if (status === "failed") {
    return "red";
  }
  return "gray";
};

const phaseColor = (status: string, active: boolean) => {
  if (active) {
    return "blue";
  }
  if (status === "completed") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  return "gray";
};

export function DashboardFrame({
  summary,
  width,
  height = 32,
  selectedPhaseId,
  selectedAgentId,
  showDetail = true,
  detailOffset = 0
}: {
  summary: RunSummary;
  width: number;
  height?: number;
  selectedPhaseId?: string;
  selectedAgentId?: string;
  showDetail?: boolean;
  detailOffset?: number;
}) {
  const activePhase = summary.phases.find((phase) => phase.id === selectedPhaseId) ??
    summary.phases.find((phase) => phase.id === summary.selectedPhaseId) ??
    summary.phases.find((phase) => phase.status === "running") ??
    summary.phases[0];
  const phaseAgents = activePhase
    ? summary.agents.filter((agent) => agent.phaseId === activePhase.id)
    : summary.agents;
  const selectedAgent =
    phaseAgents.find((agent) => agent.id === selectedAgentId) ?? phaseAgents[0];
  const detailLineBudget = showDetail && selectedAgent ? Math.max(4, Math.min(8, height - 29)) : 0;
  const visibleAgentBudget = Math.max(
    5,
    Math.min(phaseAgents.length, height - 10 - (detailLineBudget > 0 ? detailLineBudget + 5 : 0))
  );
  const selectedIndex = Math.max(
    0,
    phaseAgents.findIndex((agent) => agent.id === selectedAgent?.id)
  );
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(visibleAgentBudget / 2),
      Math.max(0, phaseAgents.length - visibleAgentBudget)
    )
  );
  const listAgents = phaseAgents.slice(startIndex, startIndex + visibleAgentBudget);
  const sidebarWidth = Math.min(28, Math.max(20, Math.floor(width * 0.14)));
  const modelWidth = Math.min(22, Math.max(14, Math.floor(width * 0.1)));
  const metricsWidth = 42;
  const nameWidth = Math.max(18, width - sidebarWidth - modelWidth - metricsWidth - 14);
  const completed = summary.totals.completedAgents + summary.totals.failedAgents;
  const detailLines = selectedAgent?.result
    ?.split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(detailOffset, detailOffset + detailLineBudget);

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text color="blueBright" bold>
          {summary.name}
        </Text>
        <Text color="gray">
          {completed}/{summary.totals.totalAgents} agents ·{" "}
          {formatDuration(summary.totals.elapsedMs)}
        </Text>
      </Box>
      <Text color="gray">{summary.description}</Text>
      <Box marginTop={1} borderStyle="single" borderColor="gray">
        <Box width={sidebarWidth} flexDirection="column" borderStyle="single" borderTop={false} borderBottom={false} borderLeft={false}>
          <Text>Phases</Text>
          {summary.phases.map((phase, index) => {
            const active = phase.id === activePhase?.id;
            const mark = active ? "\u276F" : phase.status === "completed" ? "\u2713" : " ";
            return (
              <Text key={phase.id} color={phaseColor(phase.status, active)}>
                {mark} {index + 1} {truncateMiddle(phase.title, sidebarWidth - 10)}{" "}
                {phase.completedAgents}/{phase.totalAgents}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" paddingLeft={1} flexGrow={1}>
          <Text>
            <Text bold>{activePhase?.title ?? "Agents"}</Text>
            <Text color="gray"> · {phaseAgents.length} agents</Text>
          </Text>
          {listAgents.map((agent) => (
            <Box key={agent.id} justifyContent="space-between">
              <Box>
                <Text color={statusColor(agent.status)}>{statusMark(agent.status)} </Text>
                <Text inverse={agent.id === selectedAgent?.id}>
                  {truncateMiddle(agent.title, nameWidth)}
                </Text>
                <Text color="gray">
                  {" "}
                  {truncateMiddle(
                    agent.reasoningEffort
                      ? `${agent.model ?? "Codex"}:${agent.reasoningEffort}`
                      : agent.model ?? "Codex",
                    modelWidth
                  )}
                </Text>
              </Box>
              <Text color="gray">
                {formatCount(agent.tokens)} tok · {agent.tools} tools ·{" "}
                {formatDuration(agent.elapsedMs)}
              </Text>
            </Box>
          ))}
          {phaseAgents.length > listAgents.length ? (
            <Text color="gray">
              -- {startIndex + 1}-{startIndex + listAgents.length} of {phaseAgents.length} --
            </Text>
          ) : null}
        </Box>
      </Box>
      {showDetail && selectedAgent ? (
        <Box marginTop={1} borderStyle="single" borderColor="gray" flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>{truncateMiddle(selectedAgent.title, Math.max(24, width - 64))}</Text>
            <Text color="gray">
              {selectedAgent.status} · {selectedAgent.sandbox} ·{" "}
              {selectedAgent.model ?? "default"}
              {selectedAgent.reasoningEffort ? `:${selectedAgent.reasoningEffort}` : ""}
            </Text>
          </Box>
          {detailLines && detailLines.length > 0 ? (
            detailLines.map((line) => (
              <Text key={line} color="gray">
                {truncateMiddle(line, width - 4)}
              </Text>
            ))
          ) : (
            <Text color="gray">
              {selectedAgent.status === "running"
                ? "Agent is running. Live token/tool metrics update above."
                : truncateMiddle(selectedAgent.error ?? selectedAgent.prompt, width - 4)}
            </Text>
          )}
        </Box>
      ) : null}
      <Text color="gray" italic>
        ↑↓ select · ←→ phase · j/k scroll · r restart agent · x stop · p pause/resume · s save · q quit
      </Text>
    </Box>
  );
}

export function RunDashboard({ cwd, runId, exitOnComplete = false, onExit }: DashboardProps) {
  const store = useMemo(() => new RunStore(cwd), [cwd]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | undefined>();
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>();
  const [showDetail, setShowDetail] = useState(true);
  const [followActivePhase, setFollowActivePhase] = useState(true);
  const [detailOffset, setDetailOffset] = useState(0);
  const { stdout } = useStdout();
  const width = Math.max(88, stdout.columns || 120);
  const height = Math.max(24, stdout.rows || 32);

  useEffect(() => {
    let disposed = false;
    const tick = async () => {
      const next = await store.readSummary(runId).catch(() => null);
      if (!disposed && next) {
        setSummary(next);
        const targetPhaseId = followActivePhase
          ? next.selectedPhaseId ?? next.phases.find((phase) => phase.status === "running")?.id ?? next.phases[0]?.id
          : selectedPhaseId ?? next.selectedPhaseId ?? next.phases[0]?.id;
        setSelectedPhaseId(targetPhaseId);
        setSelectedAgentId((current) => {
          if (!followActivePhase && current && next.agents.some((agent) => agent.id === current)) {
            return current;
          }
          return next.agents.find((agent) => agent.phaseId === targetPhaseId && agent.status === "running")?.id ??
            next.agents.find((agent) => agent.phaseId === targetPhaseId)?.id;
        });
        if (
          exitOnComplete &&
          ["completed", "failed", "stopped"].includes(next.status)
        ) {
          setTimeout(() => onExit?.(), 250);
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 300);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [exitOnComplete, followActivePhase, onExit, runId, selectedPhaseId, store]);

  useInput((input, key) => {
    if (!summary) {
      return;
    }
    if (key.escape || input === "q") {
      onExit?.();
      return;
    }
    const activePhaseId = selectedPhaseId ?? summary.selectedPhaseId ?? summary.phases[0]?.id;
    const phaseIndex = Math.max(0, summary.phases.findIndex((phase) => phase.id === activePhaseId));
    const phaseAgents = summary.agents.filter((agent) => agent.phaseId === activePhaseId);
    const agentIndex = Math.max(0, phaseAgents.findIndex((agent) => agent.id === selectedAgentId));
    if (key.upArrow && phaseAgents.length > 0) {
      setSelectedAgentId(phaseAgents[Math.max(0, agentIndex - 1)]?.id);
      setDetailOffset(0);
      return;
    }
    if (key.downArrow && phaseAgents.length > 0) {
      setSelectedAgentId(phaseAgents[Math.min(phaseAgents.length - 1, agentIndex + 1)]?.id);
      setDetailOffset(0);
      return;
    }
    if ((key.leftArrow || key.rightArrow) && summary.phases.length > 0) {
      setFollowActivePhase(false);
      const nextPhase =
        summary.phases[
          key.leftArrow
            ? Math.max(0, phaseIndex - 1)
            : Math.min(summary.phases.length - 1, phaseIndex + 1)
        ];
      setSelectedPhaseId(nextPhase?.id);
      setSelectedAgentId(summary.agents.find((agent) => agent.phaseId === nextPhase?.id)?.id);
      setDetailOffset(0);
      return;
    }
    if (input === "j") {
      setDetailOffset((current) => current + 1);
      return;
    }
    if (input === "k") {
      setDetailOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (key.return) {
      setShowDetail((current) => !current);
      return;
    }
    if (input === "x") {
      void store.writeControl(
        runId,
        selectedAgentId
          ? { type: "stop-agent", at: nowIso(), agentId: selectedAgentId }
          : { type: "stop", at: nowIso() }
      );
    }
    if (input === "p") {
      void (async () => {
        const current = await store.readSummary(runId);
        await store.writeControl(runId, {
          type: current.status === "paused" ? "resume" : "pause",
          at: nowIso()
        });
      })();
    }
    if (input === "s") {
      void store.saveRunAsWorkflow(runId, summary?.name ?? runId);
    }
    if (input === "r" && selectedAgentId) {
      const child = spawn(
        process.execPath,
        [process.argv[1] ?? "", "restart-agent", runId, selectedAgentId, "--cwd", cwd],
        { stdio: "ignore", detached: true }
      );
      child.unref();
    }
  });

  if (!summary) {
    return <Text color="gray">Loading workflow run {runId}...</Text>;
  }
  return (
    <DashboardFrame
      summary={summary}
      width={width}
      height={height}
      selectedPhaseId={selectedPhaseId}
      selectedAgentId={selectedAgentId}
      showDetail={showDetail}
      detailOffset={detailOffset}
    />
  );
}
