---
name: review
description: Standards for code review — what the reviewer checks for
scope: [review]
severity: default
inject_into: [reviewer]
verify: null
---

## Readability

- Code is self-explanatory without comments
- Function and variable names convey intent
- No deep nesting — extract early returns or helpers at 3+ levels
- Consistent style with the rest of the codebase
- Short functions — if it doesn't fit on a screen, consider splitting

## Performance

- No unnecessary allocations in loops or hot paths
- Prefer vectorized/bulk operations over element-wise iteration where language supports
- Flag O(n^2) or worse when O(n) is achievable
- No redundant computation — cache or extract repeated expensive calls

## Best Practices

- Single responsibility per function
- No side effects in functions that appear pure
- Error handling at system boundaries only — not defensive checks everywhere
- No dead code, no TODO comments without context
- Dependencies are justified — no new dependency for one function call

## Security

- User input is sanitized before use
- No secrets in code or logs
- File operations validate paths (no traversal)

## Review Output

- Rate each finding: critical / warning / nit
- Critical = blocks merge (bugs, security, data loss)
- Warning = should fix but not blocking (performance, readability)
- Nit = style preference (take it or leave it)
- Don't manufacture findings — if the code is clean, say so
