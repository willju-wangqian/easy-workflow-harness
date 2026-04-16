---
type: rule
required_frontmatter:
  - name
  - description
  - scope
  - severity
  - inject_into
  - verify
---

## Frontmatter Reference

| Field | Required | Description | Valid values |
|---|---|---|---|
| `name` | yes | Rule identifier (matches filename without .md) | kebab-case string |
| `description` | yes | One-line summary of what this rule enforces | free text |
| `scope` | yes | Tags indicating which domains this rule applies to | array of strings (e.g., `[code, security]`) |
| `severity` | yes | How strictly the rule is enforced | `default` (advisory) or `critical` (triggers compliance check) |
| `inject_into` | yes | Advisory: which agents this rule is intended for | array of agent names (e.g., `[coder, reviewer]`) |
| `verify` | yes | Shell command for automated compliance checking | valid shell command string, or `null` if no automated check |

## Body Structure

The rule body should contain one or more sections with actionable instructions. Common patterns from existing rules:

- **Behavioral directives** — imperative statements agents must follow (e.g., "Run the full test suite after every change")
- **Checklists** — grouped items agents evaluate (e.g., review criteria by severity)
- **Output format** — if the rule requires structured output from the agent

Each section should be specific enough to be enforceable — avoid vague guidance like "write good code."

## Validation Checklist

- [ ] All required frontmatter fields present and non-empty
- [ ] `name` matches the filename (without .md extension)
- [ ] `severity` is either `default` or `critical`
- [ ] If `severity: critical`, `verify` contains a valid shell command (not null)
- [ ] `inject_into` lists agent names that exist in the plugin or project
- [ ] `scope` tags are relevant to the rule's content
- [ ] Body contains at least one section with actionable instructions
- [ ] Instructions are specific enough to evaluate pass/fail
- [ ] No overlap with existing rules (check `rules/` and `.claude/rules/`)
