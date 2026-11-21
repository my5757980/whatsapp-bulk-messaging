# Contract: Agent Configuration Document

**Feature**: `004-ai-agent` | Used by: `ai_agents.draft`, `ai_agent_versions.config`, the editor and
the API (`PUT /ai-agents/{id}/draft`, `GET /ai-agents/{id}`).

One zod schema, `AgentConfigSchema` in `packages/shared/src/ai/config.ts`, is the single source of
truth: the editor uses it for instant checks and the API for saving and publishing. Knowledge is
**not** part of this document; it lives in `ai_knowledge_sources` and is shared by the draft and the
published versions (spec Assumptions).

## Shape (version 1)

```jsonc
{
  "version": 1,
  "displayName": "Sara",                      // 1–40; the name customers see in the introduction
  "businessDetails": "We sell sofas and beds…", // 0–4,000; what the company does, branches, hours, delivery
  "goal": "Answer questions about our furniture and delivery, and help customers choose.", // 1–1,000, required
  "tone": { "preset": "friendly", "notes": "Short sentences." }, // preset: friendly | professional | warm | concise | formal; notes 0–300
  "guardrails": ["Never offer discounts that are not in the knowledge."], // 0–20 items, each 1–200
  "replyLanguages": ["en", "ar"],            // 1–10 language codes (BCP 47 primary tags), first = fallback
  "intro": {                                  // first reply of each AI conversation (FR-010); one per reply language
    "en": "Hi, I'm Sara, the virtual assistant of Example Furniture.",
    "ar": "مرحباً، أنا سارة، المساعدة الافتراضية لشركة Example Furniture."
  },
  "maxReplyChars": 1000,                      // 100–1,000 (FR-009)
  "whenUnsure": "say_so",                     // say_so (default) | hand_over (FR-023)
  "handOverTopics": ["refunds", "complaints"], // 0–20 items, each 1–100
  "replyCap": 20,                             // 5–100 AI replies per AI conversation (FR-023)
  "fallbackMessage": "Thanks for your message. Our team will reply shortly.", // 1–500, fixed text (FR-022)
  "skills": {
    "buttons": true,                          // reply buttons (up to 3)
    "lists": true,                            // lists (up to 10 rows)
    "media": [                                // 0–20 shared media library files (FR-028)
      { "mediaId": "0190…", "description": "Our 2026 price list. Send it when asked for prices or the catalogue." }
    ],
    "memory": [                               // 0–20 attributes the agent may fill (FR-029)
      { "key": "city", "description": "The emirate or city the customer lives in." }
    ],
    "api": [                                  // 0–10 API skills (FR-030)
      {
        "id": "order_status",                 // ^[a-z][a-z0-9_]{1,39}$, unique in the agent; the tool is named skill_<id>
        "name": "Order status",               // 1–60
        "whenToUse": "Use when a customer asks where their order is.", // 1–500, required
        "inputs": [                           // 0–5 values the agent must collect first
          { "key": "order_number", "description": "The order number, like A-1234.", "required": true }
        ],
        "changesData": false,                 // true → the customer must confirm before the call (FR-031)
        "request": {                          // the 003 API request shape (contracts/flow-graph.md of 003)
          "method": "GET",
          "url": "https://shop.example.com/api/orders/{input:order_number}",
          "headers": [{ "name": "Authorization", "value": "Bearer {secret:0190…}" }],
          "query": [],
          "body": null,
          "timeoutSeconds": 5                 // 1–10
        },
        "map": [{ "from": "status", "to": "status" }, { "from": "eta", "to": "eta" }] // 1–20 reply fields the agent may use
      }
    ],
    "flows": [                                // 0–10 Start a flow skills (FR-032)
      { "flowId": "0190…", "whenToUse": "When the customer wants to book a showroom visit." }
    ]
  }
}
```

## Variables in API skill requests

Placeholders are filled by the platform, never by the model, with the place-aware encoding of 003
(URL encoding in the address and query, JSON escaping in the body, CR/LF removed from headers):

| Placeholder | Value |
|---|---|
| `{input:<key>}` | a value the agent collected for this skill (string, at most 200 characters) |
| `{contact:name}`, `{contact:phone}` | the contact's name and phone (the phone never reaches the AI service, FR-048) |
| `{attr:<key>}` | a contact attribute |
| `{secret:<id>}` | a stored secret of this agent (`ai_agent_secrets`, encrypted like 003 flow secrets), headers only |

## Rules checked when saving (schema) and publishing (server)

| Code | When |
|---|---|
| `NO_GOAL` | `goal` is empty |
| `NO_LANGUAGE` | `replyLanguages` is empty |
| `INTRO_MISSING` | a reply language has no `intro` text (defaults are filled in for `en` and `ar`) |
| `SKILL_WITHOUT_DESCRIPTION` | a media, memory, API or flow skill has no description / `whenToUse` |
| `NOT_HTTPS`, `UNKNOWN_SECRET`, `SECRET_OUTSIDE_HEADER`, `UNKNOWN_INPUT` | API skill request problems (003 checks plus inputs) |
| `MEDIA_NOT_FOUND` | a shared media file is not in the media library |
| `UNKNOWN_ATTRIBUTE`, `ATTRIBUTE_TYPE` | a memory attribute does not exist (types are only checked when a value is saved) |
| `FLOW_NOT_PUBLISHED` | a flow skill names a flow that is not published |
| `REPLACE_ME_LEFT` | an example answer from a starter is still marked "replace me" (FR-005, US8) |
| `DUPLICATE_SKILL_ID` | two API skills share an `id` |

Problems are returned as the 003 `Problem` shape (`code`, `message`, `field`), with `field` a JSON
path such as `skills.api[0].request.url`.
