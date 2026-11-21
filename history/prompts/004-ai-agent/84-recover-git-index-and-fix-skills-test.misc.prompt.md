---
id: 84
title: Recover Git Index And Fix Skills Test
stage: misc
date: 2026-11-21
surface: agent
model: claude-opus-5-5
feature: 004-ai-agent
branch: 004-ai-agent
user: Muhammad Yaseen
command: none
labels: ["crash-recovery", "git", "ci", "flaky-assertion", "us5"]
links:
  spec: specs/004-ai-agent/spec.md
  ticket: null
  adr: null
  pr: https://github.com/my5757980/whatsapp-bulk-messaging/pull/5
files:
 - .git/index (rebuilt from HEAD; the zeroed copy kept as .git/index.corrupt-20261121132221)
 - apps/api/test/integration/ai-skills.int-spec.ts
tests:
 - CI for 5aa3271 (US4): all green
 - CI for bd96667 (US5): build-test failed at ai-skills.int-spec.ts:168 (expected the request not to contain 'late')
 - git fsck --connectivity-only: clean; eslint and tsc clean after the fix
---

## Prompt

continue

## Response snapshot

After the session restart:

- **Git index:** `git status` reported "index file corrupt". The crash had zeroed `.git/index` at 12:22, after the US5 commit `bd96667` (12:16, already pushed).
  - The broken index was copied to `.git/index.corrupt-20261121132221` and rebuilt from HEAD with `git reset`, which leaves the working tree alone. `git fsck` is clean.
- **Uncommitted fix found:** the only change since the US5 commit was an unfinished fix to the US5 integration test.
  - CI had failed because the test asserted that the second model request did not contain "late", a word that also occurs inside other words in the platform rules.
  - The fix gives the slow reply a unique status string and checks the exact JSON-escaped `reason`.
  - It was verified, linted, type-checked, committed and pushed.

## Outcome

- ✅ Impact: repository healthy again; the US5 CI failure fixed.
- 🧪 Tests: lint/typecheck pass; CI re-runs on push.
- 📁 Files: listed above.
- 🔁 Next prompts: watch CI; then US6 (work together with chatbot flows).
- 🧠 Reflection: negative assertions on whole request bodies need unique markers. Common words appear inside other words in the prompt.

## Evaluation notes (flywheel)

- Failure modes observed: crash zeroed the git index; substring assertion matched inside another word.
- Graders run and results (PASS/FAIL): CI US4 PASS; CI US5 FAIL (one assertion); local lint/tsc PASS after the fix.
- Prompt variant (if applicable): null
- Next experiment (smallest change to try): use unique markers (suffixes) in every not.toContain check on prompts.
