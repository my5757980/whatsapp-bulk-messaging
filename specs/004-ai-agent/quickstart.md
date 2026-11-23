# Quickstart: AI Agent

**Feature**: `004-ai-agent` | **Plan**: [plan.md](./plan.md)

Builds on the 001–003 quickstarts: Docker services, `.env`, migrations, seed and `npm run dev` (web
:3000, api :4000, worker, mock-meta :4010). Connect a mock number in **Settings → Numbers** with
phone number id `MOCK_PHONE`, as 002 does.

## 1. Extra setup

```powershell
npm run db:migrate          # applies the 004 migration (agents, versions, knowledge, AI conversations, usage, assistant)
```

`.env` (see `.env.example`):

```dotenv
# Real model (costs money per reply; key from the company's Anthropic account):
ANTHROPIC_API_KEY=...        # secret
AI_MODEL=claude-opus-5-5     # optional; the default
# Or the free local fake model in mock-meta (no key needed):
ANTHROPIC_BASE_URL=http://localhost:4010/anthropic
```

Without a key and without `ANTHROPIC_BASE_URL`, agents fail closed: customers get the agent's
fallback message and the chat goes to Waiting for agent.

## 2. Simulate customers

```powershell
npm run mock:inbound -- --from +971500000001 --name "Sara" --text "do you deliver to Sharjah, how much?"
npm run mock:inbound -- --from +971500000001 --button-reply "Sharjah"
npm run mock:inbound -- --from +971500000001 --text "can I talk to someone from your team"
```

With the fake model, `POST http://localhost:4010/mock/ai/rules` scripts replies (for example a
hand-over when the text contains "refund"), and `GET http://localhost:4010/mock/ai/requests` shows
what the platform sent (check that no phone number appears).

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Answers from knowledge | In **AI agents**, create "Sales assistant": goal, tone, the guardrail "do not talk about other companies", the written answer "Delivery to Sharjah costs AED 50", a website page and a PDF. Choose the mock number and publish. Ask about Sharjah delivery in two wordings, ask a price that is not in the knowledge, ask for a poem, ask "am I talking to a real person?". | Replies state AED 50, labelled "Automatic · Sales assistant" in live chat, the first one starting with the introduction. The price question gets no price and appears under **Unanswered**. The poem is declined. The agent says it is a virtual assistant and offers a person. The website and PDF show Ready with their size. |
| US2 Hand-over and rules | Ask for a person in your own words; take, answer and close the chat; write again; send STOP; block the contact and write; start a flow by its keyword. | Waiting for agent with a summary note and no more AI replies; after closing, the agent answers again; STOP records the opt-out with no reply; nothing for the blocked contact; the flow answers its keyword, not the agent; no welcome message for messages the agent answered. |
| US3 Preview, test numbers, versions | Change the draft's tone; use **Test** to ask a question; add your phone as a test number and write from it and from another phone; publish twice and restore version 1. | The preview shows the reply, the knowledge used and "would save city = …" without changing the contact; the test phone gets the draft (marked test), the other phone the published agent; the draft takes version 1's settings. |
| US4 Rich replies and memory | Share "Price list.pdf" with a description, allow buttons and the attribute "city". Ask for the price list, say "I live in Al Ain", ask "which branch is closest?". Send a card number. | The file arrives with a caption; city = Al Ain in the profile with a journey entry by the agent; the Al Ain branch is suggested; the agent asks you not to share card numbers and saves nothing. |
| US5 API skills | Add "Order status" pointing at a test HTTPS endpoint returning `{"status":"shipped"}` for A-1234; ask "where is my order?", then give A-1234; make the endpoint fail; add a "Cancel booking" skill that changes data. | The agent asks for the number, then says "shipped"; on failure it offers a person and states no status; cancelling is called only after you confirm. `http://` and private addresses are refused when saving. |
| US6 Flows | With a "menu" keyword flow on the same number: send "menu", finish the flow, ask a free question. Add a "Hand to AI agent" step to a flow and run it. Give the agent a "Start a flow: Book a visit" skill and ask to book. | The flow answers "menu", the agent the free question; the hand-to-AI step ends the flow and the agent continues; the booking flow starts, and after it ends the agent answers again. |
| US7 Usage and limit | As an admin, set the monthly limit to 5 in **AI usage**; ask 6 questions from a test phone; raise the limit. | Replies 1–5 counted (test shown apart) with an estimated cost; alerts at 4 and 5; the 6th message goes to Waiting for agent with "AI reply limit reached"; after raising the limit the agent answers. |
| US8 Starters | Create an agent from "Lead qualification", accept creating its attributes, try to publish with the example answers, replace them and publish. | Publishing is refused with "replace me" problems listed; after replacing, it publishes and the conversation fills the attributes. |
| US9 Assistant | As a manager open **Assistant**: ask for a weekend sale template with a "Shop now" button; a flow that asks for name and city and hands over; a campaign of that template to VIP contacts; to raise the AI reply limit. | A template draft (not submitted) opens as **Review template draft** in the template editor, and submitting it there sends it to Meta; an unpublished flow draft opens in the flow editor; the campaign shows a preview with the recipient count and cost and sends only after Confirm (within 30 minutes); raising the limit is refused (admins only). |

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit: reply schema, prompt builder, masking, chunker, extraction, search query, limits, eligibility
npm run test:integration    # ai-agents-build-publish, ai-knowledge, ai-turns, ai-live-chat, ai-skills, ai-flows, ai-usage, ai-testing, ai-starters, ai-assistant (Claude mocked with nock), retention and contact deletion
npm run test:contract       # AI responses vs contracts/ai-api.openapi.yaml
npm run test:e2e            # Playwright: ai-us1 … ai-us9 with mock-meta's fake model
$env:PERF_NUMBER_ID="<number id>"; npm run perf:ai     # SC-001 overhead with the fake model (api and worker running)
```

Quality with the real model (costs money; run before release, with approval). The eval asks the
platform's preview chat, so the api and the worker run with the real key (`ANTHROPIC_API_KEY` in
`.env`, `ANTHROPIC_BASE_URL` empty); nothing is sent to WhatsApp:

```powershell
npm run eval:ai                                         # says what it would run (500 calls, about 30 minutes)
$env:EVAL_CONFIRM="yes"; npm run eval:ai                # runs it: SC-002, SC-003, SC-005 scores
# Review sheets (SC-003 replies, SC-010 hand-over summaries) are written to tools/eval/results/<time>/.
$env:EVAL_ONLY="person"; $env:EVAL_LIMIT="10"; $env:EVAL_CONFIRM="yes"; npm run eval:ai   # a short run of one set
```

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| The agent never answers | Is the agent published and chosen for this number? Is the chat Open? Did a flow keyword match first? Is the contact blocked or opted out? Is the monthly limit reached (AI usage)? |
| Every reply is the fallback message | `ANTHROPIC_API_KEY` missing or invalid, or the service is failing: see the `WbmAiFailing` alert and the worker log ("AI turn failed", with request ids, never prompts). |
| A website stays Failed | The error tells: not HTTPS, a private address, blocked by robots rules, or no readable text. |
| A PDF fails | "No text found" means a scanned image; export it with text or paste the content as written answers. |
| Answers miss facts that are in a long document | Over 120,000 characters the agent searches; check **Unanswered** and add written answers, which always win. |
