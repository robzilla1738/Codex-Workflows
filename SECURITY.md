# Security

Please report security issues privately.

Use GitHub private vulnerability reporting if it is enabled for the repo. If it
is not available, open a minimal public issue that asks for a private contact
path, without posting exploit details.

Do not post full exploit details publicly for a vulnerability in the workflow
runtime, MCP server, plugin packaging, or worker sandbox behavior.

Useful details to include:

- Codex version.
- Node version.
- Operating system.
- Whether the run used `adapter: sdk`, `adapter: exec`, or `adapter: simulate`.
- The workflow file, if you can share it.
- The run directory layout, with secrets removed.

This project treats workflow script isolation as part of the security boundary.
Workflow scripts should not receive direct filesystem, shell, network, process,
or Node built-in access.
