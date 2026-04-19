# Suggested Commands

## Build & Test
```bash
npm run build         # compile src/ → bin/ewh.mjs (esbuild)
npm run typecheck     # tsc --noEmit
npm test              # vitest run (unit + integration)
npm run test:coverage # vitest with v8 coverage
```

`bin/ewh.mjs` is the compiled artifact — rebuild after any source change before manual testing.

## Local Plugin Testing
```bash
# From any project, load the plugin in-place:
claude --plugin-dir /Users/willju/development/easy-workflow-harness

# Or via marketplace (pulls into ~/.claude/plugins/cache/):
# /plugin marketplace add /Users/willju/development/easy-workflow-harness
# /plugin install ewh@willju-plugins
```

## Inside Claude Code
```
/ewh:doit list                          # list workflows + subcommands
/ewh:doit init                          # bootstrap Harness Config into project CLAUDE.md
/ewh:doit add-feature "desc"            # run a workflow
/ewh:doit add-feature --trust           # auto-approve structural gates this run
/ewh:doit cleanup --manage-tasks        # configure cleanup tasks
/ewh:doit expand-tools "desc"           # discover and persist agent tool expansions
```

## Git
Standard git — main branch. Commit source changes and rebuilt `bin/ewh.mjs` together so cloned checkouts work without an install step.

## Docs Build (optional)
`npm run docs:build` renders `docs/` to HTML via remark/rehype (output is gitignored).
