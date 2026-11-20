# Contract: Calls to the Claude Messages API

**Feature**: `004-ai-agent` | SDK: `@anthropic-ai/sdk` 1.6.0 | Model: `AI_MODEL` (default
`claude-opus-5-5`) | Research: R1–R8, R12, R16

This is the only outbound AI contract. Everything is sent from the worker (`apps/api`, worker mode)
through one `ClaudeClient` wrapper, so tests can replace the transport with nock or mock-meta.

## 1. Client

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,   // secret, from .env; never logged
  timeout: 25_000,                 // milliseconds per HTTP call (TypeScript SDK unit)
  maxRetries: 1,                   // 429, 5xx and connection errors; the 30 s turn deadline still applies
});
// ANTHROPIC_BASE_URL, when set, points the SDK at mock-meta (tests, local runs without a key).
```

Environment (added to `.env.example`, validated at start-up): `ANTHROPIC_API_KEY` (required when any
agent is published or the assistant is used; the app starts without it and agents fail closed to
the fallback message), `ANTHROPIC_BASE_URL` (optional), `AI_MODEL` (default `claude-opus-5-5`).

## 2. A customer turn

Sent with the tool runner on the beta namespace (needed for the server-side fallback):

```ts
const final = await client.beta.messages.toolRunner({
  model: env.AI_MODEL,
  max_tokens: 8000,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  output_config: {
    effort: 'low',
    format: { type: 'json_schema', schema: AGENT_REPLY_JSON_SCHEMA },
  },
  system: [
    { type: 'text', text: PLATFORM_RULES_V1 },                                        // fixed, in code
    { type: 'text', text: renderInstructions(version), cache_control: { type: 'ephemeral' } },
  ],
  tools: [searchKnowledgeTool, ...apiSkillTools(version)],                             // sorted by name, strict
  messages: [
    { role: 'user', content: [{ type: 'text', text: renderKnowledge(agent), cache_control: { type: 'ephemeral' } }] },
    ...history,                                     // ≤ 20 earlier messages of the AI conversation
    { role: 'user', content: maskedCustomerText },  // the unanswered customer messages, joined
    { role: 'system', content: renderTurnContext(turn) },
  ],
  max_iterations: 4,
}, { signal: turnDeadline.signal });
```

- `history`: customer messages as `user`, earlier AI replies as `assistant` (message text only).
  Consecutive `user` entries are merged by the API.
- `renderTurnContext`: contact name, allowed attributes and tags, local date and time, working-hours
  state and next opening, `firstReply`, `pendingConfirmation`, and in search mode the pre-retrieved
  chunks in `<retrieved>` tags. Never the phone number.
- Masking (R12) runs on `maskedCustomerText` and on history before sending.
- No `temperature`, `top_p`, `top_k` or `thinking` fields (not accepted on this model and API
  version; thinking runs adaptive).

## 3. Tools

All tools use `strict: true` and `additionalProperties: false`; `tool_choice` stays `auto`.

| Tool | Input | Runs | Result to the model |
|---|---|---|---|
| `search_knowledge` | `{ query: string }` | always (read only); at most 3 calls per turn | up to 6 chunks: `[{id, kind, title, heading, text}]` in a `<results>` block |
| `skill_<id>` (one per API skill) | `{ <input key>: string, … }` from the skill's inputs | read-only skills at once; skills with `changesData` only on a confirmed second call (R12); simulated in preview | `{ ok: true, fields: { <to>: value } }` with the mapped fields only, or `{ ok: false, reason: "timeout" | "error_status" | "blocked" | "confirmation_needed" }` |

## 4. The reply JSON (`AgentReplySchema`, packages/shared/src/ai/reply.ts)

Every field is present; unused ones are `null` (strict schemas need every property listed).

```jsonc
{
  "message": "Yes, we deliver to Sharjah. Delivery is AED 50, free over AED 1,000.",
  "language": "en",                 // the language of `message`; picks the introduction text
  "buttons": null,                  // or ["Dubai", "Sharjah"]  (≤ 3, each ≤ 20 characters)
  "list": null,                     // or { "button": "Branches", "rows": [{ "title": "Al Ain", "description": null }] } (≤ 10 rows)
  "mediaId": null,                  // or one of the version's shared media ids
  "usedSources": ["src:0190…", "chunk:0190…"],  // knowledge ids the answer relied on (FR-020)
  "unanswered": null,               // or "Price of the XL corner sofa"  (generic, no personal details)
  "handOver": null,                 // or { "reason": "customer_asked" | "topic" | "unsure" | "repeat" | "other", "summary": "…" }
  "remember": null,                 // or [{ "key": "city", "value": "Al Ain" }]
  "startFlow": null,                // or a flow id from the version's flow skills
  "optOut": null                    // or "clear" (record it, send nothing) | "ask" (the message asks)
}
```

Checks in code after parsing (anything invalid is dropped and logged with its reason, never sent):
- `message` at most `maxReplyChars` (1,024 when `mediaId` is set); empty only when `optOut` is
  `"clear"` or `startFlow` is set.
- `buttons` and `list` only when the version allows them; never both; WhatsApp limits as above.
- `mediaId`, `startFlow` and `remember[].key` must come from the version's skills; values must fit
  the attribute's type and must not look like card, bank or ID numbers.
- `usedSources` ids must belong to the agent's knowledge; unknown ids are removed.

## 5. Outcomes and errors

| Situation | Handling |
|---|---|
| `stop_reason: "end_turn"` with valid JSON | apply the reply (research R5) |
| `stop_reason: "refusal"` after the fallback, `"max_tokens"`, or JSON that fails `AgentReplySchema` | failure: fallback message, hand-over "AI agent unavailable", not counted |
| `Anthropic.RateLimitError`, `Anthropic.InternalServerError`, `Anthropic.APIConnectionError` | the SDK retries once; then the job retries with back-off while the 30 s deadline allows; then failure |
| `Anthropic.AuthenticationError`, `Anthropic.PermissionDeniedError`, `Anthropic.BadRequestError` | failure at once (logged with the request id, never the prompt) and an `AI_FAILING` check |
| deadline reached | the call is aborted; failure |

Usage: `response.usage` of every call in the loop (`input_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, `output_tokens`) is summed into the AI reply record (R8, R10).

## 6. The team assistant

Same client; `client.beta.messages.toolRunner` with `stream: true` and `.finalMessage()`, effort
`medium`, the same fallback, `max_tokens: 32000`, `max_iterations: 8`, and the tools of research
R14. Each tool's input schema is strict; `draft_flow` takes the 003 flow graph JSON and is checked
with `FlowGraphSchema` and the 003 publish rules before the draft is created. The final answer is
plain text for the member (no structured output), with the drafts and pending actions returned
from the tools.

## 7. Mock for tests (tools/mock-meta)

`ANTHROPIC_BASE_URL=http://localhost:4010/anthropic` makes the SDK call mock-meta:

- `POST /anthropic/v1/messages` returns a Messages API response (`id`, `type: "message"`, `role`,
  `model`, `content`, `stop_reason`, `usage`) chosen by rules:
  - rules set with `POST /mock/ai/rules` (`[{ "when": { "lastUserContains": "person" }, "reply": { …AgentReply… } }]`),
    or `{ "toolCall": { "name": "skill_order_status", "input": { … } } }` to return a `tool_use` block first;
  - otherwise a default answer: the knowledge chunk in the request with the most words in common
    with the customer's text becomes `message`, with its id in `usedSources`; no overlap gives an
    `unanswered` reply.
- `GET /mock/ai/requests` lists the requests received (to assert prompt order, cache breakpoints and
  that no phone number was sent); `DELETE /mock/ai/requests` clears them and the rules.
- Integration tests use nock on `https://api.anthropic.com` with the same response shapes.
