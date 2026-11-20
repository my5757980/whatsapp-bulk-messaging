# Quickstart: Chatbot Flow Builder

**Feature**: `003-chatbot-flow-builder` | **Plan**: [plan.md](./plan.md)

Builds on the 001 and 002 quickstarts: Docker services, `.env`, migrations, seed and `npm run dev`
(web :3000, api :4000, worker, mock-meta :4010). Connect a mock number in **Settings → Numbers** with
phone number id `MOCK_PHONE`, as 002 does.

## 1. Extra setup

```powershell
npm run db:migrate          # applies the 003 migration (flows, versions, triggers, sessions, secrets)
```

No new environment variables. API-step secrets are encrypted with the existing `TOKEN_ENCRYPTION_KEY`.

## 2. Simulate customers

```powershell
npm run mock:inbound -- --from +971500000001 --name "Sara" --text "what are your hours?"
npm run mock:inbound -- --from +971500000001 --button-id "<id from the last flow message>" --button-reply "Location"
npm run mock:inbound -- --from +971500000001 --list-id "<row id>" --list-reply "Dubai Marina"
npm run mock:inbound -- --from +971500000001 --quick-reply "Yes, interested" --context "<wamid of the template message>"
npm run mock:inbound -- --from +971500000003 --text "Hi, I saw your ad for the sofa"   # a brand-new contact
```

The ids of buttons and list rows are in the flow message's details in live chat (or in
`GET http://localhost:4010/mock/sent`).

## 3. Validate each user story

| Story | Steps | Expected |
|---|---|---|
| US1 Keyword flow with buttons | In **Flows**, create "Opening hours", add the keyword trigger "hours" (contains), a buttons step with "Location" (→ a message with a library image) and "Talk to us" (→ hand-over). Publish. Send "what are your HOURS?", then tap "Location". | The buttons arrive within 3 s; tapping sends the address and image. Live chat shows each message as "Automatic · Opening hours". Publishing with an unconnected button is refused with the problem listed. |
| US2 Questions and attributes | Build "Book a visit" with text, date (today or later) and email questions saved to attributes, a list of branches, a 1-minute timeout branch and a final message using `{attr:full_name}`. Answer the date with "yesterday" twice, then correctly. | Two retry prompts, then the flow continues. The profile panel shows the new attributes; the final message has the values. Waiting more than a minute sends the timeout message. |
| US3 Hand-over and live chat | Run a flow to its hand-over step. Take the chat as an agent and reply. Send the keyword again; close the chat; send it again. Start a flow from the chat with **Start a flow**. Send STOP during a flow. | The chat goes to Waiting for agent. While taken, the keyword starts nothing; after closing, it starts the flow. STOP ends the flow with no flow reply. Welcome/off-hours messages never fire for messages a flow answered. |
| US4 Logic | Add a condition on the tag "VIP" and on working hours, an add-tag step, a 10-second delay and a jump to "Main menu". | The right branch runs for each case; the tag appears in the journey as added by the flow; the jump continues in Main menu. Two flows jumping to each other without a question cannot be published. |
| US5 API step | Point an API step at a test endpoint (for example a local HTTPS mock) returning `{"status":"shipped"}`, map `status` to `order_status`, use **Test request**, then run the flow. Make the endpoint slow. | The test shows status 200 and the reply. The customer sees "shipped". With the slow endpoint the failed branch runs within the timeout. `http://` and `https://10.0.0.5` are refused. |
| US6 Triggers | Link the "Yes, interested" button of a campaign template to "Lead follow-up"; add a pattern trigger `^ORD-\d{5}$`; add a first-message rule "saw your ad" with the tag "Sofa ad". | Tapping the template button starts the flow. "ORD-12345" starts the order flow. The new contact's profile shows the first-message tag "Sofa ad". |
| US7 Test numbers | Add your phone as a test number, change the draft's first message without publishing, and send the keyword from the test phone and from another phone. Unpublish. | The test phone gets the draft text (marked "test" in live chat); the other phone gets the published text. After unpublishing, the keyword starts nothing. |
| US8 Analytics | Run 10 sessions where 4 stop answering at the second question; open analytics for today. | Totals show 10 started and 4 timed out; the second question shows 4 dropped; the CSV lists those 4 contacts. |
| US9 Starters | Create a flow from "Lead capture", edit its texts and publish. | A full draft opens with our texts; missing attributes are offered for creation. |

## 4. Automated checks

```powershell
npm run lint
npm run typecheck
npm test                    # unit: graph schema and validator, trigger matching, answers, conditions, engine, SSRF guard
npm run test:integration    # flows-build-publish, flows-questions, flows-live-chat, flows-logic, flows-api-step, flows-triggers, flows-testing, flows-analytics
npm run test:contract       # flows responses vs contracts/flows-api.openapi.yaml
npm run test:e2e            # Playwright: flows-us1 … flows-us9 with mock-meta
```

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| The keyword starts nothing | Is the flow published and does it serve this number? Is the chat Open (not Waiting for agent or Taken)? Is the contact blocked or opted out? Is the sender a test number of another flow? |
| Buttons arrive as text | The 24-hour window or mock-meta rejected the interactive message; see the failed message in live chat. |
| A tap is ignored | The tap was on an older message (stale), so it was handled as a normal message. |
| API step always fails | Use **Test request**: the error tells whether the address is blocked, not HTTPS, too slow, too large or not JSON. |
