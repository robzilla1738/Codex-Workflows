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
  maxFindings: 12
};

const synthesizeContext = {
  phaseIds: ["verify", "probe"],
  verdicts: ["confirmed", "needs-human-review"],
  mode: "all",
  maxFindings: 20
};

export default workflow({
  name: "bug-sweep",
  version: "2",
  description:
    "Bounded codebase-wide bug sweep with independent finding, verification, repro planning, and synthesis.",
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
            "Audit public interfaces such as CLI, API, plugin, config, and integration surfaces for broken flags, invalid defaults, missing validation, and control bugs. Return strict JSON findings only."
        },
        {
          id: "user-facing-flows",
          title: "user-facing-flows",
          prompt:
            "Audit user-facing flows for broken navigation, unreadable states, overflow, stale status, missing feedback, and workflow mismatches. Return strict JSON findings only."
        }
      ]
    },
    {
      id: "verify",
      title: "Verify",
      agents: Array.from({ length: 4 }, (_, index) => ({
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
          id: "repro-and-tests",
          title: "repro-and-tests",
          prompt:
            "For confirmed or plausible bugs, design minimal repro commands or manual steps and map them to exact regression test acceptance criteria. Return strict JSON findings only.",
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
