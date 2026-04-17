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
  /ewh:doit list                    — show this catalog

Flags:
  --auto-approval / --need-approval — toggle startup confirmation per workflow; use with /ewh:doit <workflow>
  --manage-scripts                  — manage cached scripts before a workflow run; use with /ewh:doit <workflow>
  --manage-tasks                    — configure cleanup tasks; use with /ewh:doit cleanup
  --no-override                     — force built-in subcommand when a same-name project workflow exists; use with /ewh:doit <subcommand>
