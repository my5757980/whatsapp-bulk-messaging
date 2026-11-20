---
id: 47
title: Specify Shared Team Inbox
stage: spec
date: 2026-11-19
surface: agent
model: claude-opus-5-5
feature: 002-team-inbox
branch: 002-team-inbox
user: Muhammad Yaseen
command: /sp.specify
labels: ["spec", "team-inbox", "live-chat", "roadmap", "aisensy-parity"]
links:
  spec: specs/002-team-inbox/spec.md
  ticket: null
  adr: null
  pr: null
files:
 - specs/002-team-inbox/spec.md
 - specs/002-team-inbox/checklists/requirements.md
tests:
 - none (specification stage)
---

## Prompt

haaa to shuruuu karooo naaa kuee rukayyyy hoooo mujayy meraa plateform poora 1oo% wasayy hi work karnaa chiyaa aik aik cheezayy jasayyy wo website jis ko reverse engineering karwayaaaa haiiii

(Answers to the follow-up questions: build all features first; host on the company's own server; no Meta account yet. The features question was left unanswered, so all AiSensy-equivalent modules are in scope, in dependency order.)

/sp.specify feature description: "Shared team inbox (live chat) for our company's WhatsApp numbers — functionally equivalent to AiSensy's team inbox but with our own original design and wording. … Out of scope for this feature: chatbot flows, AI agent, ads, payments, mobile app." (full text in spec.md, Input line)

## Response snapshot

- **Roadmap set, in dependency order:**
  1. 002 team inbox
  2. chatbot flow builder
  3. AI agent
  4. tracking and integrations
  5. ads and payments
- **Kept in memory:** the decisions, in the `roadmap-after-001` memory.
- **Branch:** switched to the merged main, then created `002-team-inbox` with the spec-kit script (global feature number 002).
- **spec.md:**
  - Six prioritized user stories: P1 inbox and reply; P1 24-hour window and templates; P2 assign, resolve and notes; P2 media and quick replies; P3 business hours, away and welcome; P3 contact panel and metrics.
  - 34 functional requirements, including a permission table that lets agents reply.
  - 8 measurable success criteria, edge cases, assumptions, out-of-scope items and dependencies.
- **Clarifications:** none needed; informed defaults are documented.
- **Quality checklist:** all items pass.

## Outcome

- ✅ Impact: Feature 002 is specified and ready for planning. It is the base for the chatbot and AI agent features.
- 🧪 Tests: none at the spec stage.
- 📁 Files: spec.md and checklists/requirements.md.
- 🔁 Next prompts: `/sp.plan` (or `/sp.clarify`); meanwhile the user can start the Meta Business setup and verification.
- 🧠 Reflection: Feature parity with AiSensy is defined as behaviour, with original design and wording, matching the constitution and the user's earlier no-copy rule.

## Evaluation notes (flywheel)

- Failure modes observed: the per-short-name numbering rule would have produced "001-team-inbox", so the global sequence (002) was used to keep features ordered.
- Graders run and results (PASS/FAIL): spec quality checklist PASS (first iteration).
- Prompt variant (if applicable): N/A
- Next experiment (smallest change to try): N/A
