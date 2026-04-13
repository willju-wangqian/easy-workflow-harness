# Task Completion Checklist

Since this is a pure-Markdown repo with no build/lint/test tooling:

1. **Verify frontmatter** — all modified agent/rule/workflow .md files have correct required frontmatter fields
2. **Check AGENT_COMPLETE** — any modified agent definition still ends with the sentinel instruction
3. **Check HARNESS.md version** — bump version in frontmatter if this is a release-worthy change
4. **Update CHANGELOG.md** — for user-visible changes
5. **Manual smoke test** — load via `claude --plugin-dir .` in a test project and exercise the changed workflow/agent
6. **Specs** — if the change reflects a design decision, update or create a spec in `specs/`

No automated linting, formatting, or test commands to run.
