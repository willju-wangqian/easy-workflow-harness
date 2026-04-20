Easy Workflow Harness — Available Commands

Workflows (multi-step, agent-driven):
  /ewh:doit add-feature [desc]      — plan, implement, review, and test a new feature
  /ewh:doit refine-feature [desc]   — scan, suggest, and apply improvements
  /ewh:doit update-knowledge [desc] — update CLAUDE.md and project docs
  /ewh:doit check-fact [desc]       — cross-validate docs against source code

Subcommands (lightweight, interactive):
  /ewh:doit init                    — bootstrap project and show onboarding guide
  /ewh:doit cleanup                 — run user-configured cleanup tasks
  /ewh:doit create [type]           — scaffold a rule, agent, or workflow
  /ewh:doit expand-tools [desc]     — discover and assign agent tools
  /ewh:doit status                  — report in-flight runs from .ewh-artifacts/
  /ewh:doit resume [<run-id>]       — re-emit the stored instruction for a run
  /ewh:doit abort [<run-id>]        — abort a run (syntactic sugar for report --abort)
  /ewh:doit doctor                  — environment/config health checks (use --smoke for CI)
  /ewh:doit list                    — show this catalog

Flags:
  --trust                           — auto-approve structural gates this run (use with --save to persist)
  --yolo                            — --trust + auto-skip compliance (never persisted)
  --max-retries N                   — override max_error_retries for this run (use with --save to persist)
  --save                            — persist applied flag values to workflow_settings
  --strict                          — enable strict drift detection for this run
  --manage-scripts                  — manage cached scripts before a workflow run; use with /ewh:doit <workflow>
  --manage-tasks                    — configure cleanup tasks; use with /ewh:doit cleanup
  --no-override                     — force built-in subcommand when a same-name project workflow exists; use with /ewh:doit <subcommand>
