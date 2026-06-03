const verifyContext = {
  phaseIds: ["find"],
  verdicts: ["confirmed", "needs-human-review"],
  mode: "by-index",
  maxFindings: 1
};

const probeContext = {
  phaseIds: ["verify"],
  verdicts: ["confirmed", "needs-human-review"],
  mode: "all",
  maxFindings: 48
};

const synthesizeContext = {
  phaseIds: ["verify", "probe"],
  verdicts: ["confirmed", "needs-human-review"],
  mode: "all",
  maxFindings: 64
};

export default workflow({
  name: "bug-sweep-deep",
  version: "1",
  description:
    "Deep codebase-wide adversarial bug sweep with broad finding, verification, repro planning, and synthesis.",
  maxConcurrency: 64,
  maxAgents: 2000,
  phases: [
    {
      id: "find",
      title: "Find",
      agents: [
        {
          id: "runtime-correctness",
          title: "runtime-correctness",
          prompt:
            "Audit runtime correctness bugs: state transitions, async races, lifecycle gaps, stale caches, and edge cases. Return strict JSON findings only."
        },
        {
          id: "data-contracts",
          title: "data-contracts",
          prompt:
            "Audit schemas, parsing, serialization, migrations, and compatibility contracts for bugs. Return strict JSON findings only."
        },
        {
          id: "public-interfaces",
          title: "public-interfaces",
          prompt:
            "Audit CLI, API, plugin, config, and integration surfaces for broken flags, invalid defaults, missing validation, and workflow control bugs. Return strict JSON findings only."
        },
        {
          id: "user-facing-flows",
          title: "user-facing-flows",
          prompt:
            "Audit user-facing flows for broken navigation, unreadable states, overflow, stale status, missing feedback, and control mismatches. Return strict JSON findings only."
        },
        {
          id: "integration-boundaries",
          title: "integration-boundaries",
          prompt:
            "Audit external integrations, subprocess boundaries, network calls, generated artifacts, and cross-component assumptions for subtle failures. Return strict JSON findings only."
        },
        {
          id: "persistence-recovery",
          title: "persistence-recovery",
          prompt:
            "Audit persistence, checkpointing, resume/retry, restart, recovery, and artifact durability paths. Return strict JSON findings only."
        }
      ]
    },
    {
      id: "verify",
      title: "Verify",
      agents: Array.from({ length: 24 }, (_, index) => ({
        id: `claim-${String(index + 1).padStart(2, "0")}`,
        title: `claim-${String(index + 1).padStart(2, "0")}`,
        prompt:
          "Adversarially verify the assigned candidate bug from the find phase. Try to disprove it first. Return confirmed, false-positive, or needs-human-review as strict JSON findings only.",
        contextFrom: verifyContext
      }))
    },
    {
      id: "probe",
      title: "Probe",
      agents: [
        {
          id: "minimal-repros",
          title: "minimal-repros",
          prompt:
            "For confirmed or plausible bugs, design minimal repro commands or manual steps. Mark anything unproven as needs-human-review. Return strict JSON findings only.",
          contextFrom: probeContext
        },
        {
          id: "regression-tests",
          title: "regression-tests",
          prompt:
            "Map confirmed or plausible bugs to exact regression test files, test names, and acceptance criteria. Return strict JSON findings only.",
          contextFrom: probeContext
        }
      ]
    },
    {
      id: "synthesize",
      title: "Synthesize",
      agents: [
        {
          id: "bug-report",
          title: "bug-report",
          prompt:
            "Synthesize confirmed bugs, false positives, and needs-human-review items into a prioritized bug report. Return strict JSON findings only.",
          contextFrom: synthesizeContext
        }
      ]
    }
  ]
});
