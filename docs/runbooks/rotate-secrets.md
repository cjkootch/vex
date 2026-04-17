# Rotate secrets (without downtime)

Our secret surface: Anthropic, OpenAI, Neon, NextAuth, Resend webhook,
Twilio auth token, S3 credentials. All of them can be rotated with
zero downtime if you issue the new secret first, deploy, then revoke
the old one.

## Decision tree

| Secret | Where used | Rotate procedure |
|--------|------------|------------------|
| `ANTHROPIC_API_KEY` | apps/api, apps/worker | Overlap — deploy new key, then revoke old in Anthropic console |
| `OPENAI_API_KEY` | apps/api, apps/worker | Overlap — both services read at boot only; restart after swap |
| `APPLICATION_DATABASE_URL` | apps/api, apps/worker | Neon rotates password on request; use overlap below |
| `MIGRATION_DATABASE_URL` | CI only | Rotate direct-endpoint password in Neon; update `MIGRATION_DATABASE_URL` GH secret |
| `NEXTAUTH_SECRET` | apps/web, apps/api (decodes JWEs) | See "JWT rotation" below |
| `RESEND_WEBHOOK_SECRET` | apps/api | See "Webhook signing secrets" |
| `TWILIO_AUTH_TOKEN` | apps/api | See "Webhook signing secrets" |
| `S3_ACCESS_KEY_ID` / `SECRET` | apps/api, apps/worker | Issue new IAM key → deploy → delete old |

## General overlap pattern

1. Issue a new secret in the provider console.
2. Update the secret in Vercel (`apps/web`) and Fly (`apps/api`,
   `apps/worker`) under the existing env-var name.
3. `fly deploy` / Vercel redeploy — the new instance reads the new
   secret at boot.
4. Wait for traffic to settle on the new instances (Fly: `fly status`;
   Vercel: rollout complete).
5. Revoke the old secret in the provider console.

Total downtime: 0. Window of dual-validity: usually 5–10 minutes.

## JWT rotation (`NEXTAUTH_SECRET`)

The JWE encrypts session cookies. Rotating it invalidates every signed
session — every user has to re-login.

1. Generate: `openssl rand -base64 32`
2. Deploy to **apps/api only** first (it decodes with both old + new
   salts via the `DecodeChain` in `apps/api/src/auth/jwt-auth.guard.ts`).
3. Deploy to apps/web with the new secret. New sessions are signed
   with the new secret; existing sessions keep working until they
   expire.
4. After 24h, remove the old secret from apps/api's decode chain.

## Webhook signing secrets

Resend and Twilio both support multiple active secrets in the provider
console.

1. Add a new signing secret in the provider UI — both secrets are now
   valid.
2. Update the env var in Fly, redeploy.
3. Remove the old secret in the provider UI.

If you skip step 1 you'll drop signed webhooks for the window between
the provider rotation and the Fly redeploy.

## Verifying

```bash
# Anthropic
curl -sf -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  https://api.anthropic.com/v1/models | jq '.data[0].id'

# Neon
psql "$APPLICATION_DATABASE_URL" -c "SELECT current_user;"

# NextAuth
curl -s "https://app.vex.local/api/auth/session" -H "Cookie: $SESSION_COOKIE" | jq
```

## Next steps to prevent recurrence

Add the new expiration date to `docs/runbooks/rotate-secrets.md`
("next rotation due: YYYY-MM-DD"). Optionally, wire a calendar reminder
from the incident commander's ops calendar.
