# Task Completion Checklist

For any code change in `src/`, `skills/doit/SKILL.md`, or workflow/agent/rule definitions:

1. **Typecheck** — `npm run typecheck` (tsc --noEmit). Must be clean.
2. **Tests** — `npm test`. All 341+ tests must pass. Add or update tests for new behavior.
3. **Build** — `npm run build`. `bin/ewh.mjs` must be regenerated and committed alongside the source change so cloned checkouts work.
4. **Frontmatter** — modified agent/rule/workflow .md files have correct required frontmatter (see `conventions.md`).
5. **AGENT_COMPLETE** — any modified agent definition still ends with the sentinel instruction.
6. **Version bumps** — if this is a release-worthy change, bump both `package.json` and `.claude-plugin/plugin.json` (keep in sync); update `HARNESS.md` version and `CHANGELOG.md`.
7. **Manual smoke test** — reload the plugin (`claude --plugin-dir .` or marketplace refresh) in a test project and exercise the changed workflow/agent.
8. **Specs** — if the change reflects a design decision, update `specs/SPECS.md` and supporting files via the brainstorming skill and `/specs` command.
