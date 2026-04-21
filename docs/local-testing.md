# Local Testing Plan

How to test `easy-workflow-harness` from the working tree without using the marketplace install path.

## Current State (2026-04-20)

- Marketplace `willju-plugins` is registered from dir `/Users/willju/development/easy-workflow-harness` (`~/.claude/plugins/known_marketplaces.json`).
- Plugin `ewh@willju-plugins` installed at:
  - `user` scope → `~/.claude/plugins/cache/willju-plugins/ewh/2.0.2` (frozen at commit `ebc3f67`).
  - `local` scope → project `/Users/willju/development/email_writer` (v1.0.0, older).
- The cached install is a **copy** at a commit SHA; edits to the working tree do NOT reflect until reinstall.

## 1. Uninstall Current Plugin + Marketplace

Run inside any Claude Code session:

```
/plugin uninstall ewh@willju-plugins          # removes user-scope install
/plugin marketplace remove willju-plugins      # de-registers the marketplace
```

If the project-local install in `email_writer` is still listed, open that project and run `/plugin uninstall ewh@willju-plugins` there too.

Then clean residue from the shell:

```bash
# delete cached plugin payloads
rm -rf ~/.claude/plugins/cache/willju-plugins
rm -rf ~/.claude/plugins/cache/temp_local_*

# verify marketplace de-registration
jq '.["willju-plugins"] // "gone"' ~/.claude/plugins/known_marketplaces.json
# expect: "gone"

# verify no ewh@willju-plugins remains
jq '.plugins["ewh@willju-plugins"] // "gone"' ~/.claude/plugins/installed_plugins.json
# expect: "gone"
```

## 2. Use the Local Working Tree

### Build first

```bash
cd /Users/willju/development/easy-workflow-harness
npm install            # once
npm run build          # rebuild after every change to src/
npm run typecheck      # optional sanity check
npm test               # vitest suite
```

`npm run build` compiles `src/` → `bin/ewh.mjs`. The `bin/ewh` wrapper invokes it.

### Launch Claude Code pointed at the working tree

```bash
claude --plugin-dir /Users/willju/development/easy-workflow-harness
```

This mounts the live repo as a plugin. Edits to Markdown files under `agents/`, `rules/`, `workflows/` take effect on the next command. Edits to `src/*.ts` require `npm run build` before they take effect.

## 3. Smoke Checks — Is It Working?

Inside a project with Claude Code running against `--plugin-dir`:

### 3a. Presence

```
/ewh:doit list
```

**Pass signals:**
- Output shows "Subcommands" block with `init`, `cleanup`, `create`, `expand-tools`.
- Output shows "Workflows" block with `add-feature`, `refine-feature`, `check-fact`, `update-knowledge`, `hello`, `trivial`.
- `ACTION: done` at the end of the session.

**Fail signals:**
- `/ewh:doit` is not recognized as a slash command.
- `ewh: command not found` appears from the shell injection at the top of the skill.
- `list` hangs or returns empty.

### 3b. Minimal workflow (sanity)

```
/ewh:doit hello
```

`hello` is the smallest workflow — one agent, one write. If this runs end-to-end and produces a file under `.ewh-artifacts/<run-id>/`, the dispatcher loop is intact.

**Pass signals:**
- A new `.ewh-artifacts/<run-id>/` dir with `state.json`, step prompt files, and a result file.
- The run ends with `ACTION: done` and a summary.
- No `ACTIVE` marker left behind (that only lingers on crashes).

**Fail signals:**
- Loop doesn't terminate.
- `ewh report` exits non-zero.
- `AGENT_COMPLETE` sentinel missing from the agent's output.
- State file becomes unreadable.

### 3c. Init subcommand

In a fresh scratch project:

```
/ewh:doit init
```

**Pass signals:**
- Appends a `## Harness Config` section to that project's `CLAUDE.md`.
- Writes an onboarding summary.

**Fail signals:**
- CLAUDE.md unchanged.
- Auto-detection picks obviously wrong language/test command.

### 3d. Full workflow (end-to-end)

Pick a trivial change in a scratch project:

```
/ewh:doit add-feature "add a --version flag"
```

**Pass signals:**
- Pauses at the **plan** structural gate (you can approve/abort).
- `coder` agent runs, writes changes, tests pass.
- `reviewer` runs read-only — it reports findings but does NOT edit source files (verify with `git status` after the review step).
- `tester` runs and adds/updates tests.
- Gates prompt for input where expected; `--trust` or `--yolo` skips them.

**Fail signals:**
- Reviewer edits source (indicates tool scoping broke).
- Gates never fire, or fire in wrong order.
- Artifacts under `.ewh-artifacts/<run>/` are missing or empty.
- Drift warnings appear in the log (`turn-log.jsonl`) when they shouldn't.

### 3e. Override resolution

Create a project override and re-run:

```bash
mkdir -p .claude/workflows
cp workflows/hello.md .claude/workflows/hello.md
# edit .claude/workflows/hello.md to change the description
/ewh:doit hello
```

**Pass signal:** the edited description appears, confirming project override wins over plugin workflow.

Then test `--no-override`:

```
/ewh:doit hello --no-override
```

**Pass signal:** falls back to the plugin version (only works for subcommand names; `hello` is a workflow so `--no-override` is a no-op — use `init` with a matching project workflow if you want to exercise this flag).

See `docs/testing-overrides.md` for a fuller override matrix (agent, rule, workflow).

### 3f. Crash-resume

Kill Claude mid-workflow (e.g., Ctrl-C during the code step). Re-run the same command:

```
/ewh:doit add-feature "..."
```

**Pass signal:** the dispatcher detects the `ACTIVE` marker and prompts to resume / abort / start fresh. Resuming picks up from the last saved transition.

## 4. Coverage of Major Features

| Feature | Where to verify |
|---|---|
| Binary dispatcher + SKILL.md shim | 3a, 3b |
| Subcommand state machines | 3c (also try `/ewh:doit cleanup --manage-tasks`, `/ewh:doit design "a new rule that forbids raw SQL"`) |
| Workflow step machine (gate / agent / artifact / compliance) | 3d |
| Structural / compliance / error gates | 3d — approve a gate, then re-run with `--trust` and `--yolo` |
| Agent tool scoping (reviewer cannot edit source) | 3d — `git status` after the review step |
| Rule injection & concatenation | drop a `.claude/rules/coding.md` supplement and confirm the coder prompt contains both plugin + project rule |
| Artifact handoff (`reads:` / `artifact:`) | 3d — inspect `.ewh-artifacts/<run>/step-N-prompt.md` for `## Required Reading` |
| Chunked dispatch | run `refine-feature` on a large directory; first run prompts for glob patterns and caches in `.claude/ewh-state.json` |
| Script proposal | run a workflow with a scriptable step, or `/ewh:doit add-feature --manage-scripts` |
| Drift detection | add an unrelated tool call during a step; expect warning (level 2) or halt (`--strict`, level 3) |
| Crash-resume | 3f |
| Override resolution | 3e + `docs/testing-overrides.md` |
| Expand-tools persistence | `/ewh:doit expand-tools "add Serena"` → check `.claude/ewh-state.json` and `.claude/agents/*.md` |

## 5. Quick Regression Loop

After editing `src/`:

```bash
cd /Users/willju/development/easy-workflow-harness
npm run build && npm run typecheck && npm test
```

Then in a scratch project:

```bash
claude --plugin-dir /Users/willju/development/easy-workflow-harness
# run: /ewh:doit list       (presence)
# run: /ewh:doit hello       (dispatcher loop)
# run: /ewh:doit add-feature "trivial change"   (full stack)
```

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ewh: command not found` at skill startup | `bin/ewh.mjs` not built — run `npm run build` |
| Skill loops forever | binary emitted bad ACTION; check `.ewh-artifacts/<run>/state.json` and stderr from `ewh report` |
| Reviewer edits source | tool scoping regressed; check `agents/reviewer.md` frontmatter |
| Plugin edits not visible | Claude Code cached a prior `--plugin-dir`; restart the CLI |
| Markdown edits not visible | none expected — those are read at runtime; if they don't apply, restart Claude Code |
| State file unreadable | likely corrupted; `rm -rf .ewh-artifacts/<run>` and restart the workflow |
