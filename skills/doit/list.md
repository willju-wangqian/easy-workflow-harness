Easy Workflow Harness — Available Commands

Workflows run from the project's .claude/ewh-workflows/<name>.json contract.
Plugin workflows/ files are templates — run /ewh:doit design <name> to create
your own pair, or /ewh:doit migrate to upgrade a legacy .claude/workflows/*.md
tree.

Example workflow templates shipped with the plugin (adopt via `design`):
  add-feature, refine-feature, update-knowledge, check-fact

Subcommands (lightweight, interactive):
  /ewh:doit init                    — bootstrap project and show onboarding guide
  /ewh:doit cleanup                 — run user-configured cleanup tasks
  /ewh:doit design "<desc>"         — design a rule, agent, or workflow conversationally
  /ewh:doit design modify <target>  — modify an existing agent/rule or workflow step via LLM ferry
  /ewh:doit manage <workflow>       — fill runtime fields (context, produces, gate, …) for a workflow contract
  /ewh:doit migrate                 — one-shot: .claude/workflows/*.md → .claude/ewh-workflows/*.{md,json}
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
