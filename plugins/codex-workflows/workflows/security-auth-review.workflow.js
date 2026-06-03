export default workflow({
  name: "security-auth-review",
  version: "1",
  description:
    "Security-focused workflow for auth, permission, injection, secret handling, and unsafe tool-path review.",
  maxConcurrency: 12,
  maxAgents: 48,
  phases: [
    {
      id: "find",
      title: "Find",
      agents: [
        {
          id: "authz-authn",
          title: "authz-authn",
          prompt:
            "Audit authentication and authorization paths for bypasses, missing checks, confused deputy bugs, and unsafe defaults. Return strict JSON findings only."
        },
        {
          id: "injection",
          title: "injection",
          prompt:
            "Audit shell, SQL, template, path, prompt, and command injection risks. Return strict JSON findings only."
        },
        {
          id: "secrets",
          title: "secrets",
          prompt:
            "Audit secret handling, logs, env vars, tokens, credentials, and accidental exfiltration paths. Return strict JSON findings only."
        },
        {
          id: "filesystem-sandbox",
          title: "filesystem-sandbox",
          prompt:
            "Audit filesystem access, sandbox boundaries, path traversal, symlink behavior, and destructive operations. Return strict JSON findings only."
        },
        {
          id: "network-mcp",
          title: "network-mcp",
          prompt:
            "Audit network, MCP, plugin, and external tool boundaries for unsafe trust assumptions. Return strict JSON findings only."
        }
      ]
    },
    {
      id: "verify",
      title: "Verify",
      agents: Array.from({ length: 10 }, (_, index) => ({
        id: `security-claim-${String(index + 1).padStart(2, "0")}`,
        title: `security-claim-${String(index + 1).padStart(2, "0")}`,
        prompt:
          "Adversarially verify one candidate security finding. Prefer false-positive unless evidence proves impact. Return strict JSON findings only.",
        expectedTokens: 70000 + index * 1500,
        expectedTools: 40 + (index % 11),
        durationMs: 520 + index * 18
      }))
    },
    {
      id: "probe",
      title: "Probe",
      agents: [
        {
          id: "exploitability",
          title: "exploitability",
          prompt:
            "For plausible security issues, assess exploitability and minimal safe repro steps without destructive actions. Return strict JSON findings only."
        },
        {
          id: "hardening-tests",
          title: "hardening-tests",
          prompt:
            "Propose exact hardening tests and acceptance criteria for confirmed security findings. Return strict JSON findings only."
        }
      ]
    },
    {
      id: "synthesize",
      title: "Synthesize",
      agents: [
        {
          id: "security-report",
          title: "security-report",
          prompt:
            "Synthesize verified security findings into a release-ready security report with severity, evidence, and fixes. Return strict JSON findings only."
        }
      ]
    }
  ]
});
