# Website-chat → Vex integration

This spec is the contract the VTC marketing-site chat should implement so
its conversations land in Vex as Leads + Contacts + Organizations +
Deals.

The Vex-side endpoint + normalizer ship in PR [#feat/website-chat-webhook]:

- `POST /webhooks/website-chat` — public webhook, HMAC-SHA256
- `WebsiteChatNormalizer` — resolves org/contact by email domain, creates
  Lead, stores transcript as Document, emits `lead.captured` +
  `lead.transcript_received`

The website repo is responsible for firing two events at the right
moments. Everything below is what the website Claude needs to know.

---

## 1. Endpoint

```
POST https://api.vexhq.ai/webhooks/website-chat
Content-Type: application/json
X-VTC-Timestamp: <unix seconds>
X-VTC-Signature: <hex hmac>
```

- **Method**: `POST`, JSON body.
- **Auth**: HMAC-SHA256 of `${timestamp}.${rawBody}` using the shared
  secret `WEBSITE_CHAT_WEBHOOK_SECRET` (see next section).
- **Response**: `204 No Content` on success, `400` on bad signature /
  malformed body.
- **Idempotency**: the Vex server dedupes on
  `providerEventId = "${conversation_id}:${event}"`. Retry safely.

### The shared secret (`WEBSITE_CHAT_WEBHOOK_SECRET`)

`WEBSITE_CHAT_WEBHOOK_SECRET` is **one random string the operator
generates once and pastes into both deployments**. It's not a token
either side issues — it's a password the website uses to prove it's
the legitimate sender, and Vex uses the identical string to verify.

**One-time setup (operator does this, not the code):**

1. Generate a 32-byte random string:

   ```sh
   openssl rand -hex 32
   # e.g. 7a9d...c4f1b2 (64 hex chars)
   ```

   Node equivalent: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

2. Paste the **same value** into two places:
   - **Vex (Fly)**: `fly secrets set WEBSITE_CHAT_WEBHOOK_SECRET=<value> -a vex-api`
   - **Website (Vercel)**: Project settings → Environment Variables →
     `WEBSITE_CHAT_WEBHOOK_SECRET = <same value>` (scope: Production +
     Preview).

3. Redeploy both services so the new env var is picked up.

**Do not** commit the secret to either repo. **Do not** generate a
separate value per environment — the two sides must match byte-for-
byte or every request 400s with `invalid_signature`.

If the secret is ever leaked, rotate it by generating a new one and
repeating steps 2–3. Vex doesn't cache the secret; the next request
after the redeploy uses the new value.

For local dev, pick any string (`"dev-secret-do-not-use"`) and set it
in `.env` on both repos. The verifier doesn't care what the string is
— only that it's identical on both ends.

### Signing example (Node, Vercel)

```js
import { createHmac } from "node:crypto";

async function sendToVex(event, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", process.env.WEBSITE_CHAT_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const res = await fetch("https://api.vexhq.ai/webhooks/website-chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VTC-Timestamp": timestamp,
      "X-VTC-Signature": signature,
    },
    body,
  });
  if (!res.ok) throw new Error(`Vex webhook ${res.status}`);
}
```

### Retry policy

Vex is idempotent, so retry freely. Recommend:

- 3 attempts with exponential backoff (1s, 2s, 4s).
- Give up after the 3rd failure — the Formspree fallback still fires, so
  no lead is lost.

---

## 2. Two events to emit

### 2a. `conversation.started`

Fires once, right after the gate captures `{name, email}` and *before*
the first message.

```json
{
  "event": "conversation.started",
  "conversation_id": "vtc-1775761482261-k3x9f2m7a",
  "website_version": "abc1234",
  "timestamp": "2026-04-19T22:00:00.000Z",
  "lead": {
    "name": "Jane Doe",
    "email": "jane@acme.example"
  },
  "page": {
    "url": "https://vectortradecapital.com/fuel",
    "referrer": "https://google.com/",
    "utm": { "source": "google", "medium": "cpc", "campaign": "q2-fuel" }
  }
}
```

**Required:** `event`, `conversation_id`, `lead.name`, `lead.email`.
**Optional:** `website_version`, `timestamp`, `page.*`.

### 2b. `conversation.ended`

Fires when the transcript-send timer fires (60s idle) *or* on
`beforeunload`. Carries the full accumulated transcript.

```json
{
  "event": "conversation.ended",
  "conversation_id": "vtc-1775761482261-k3x9f2m7a",
  "website_version": "abc1234",
  "timestamp": "2026-04-19T22:05:12.000Z",
  "lead": {
    "name": "Jane Doe",
    "email": "jane@acme.example"
  },
  "page": {
    "url": "https://vectortradecapital.com/fuel"
  },
  "messages": [
    { "role": "user", "text": "Need 200kMT of rice CIF Kingston", "ts": "2026-04-19T22:01:00Z" },
    { "role": "assistant", "text": "Happy to help. What's your timeline?", "ts": "2026-04-19T22:01:10Z" },
    { "role": "user", "text": "Q3 2026, monthly lifts", "ts": "2026-04-19T22:01:45Z" }
  ]
}
```

**Required:** `event`, `conversation_id`, `lead.name`, `lead.email`,
`messages` (non-empty array).
**Optional:** same as above.

The message `role` must be one of `user`, `assistant`, `system`. `text`
is plain text (no HTML). `ts` is optional ISO-8601.

---

## 3. Where to call from

Recommended: call Vex **server-side from `/api/chat.js`** (Vercel
function), not from the browser. Two reasons:

1. The webhook secret stays server-side.
2. The API already has the `sessionId`, messages, and page URL.

### Wiring plan

1. **`conversation.started`** — fire from the gate submit handler. This
   likely already posts `{name, email}` to `/api/chat.js` before the
   first message. Add the Vex call there. This replaces (or augments)
   the existing Formspree gate notification.

2. **`conversation.ended`** — trigger the existing
   `scheduleTranscriptSend()` (60s idle) + `beforeunload` handlers.
   Right now those post to Formspree; have the `/api/chat.js` route
   additionally call Vex with the full transcript assembled from the
   Neon `chat_messages` table.

---

## 4. Gaps to close on the website side

These items were flagged in the discovery round. None are blockers —
they make the parser smarter but the webhook works without them.

1. **Pass `lead` data (`{name, email}`) from client to `/api/chat.js`**
   on every request so the server-side webhook call has access.
2. **Capture UTM + `document.referrer`** on the client and pass to
   `/api/chat.js`; forward under `page.utm` / `page.referrer`.
3. **`website_version`** — inject a build-time constant (git SHA or
   package.json version). Helpful for debugging schema drift.
4. *Skip `visitor_id`* — the gate's email is stable identity. Not
   needed.

---

## 5. What Vex does with each event

### On `conversation.started`

1. Extract email domain → find-or-create Organization (keyed on
   normalized legal name / domain via the existing dedupe helper).
2. Find-or-create Contact keyed on email, attached to that Org (with a
   primary membership in the m:n table).
3. Create a Lead row with:
   - `status = "new"`
   - `stage = "website_chat_started"`
   - `externalKeys["website_chat.conversation_id"] = conversation_id`
4. Write a `website_chat.gate` touchpoint.
5. Emit `lead.captured` event (verb + metadata with page + UTM).

### On `conversation.ended`

1. Lazy-resolve org + contact same as above (safe if `started` was
   missed).
2. Look up the Lead by `conversation_id`; create one if missing.
3. Render transcript as plain text and store as a `chat_transcript`
   Document against the contact.
4. Write a `website_chat.ended` touchpoint.
5. Emit `lead.transcript_received` event — this is the hook for the
   follow-up parser (separate PR) that extracts `{product, volume,
   destination, timeline, urgency, buying_intent}` via Claude and
   writes `leads.qualification_summary`.

---

## 6. Test locally

Vex ships a test helper in
`apps/api/src/webhooks/website-chat-verifier.ts` —
`signWebsiteChatForTest(secret, body)` returns the two headers for any
body. Use it to drive integration tests on the website side without a
running Vex server.

Once the webhook is wired, smoke-test with curl against a staging Vex:

```sh
BODY='{"event":"conversation.started","conversation_id":"smoke-001",...}'
TS=$(date +%s)
SIG=$(node -e "console.log(require('crypto').createHmac('sha256',process.env.SECRET).update('$TS.'+process.argv[1]).digest('hex'))" "$BODY")

curl -X POST https://api.vexhq.ai/webhooks/website-chat \
  -H "Content-Type: application/json" \
  -H "X-VTC-Timestamp: $TS" \
  -H "X-VTC-Signature: $SIG" \
  -d "$BODY"
```

Expected: `204 No Content`. On success the lead lands at
`/app/signals` (via the `lead.captured` event) and on the contact's
detail page at `/app/contacts/:id`.

---

## 7. Rollout checklist

- [ ] Generate `WEBSITE_CHAT_WEBHOOK_SECRET` once
      (`openssl rand -hex 32`). Set the **same value** on both Vercel
      (website env) and Fly (Vex API env). See "The shared secret"
      section above.
- [ ] Deploy Vex webhook endpoint (PR #feat/website-chat-webhook).
- [ ] Wire `conversation.started` + `conversation.ended` calls in
      `/api/chat.js`.
- [ ] Capture UTM + referrer client-side, pass through API.
- [ ] Pass gate lead data (`{name, email}`) to every `/api/chat.js`
      request.
- [ ] Add `website_version` build constant.
- [ ] Run one real test conversation on staging, verify the lead + org
      + contact + transcript Document appear in Vex.
- [ ] Leave Formspree on for one week as a fallback.
- [ ] Disable Formspree transcript email once Vex is confirmed stable.
