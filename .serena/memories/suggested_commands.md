# Suggested Commands

## Local Testing
```bash
# Load the plugin and test in any project
claude --plugin-dir /path/to/easy-workflow-harness

# Then inside Claude Code:
/ewh:doit list                          # list workflows
/ewh:doit init                          # bootstrap project CLAUDE.md
/ewh:doit add-feature "description"    # run a workflow
/ewh:doit add-feature --auto-approval  # skip startup gate for this workflow
```

## No Build / No Lint / No Tests
This repo has no build step, no lint command, and no automated test suite.
Changes are .md files only. "Testing" means loading the plugin in Claude Code and exercising it manually.

## Git
Standard git — main branch. Commit .md changes directly.

## Docs Build (optional)
node_modules present for remark/rehype docs rendering — not part of core development.
