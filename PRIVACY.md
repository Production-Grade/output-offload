# Privacy

output-offload collects nothing for anyone. When a tool result is too big, it saves the result to `.claude-offload/` in your project, on your machine. It then sends up to 24,000 characters of that result to a Claude model, through Claude Code's own model connection, to write a digest. That is the same service your session already uses. Nothing goes to any other service.

Questions: open an issue at https://github.com/Production-Grade/output-offload/issues, or email support@productiongrade.tech
