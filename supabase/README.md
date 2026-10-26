# CrewBoard server-side pieces

Nothing in this folder runs from GitHub Pages. It is ignored by the static
site completely — it is here so the schema and the email code live in version
control next to the pages that depend on them, instead of only in the Supabase
dashboard.

## Folders

- `migrations/` — SQL already applied to production, one numbered file each,
  in the order they were run. Never edit a file that has been run against a
  live database; add a new numbered file instead.
- `functions/notify-booking/` — the Edge Function that emails the freelancer
  and the company when a booking request is submitted.

## Deploying the function

Needs the Supabase CLI, logged in and linked to the project:

```bash
supabase link --project-ref apnjwbhwigkvhyiiynaa
supabase functions deploy notify-booking --no-verify-jwt
```

`--no-verify-jwt` is required. A Database Webhook does not send a user JWT, so
with JWT verification on, every invocation is rejected with a 401 before the
function body runs.

## Secrets

Set these once (Supabase -> Edge Functions -> Secrets, or the CLI):

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | your Resend API key, starts with `re_` |
| `BOOKING_FROM` | a verified sender, e.g. `bookings@crewboard.fit` |
| `SITE_URL` | optional; defaults to `https://crewboard.fit` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.
The service role key bypasses row level security — it must never appear in
`config.js`, in a page, or in this repo.

## The Database Webhook

Dashboard -> Database -> Webhooks -> Create a new hook:

- Table: `bookings`
- Events: **Insert** only
- Type: Supabase Edge Function
- Function: `notify-booking`

## Testing before wiring it to the trigger

Deploy first, then invoke it by hand with a real booking id from the table so
the webhook is not yet in the loop:

```bash
supabase functions invoke notify-booking --no-verify-jwt \
  --body '{"record": {"id": 1, "freelancer_id": "...", "company_id": "...", "event_name": "Test", "event_date": "2026-01-01", "location": "Test venue"}}'
```

Read the response. It reports each recipient separately:

```json
{"booking": 1, "results": {"freelancer": "accepted for ... (id ...)", "company": "accepted for ... (id ...)"}, "anyFailed": false}
```

"accepted" means Resend took the message, not that it landed. Check the Resend
dashboard for delivery, and the recipient's inbox. If a send says
`Resend 403` or similar, read the reason in the message — the usual cause is a
`BOOKING_FROM` address that is not on the verified domain.

Only create the webhook once a manual invoke sends both emails cleanly.
