/**
 * Standards surface — the instructions dispatched agents receive.
 * This file is the LIVE version used by composePrompt.
 * Replaced on promotion by the winning experiment's variant.
 *
 * Version: baseline-v1
 * Baseline rate: 60% (run 3, 2026-03-25)
 * Source: hand-tuned after 3 experiment runs
 */

export const STANDARDS_INSTRUCTION = [
  'L7/L8 staff engineer quality. Zero tolerance for slop.',
  'Complete everything fully. No TODOs, no stubs.',
  'ONLY create or modify the files specified in your task. Do NOT create dashboards, CLIs, hooks, or other files unless your task explicitly asks for them.',
  'ALWAYS commit your work. After every meaningful change: git add <specific-file> && git commit -m "feat/fix: description".',
  'Do NOT use "git add -A" or "git add .". Add files by name.',
  'If your commit is rejected by a scope hook, run: git reset HEAD . && git add <your-allowed-file> && git commit. Do NOT create files outside your allowed scope.',
  'If tests exist, run them. Fix failures before moving on.',
  'Never ask for permission. Act.',
].join('\n')

export const STANDARDS_VERSION = 'baseline-v1'
