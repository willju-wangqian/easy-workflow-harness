#!/usr/bin/env python3
"""Assert pass/fail for a single EWH override check against a Claude Code .jsonl session file."""
import json, sys

def load_blocks(jsonl_path):
    texts, prompts = [], []
    with open(jsonl_path) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get('type') != 'assistant':
                continue
            for block in obj.get('message', {}).get('content', []):
                if block.get('type') == 'text':
                    texts.append(block['text'])
                elif block.get('type') == 'tool_use' and block.get('name') == 'Agent':
                    prompts.append(block.get('input', {}).get('prompt', ''))
    return '\n'.join(texts), '\n'.join(prompts)

# t = joined dispatcher text blocks; p = joined Agent tool prompt parameters
CHECKS = {
    '1': lambda t, p: 'PROJECT-OVERRIDE-MARKER' in p,
    '2': lambda t, p: 'PROJECT-EXTENSION-MARKER' in p and 'Before You Start' in p,
    '3': lambda t, p: 'PROJECT-RULE-MARKER' in p and 'Minimal diff' in p,
    '4': lambda t, p: 'SUBDIR-RULE-MARKER' in p and '.claude/rules/ewh/coding.md' in p,
    '5': lambda t, p: 'SUBDIR-RULE-MARKER' in p and 'PROJECT-RULE-MARKER' in p,
    '6': lambda t, p: 'PROJECT-WORKFLOW-OVERRIDE' in t or 'project-only-step' in t,
}

if len(sys.argv) < 3:
    print("Usage: parse_log.py <jsonl_path> <check_id> [--debug]", file=sys.stderr)
    sys.exit(2)

jsonl_path, check_id = sys.argv[1], sys.argv[2]
debug = '--debug' in sys.argv

if check_id not in CHECKS:
    print(f"Unknown check id: {check_id}", file=sys.stderr)
    sys.exit(2)

texts, prompts = load_blocks(jsonl_path)

if debug:
    print(f"[debug] session: {jsonl_path}", file=sys.stderr)
    print(f"[debug] dispatcher text ({len(texts)} chars):\n{texts[:800]}", file=sys.stderr)
    print(f"[debug] agent prompts ({len(prompts)} chars):\n{prompts}", file=sys.stderr)

sys.exit(0 if CHECKS[check_id](texts, prompts) else 1)
