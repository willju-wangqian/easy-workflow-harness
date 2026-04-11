---
name: testing
description: Standards for how Claude writes and runs tests
scope: [testing]
severity: default
inject_into: [tester]
verify: null
---

## Principles

- Tests prove the code works, not that you wrote tests
- Each test case tests one behavior — name it after what it verifies
- Test the contract (inputs -> outputs), not the implementation
- Edge cases matter: nulls, empty inputs, boundary values, malformed data

## Structure

- Follow the project's existing test file patterns (from Harness Config)
- Group tests by the function or behavior they cover
- Setup/teardown should be minimal — prefer self-contained tests

## What to Test

- Happy path for every new/changed public function
- Error cases: does it fail correctly with bad input?
- Edge cases: empty, null, single-element, maximum-size
- Regression: if fixing a bug, write a test that reproduces it first

## What NOT to Test

- Private/internal helpers (test them through public API)
- Framework behavior (don't test that the framework works)
- Trivial getters/setters with no logic

## After Testing

- Run the full test suite, not just new tests
- Report: total pass/fail count, new tests added, any flaky tests observed
