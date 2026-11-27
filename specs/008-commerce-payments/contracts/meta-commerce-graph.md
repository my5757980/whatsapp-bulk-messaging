# Contract: Meta catalog, product and flow messages, the Flows API, and mock-meta

**Feature**: `008-commerce-payments` | research R8–R12 | Graph version `META_GRAPH_API_VERSION`
(v27.0)

- **Where calls go:**
  - Messages go through the 001 `MetaGraphClient` send path.
  - Catalog, commerce settings and Flows calls go through the new thin `MetaCommerceClient`, with the
    same timeout, error parsing (`MetaApiError`) and token as 001. The system user token also needs
    `catalog_management` (release checklist).
- **Unverified fields:** names marked *(verify)* are checked against the live reference when each
  method is written.

## Catalog

| Call | Use |
|---|---|
| `GET /{WABA_ID}/product_catalogs?fields=id,name` *(verify fields)* | The catalog connected to each WhatsApp account (one per WABA). An empty list gives the fix "connect a catalog in WhatsApp Manager". |
| `GET /{CATALOG_ID}?fields=id,name` | Confirm access when connecting |
| `GET /{CATALOG_ID}/products?fields=id,retailer_id,name,description,price,sale_price,currency,image_url,url,availability,visibility,review_status&limit=100` *(verify fields)* | The hourly copy, paged with `paging.cursors.after` |
| `GET /{PHONE_NUMBER_ID}/whatsapp_commerce_settings` | `data[0].is_cart_enabled`, `is_catalog_visible`, `id` |
| `POST /{PHONE_NUMBER_ID}/whatsapp_commerce_settings?is_cart_enabled=true&is_catalog_visible=false` | Change them; answer `{success: true}` |
| `POST /{CATALOG_ID}/items_batch` | Store fill (R9). Body: `item_type=PRODUCT_ITEM` and `requests=[{"method":"CREATE"\|"UPDATE"\|"DELETE","data":{"id":"shp-123","title":"…","description":"…","availability":"in stock","condition":"new","price":"150.00 AED","link":"…","image_link":"…","brand":"…"}}]`, chunks of 500 *(verify the maximum and the price format)*. Answer: `{handles: ["…"]}`. |
| `GET /{CATALOG_ID}/check_batch_request_status?handle=…&load_ids_of_invalid_requests=true` | `data[0].status` (`dispatched`, `started`, `finished`, `canceled`, `error`), `errors[]` and `ids_of_invalid_requests` |

**Errors:**
- Code 80009 (too many catalog calls) → back off 60 s, then retry.
- 190, or a missing permission → `CATALOG_SYNC_FAILED` to admins, naming `catalog_management`.

**Price text:** read by `parseCatalogPrice`. Unit tests cover: "AED 150.00", "AED1,234.50",
"1,234.50 AED", "150 AED", "د.إ.‏ 150.00" and "$10.00" with currency `usd`. Anything else gives
`priceMinor = null`.

## Messages sent in the 24-hour window

All of them post to `POST /{PHONE_NUMBER_ID}/messages` with `messaging_product: "whatsapp"`,
`recipient_type: "individual"`, `to`, `type: "interactive"` and the `interactive` object below.

**Pay now (R5), chat content type `PAYMENT_REQUEST`:**

```json
{ "type": "cta_url",
  "body": { "text": "Order 1042\nAmount: AED 150.00\nPlease pay by 26 Nov, 18:00" },
  "action": { "name": "cta_url", "parameters": { "display_text": "Pay now", "url": "https://<PUBLIC_LINK_BASE_URL>/p/Ab12Cd34" } } }
```

`display_text` is at most 20 characters *(verify)*.

**Single product, `PRODUCT`:**

```json
{ "type": "product", "body": { "text": "…" }, "footer": { "text": "…" },
  "action": { "catalog_id": "<CATALOG_ID>", "product_retailer_id": "shp-123" } }
```

The body and footer are optional.

**Product list, `PRODUCT_LIST`:**

```json
{ "type": "product_list", "header": { "type": "text", "text": "Our best sellers" }, "body": { "text": "…" },
  "action": { "catalog_id": "<CATALOG_ID>",
              "sections": [ { "title": "Shirts", "product_items": [ { "product_retailer_id": "shp-123" } ] } ] } }
```

The header and body are required. There are 1–10 sections and at most 30 items in total. Titles are
required when there is more than one section.

**Catalog, `CATALOG`:**

```json
{ "type": "catalog_message", "body": { "text": "Browse our catalog" },
  "action": { "name": "catalog_message", "parameters": { "thumbnail_product_retailer_id": "shp-123" } } }
```

**Form, `FORM` (R12):**

```json
{ "type": "flow", "header": { "type": "text", "text": "Book a visit" }, "body": { "text": "Tap below to book." },
  "action": { "name": "flow", "parameters": {
    "flow_message_version": "3", "flow_id": "<META_FLOW_ID>", "flow_cta": "Book now",
    "flow_token": "wf1.<payload>.<mac>", "flow_action": "navigate",
    "flow_action_payload": { "screen": "S1" } } } }
```

`flow_cta` is at most 30 characters, with no emoji.

## Template buttons (001 builder and sync, R10 and R12)

| Button | Create (component) | Send (component) |
|---|---|---|
| Pay link URL | `{type: "URL", text: "Pay now", url: "https://<PUBLIC_LINK_BASE_URL>/p/{{1}}", example: ["https://<PUBLIC_LINK_BASE_URL>/p/Ab12Cd34"]}` | `{type: "button", sub_type: "url", index: "0", parameters: [{type: "text", text: "<code>"}]}` (001 builder; the `payment` source fills `BUTTON.0.p1` with the code) |
| CATALOG | `{type: "CATALOG", text: "View catalog"}` | `{type: "button", sub_type: "CATALOG", index: 0, parameters: [{type: "action", action: {thumbnail_product_retailer_id: "shp-123"}}]}` |
| MPM *(verify)* | `{type: "MPM", text: "View items"}` | `{type: "button", sub_type: "mpm", index: 0, parameters: [{type: "action", action: {thumbnail_product_retailer_id: "shp-123", sections: [{title: "Shirts", product_items: [{product_retailer_id: "shp-123"}]}]}}]}` |
| FLOW | `{type: "FLOW", text: "Book now", flow_id: "<META_FLOW_ID>", navigate_screen: "S1", flow_action: "navigate"}` | `{type: "button", sub_type: "flow", index: "0", parameters: [{type: "action", action: {flow_token: "wf1.…"}}]}` |

**Template rules (shared `template-rules.ts`):**
- CATALOG and MPM templates are MARKETING and have exactly one button.
- A FLOW button is at most 25 characters, and its `flow_id` must be a published form version that
  belongs to the template's WhatsApp account.
- A pay link template's URL button base must equal `${PUBLIC_LINK_BASE_URL}/p/`.

## Inbound

**Cart** (`messages[].type = "order"`), chat content type `ORDER`:

```json
{ "type": "order", "order": { "catalog_id": "<CATALOG_ID>", "text": "Please deliver today",
  "product_items": [ { "product_retailer_id": "shp-123", "quantity": 2, "item_price": 75, "currency": "AED" } ] } }
```

- `item_price` is a decimal in major units *(verify)*. It is converted with the currency exponent,
  and the currency is lower-cased.

**Form answer** (`messages[].type = "interactive"`, `interactive.type = "nfm_reply"`), stored as
`FORM_REPLY`:

```json
{ "type": "interactive", "interactive": { "type": "nfm_reply", "nfm_reply": {
  "name": "flow", "body": "Sent",
  "response_json": "{\"flow_token\":\"wf1.<payload>.<mac>\",\"name\":\"Sara\",\"email\":\"sara@example.com\",\"visit_date\":\"2026-12-01\"}" } } }
```

## Flows API (forms, R12)

| Call | Use |
|---|---|
| `POST /{WABA_ID}/flows` with `name`, `categories` (JSON array), `flow_json` (string) and `publish=true` | Publish one form version in one call. Answer: `{id, success, validation_errors?: [{error, error_type, message, line_start, line_end, column_start, column_end, pointers?}]}` *(verify the error fields)*. |
| `GET /{FLOW_ID}?fields=id,name,status,validation_errors,json_version` | Confirm `status = PUBLISHED` |
| `POST /{FLOW_ID}/deprecate` | Archiving a form |
| `DELETE /{FLOW_ID}` | Remove a flow whose publish failed (still a DRAFT) |

**Flow JSON produced by `compileFlowJson`** (version 7.3), for a two-screen example:

```json
{ "version": "7.3",
  "screens": [
    { "id": "S1", "title": "Your details", "layout": { "type": "SingleColumnLayout", "children": [
      { "type": "TextInput", "name": "name", "label": "Name", "input-type": "text", "required": true },
      { "type": "TextInput", "name": "email", "label": "Email", "input-type": "email", "required": true },
      { "type": "Footer", "label": "Continue", "on-click-action": { "name": "navigate", "next": { "type": "screen", "name": "S2" }, "payload": {} } } ] } },
    { "id": "S2", "title": "Your visit", "terminal": true, "layout": { "type": "SingleColumnLayout", "children": [
      { "type": "DatePicker", "name": "visit_date", "label": "Date", "required": true },
      { "type": "RadioButtonsGroup", "name": "branch", "label": "Branch", "required": true,
        "data-source": [ { "id": "dxb", "title": "Dubai" }, { "id": "shj", "title": "Sharjah" } ] },
      { "type": "Footer", "label": "Submit", "on-click-action": { "name": "complete", "payload": {
        "name": "${screen.S1.form.name}", "email": "${screen.S1.form.email}",
        "visit_date": "${form.visit_date}", "branch": "${form.branch}" } } } ] } } ] }
```

- **Global references:** `${screen.<id>.form.<field>}` is used for earlier screens *(verify; the
  fallback is to carry values through navigate `payload` and screen `data`)*.
- **Component map:**

  | Field type | Component |
  |---|---|
  | shortText, email, phone, number | `TextInput` with `input-type` text, email, phone, number |
  | longText | `TextArea` |
  | singleChoice | `RadioButtonsGroup` |
  | multipleChoice | `CheckboxGroup` |
  | dropdown | `Dropdown` |
  | date | `DatePicker` |
  | optIn | `OptIn` |
  | screen heading and text | `TextHeading` and `TextBody` |

## mock-meta: `tools/mock-meta/src/commerce.ts` and the inbound CLI

- **Catalog:**
  - `GET /{waba}/product_catalogs` returns the seeded catalog `900000000000001` for every mock WABA.
  - `GET /{catalog}/products` pages 40 seeded products. Three are out of stock and one is
    `review_status: rejected`, and the prices use mixed text formats.
- **Commerce settings and fill:**
  - Commerce settings are stored per number.
  - `items_batch` applies items to the seeded catalog and returns a handle. The status is `finished`
    on the second check, and any item without `price` is listed as invalid.
- **Flows:**
  - `POST /{waba}/flows` validates that `version`, `screens` and one terminal screen exist. An
    invalid form returns `validation_errors`; a valid one returns an id with status `PUBLISHED`.
  - Deprecate and delete are recorded.
- **Messages:** interactive `product`, `product_list`, `catalog_message`, `cta_url` and `flow` are
  accepted and given message ids like any other.
- **Inbound CLI (`inbound-cli.ts`):**
  - `--order "shp-123:2,shp-456:1"` sends an `order` message priced from the seeded catalog;
    `--order-price-change` alters one price.
  - `--form-reply <flow_token> --answers '{"name":"Sara"}'` sends an `nfm_reply`.
  - The e2e helpers read the last sent flow token from mock-meta's message log
    (`GET /mock/messages?to=…`).
- **Integration tests:** `apps/api/test/support/fake-commerce-graph.ts` is a stateful nock catch-all
  with the same data, extending the 007 pattern of `FakeAdsGraph`.
