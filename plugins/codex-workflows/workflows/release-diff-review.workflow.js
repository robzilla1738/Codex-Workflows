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
  maxFindings: 32
};

const synthesizeContext = {
  phaseIds: ["verify", "probe"],
  verdicts: ["confirmed", "needs-human-review"],
  mode: "all",
  maxFindings: 48
};

export default workflow({
  name: "release-diff-review-v2",
  version: "1",
  description:
    "Exhaustive adversarial review of v1.1.2...main for Harness v1.2.0 (robust JSON-text contract)",
  maxConcurrency: 64,
  maxAgents: 2000,
  phases: [
    {
      id: "find",
      title: "Find",
      agents: [
        {
          id: "reflow-engine",
          title: "reflow-engine",
          prompt:
            "Review the release diff for reflow engine regressions. Return findings as strict JSON text with severity, evidence, and repro notes.",
          model: "Codex",
          expectedTokens: 109000,
          expectedTools: 91,
          durationMs: 820
        },
        {
          id: "concurrency",
          title: "concurrency",
          prompt:
            "Review the release diff for concurrency, lifecycle, and race condition regressions. Return adversarial findings as strict JSON text.",
          model: "Codex",
          expectedTokens: 138500,
          expectedTools: 95,
          durationMs: 760
        },
        {
          id: "osc-protocol",
          title: "osc-protocol",
          prompt:
            "Review OSC protocol changes for compatibility, escaping, parsing, and terminal behavior regressions.",
          model: "Codex",
          expectedTokens: 119700,
          expectedTools: 79,
          durationMs: 720
        },
        {
          id: "qol-regressions",
          title: "qol-regressions",
          prompt:
            "Find quality-of-life regressions in the release diff, including settings defaults, copy, focus, and repeated workflows.",
          model: "Codex",
          expectedTokens: 129800,
          expectedTools: 114,
          durationMs: 690
        },
        {
          id: "chrome-ui",
          title: "chrome-ui",
          prompt:
            "Review Chrome and browser UI integration paths for regressions, missing states, and stale assumptions.",
          model: "Codex",
          expectedTokens: 128400,
          expectedTools: 110,
          durationMs: 740
        },
        {
          id: "settings-persistence",
          title: "settings-persistence",
          prompt:
            "Review settings persistence, migrations, defaults, and recovery paths for user-visible regressions.",
          model: "Codex",
          expectedTokens: 93300,
          expectedTools: 90,
          durationMs: 610
        },
        {
          id: "techdebt-docs",
          title: "techdebt-docs",
          prompt:
            "Find release blockers from stale docs, incorrect commands, tech debt, or missing operational handoff details.",
          model: "Codex",
          expectedTokens: 100300,
          expectedTools: 134,
          durationMs: 840
        },
        {
          id: "renderer-input",
          title: "renderer-input",
          prompt:
            "Review renderer and input handling for regressions across keyboard, mouse, focus, paste, IME, and selection behavior.",
          model: "Codex",
          expectedTokens: 134700,
          expectedTools: 77,
          durationMs: 700
        },
        {
          id: "hunk-sweep-r2",
          title: "hunk-sweep-r2",
          prompt:
            "Sweep every changed hunk for subtle breakage, missed tests, and inconsistent assumptions.",
          model: "Codex",
          expectedTokens: 154500,
          expectedTools: 109,
          durationMs: 900
        },
        {
          id: "interactions-r2",
          title: "interactions-r2",
          prompt:
            "Review cross-feature interactions in the release diff and identify issues that only appear when features combine.",
          model: "Codex",
          expectedTokens: 146000,
          expectedTools: 125,
          durationMs: 860
        },
        {
          id: "deletions-r2",
          title: "deletions-r2",
          prompt:
            "Review deleted code and removed docs for behavior that still needs replacement, migration, or preservation.",
          model: "Codex",
          expectedTokens: 93500,
          expectedTools: 97,
          durationMs: 620
        },
        {
          id: "hunk-sweep-r3",
          title: "hunk-sweep-r3",
          prompt:
            "Third-pass hunk sweep. Focus only on cases previous agents are likely to miss.",
          model: "Codex",
          expectedTokens: 129300,
          expectedTools: 81,
          durationMs: 780
        },
        {
          id: "interactions-r3",
          title: "interactions-r3",
          prompt:
            "Third-pass interaction sweep. Try to falsify assumptions from earlier review passes.",
          model: "Codex",
          expectedTokens: 168200,
          expectedTools: 79,
          durationMs: 920
        },
        {
          id: "packaging-release",
          title: "packaging-release",
          prompt:
            "Review packaging, signing, versioning, release notes, and install/update surfaces for release blockers.",
          model: "Codex",
          expectedTokens: 112400,
          expectedTools: 88,
          durationMs: 740
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
          "Adversarially verify one candidate finding against the codebase. Return confirmed, false-positive, or needs-human-review as strict JSON text.",
        model: "Codex",
        contextFrom: verifyContext,
        expectedTokens: 62000 + index * 1200,
        expectedTools: 35 + (index % 19),
        durationMs: 450 + index * 12
      }))
    },
    {
      id: "probe",
      title: "Probe",
      agents: [
        {
          id: "live-smoke",
          title: "live-smoke",
          prompt:
            "Design a minimal live smoke plan for the riskiest confirmed release findings.",
          model: "Codex",
          contextFrom: probeContext,
          expectedTokens: 84000,
          expectedTools: 56,
          durationMs: 700
        },
        {
          id: "regression-tests",
          title: "regression-tests",
          prompt:
            "Identify missing regression tests for confirmed findings and propose exact test names.",
          model: "Codex",
          contextFrom: probeContext,
          expectedTokens: 76000,
          expectedTools: 49,
          durationMs: 660
        }
      ]
    },
    {
      id: "synthesize",
      title: "Synthesize",
      agents: [
        {
          id: "release-report",
          title: "release-report",
          prompt:
            "Synthesize verified findings into a release-readiness report with blockers, evidence, and recommended fixes.",
          model: "Codex",
          contextFrom: synthesizeContext,
          expectedTokens: 97000,
          expectedTools: 42,
          durationMs: 820
        }
      ]
    }
  ]
});
