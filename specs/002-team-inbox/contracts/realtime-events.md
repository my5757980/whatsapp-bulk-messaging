# Contract: Live Chat Realtime Events (Server-Sent Events)

**Endpoint:** `GET /api/inbox/events`, permission `inbox.view`, authenticated by the session cookie.
**Transport:** `text/event-stream` (research R1). Every event is one SSE message:

```
id: 1763546400123-0          ← Redis Stream entry ID (monotonic)
event: message.created
data: {"conversationId":"…","at":"2026-11-19T10:00:00.000Z","data":{…}}

```

## Rules

1. **Filtering:** the server sends a user only the events for chats that user may see: role,
   agent rules, intervened owner, blocked contacts excluded (FR-026–FR-029).
   - When a chat leaves a user's visibility (for example another agent intervenes), that user gets
     a final `conversation.upserted` carrying `"visible": false`, so the UI can drop it.
2. **Masking:** phone numbers are never sent in full to agents. Previews are cut to 120 characters.
3. **Resume:** the browser's `EventSource` resends `Last-Event-ID` on reconnect, and the server
   replays newer entries. If the ID has been trimmed from the stream, the server sends
   `event: resync` and the client refetches its lists and the open chat.
4. **Heartbeat:** a `: ping` comment every 15 s. Each heartbeat also refreshes the user's presence
   key (push suppression, R9).
5. **Ordering:** events are delivered in stream order. Clients ignore an item they already hold
   (same `id`) and apply status changes by precedence (QUEUED < SENDING < SENT < DELIVERED < READ;
   FAILED only below DELIVERED).
6. **Writes stay REST:** the stream is read-only.
7. **Volume (implementation note, T032):** `message.status` is published for live chat replies and
   for templates sent from a chat. Ticks of campaign and API references are not streamed; they show
   when a chat is opened, so a large broadcast does not flood the stream.
8. **No phone numbers in events:** `conversation.upserted` omits `phone` (and the per-user
   `unread`); clients refetch over REST, where masking applies.

## Event types

| `event` | When | `data` |
|---|---|---|
| `conversation.upserted` | New chat; state, owner, number or preview changed; unread hint; visibility change | `ConversationSummary` (inbox-api.openapi.yaml), plus `visible: boolean` |
| `message.created` | Inbound message, outgoing reply queued, campaign/API/template reference added | `{conversationId, item: ChatItem}` |
| `message.status` | A tick changed, or inbound media became ready or failed | `{conversationId, itemId, status?, failureReason?, mediaState?}` |
| `note.created` | Internal note added | `{conversationId, item: ChatItem, mentions: [userId]}` |
| `conversation.window_closed` | 24 h passed since the customer's last message (published within 60 s) | `{conversationId}` |
| `contact.updated` | Tags, attributes, name, first-message tag or blocked status changed | `{contactId, conversationIds: [uuid]}` |
| `resync` | Replay is impossible (ID trimmed) or the server restarted the stream | `{}` |

## Client behaviour (web)

- Open one `EventSource` per tab while signed in, on any dashboard page, so badges and sound
  work everywhere.
- On `message.created` for a visible chat:
  - play the sound if the preference is on and the message is inbound
  - bump unread unless the chat is open and the tab focused
- On `conversation.window_closed`, move the chat from the live tabs to History.
- After a reconnect, `resync` or 5 failed reconnects with backoff, refetch with REST.
