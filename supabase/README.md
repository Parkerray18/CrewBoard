# CrewBoard server-side pieces

Nothing in this folder runs from GitHub Pages. It is ignored by the static
site completely — it is here so the schema and the server-side code live in
version control next to the pages that depend on them, instead of only in the
Supabase dashboard.

## Folders

- `migrations/` — SQL already applied to production, one numbered file each,
  in the order they were run. Never edit a file that has been run against a
  live database; add a new numbered file instead.
- `functions/send-booking-email/` — emails both sides of a booking request.
  On INSERT: the freelancer and the company. On UPDATE: the company, when a
  freelancer accepts or declines.
- `functions/stripe-webhook/` — activates a company account when a
  subscription starts, and deactivates it when one stops.

## send-booking-email

Triggered by a Supabase Database Webhook on `bookings`.

Integrations -> Webhooks -> create a webhook:

- Table: `bookings`
- Events: **Insert AND Update**. Insert only means the accept/decline emails
  never fire.
- Type: **Supabase Edge Function**
- Function: `send-booking-email`

With Update ticked, every change to a booking row fires the function. The
status guard inside handles that — it returns early unless `status` actually
changed. There is a deliberate test for it: update a row's status to the value
it already holds and confirm the logs say `update with no status change`,
with no email sent.

### The old pg_net trigger

`trg_notify_freelancer_of_booking` calls `notify_freelancer_of_booking()`,
which uses `pg_net` to POST to the same function. **That path does not work**:
previous rows in `net._http_response` have a NULL status code, meaning the
requests were queued and never executed. In fact it never deleted — this is
how it runs. So the only live path is the webhook; drop the trigger once you
have confirmed the webhook is delivering.

## stripe-webhook

Called by Stripe directly. Not by a Supabase webhook, not by a browser.

### Why it exists

`company-signup.html` inserts `paid: false`. Nothing else ever changed it, so
no company could send booking requests. This function is what flips it.

### How a payment is matched to a company

The Payment Links were built by hand in the Stripe dashboard, so they carry no
`client_reference_id`. There is nothing else tying a payment to a `companies`
row, so the match is by **email**, against `companies.email` (added in
migration 001, backfilled in 002).

**The failure mode to watch:** if a company pays with a different address than
they signed up with, nothing matches, the payment succeeds, and `paid` stays
false. The function logs `NO COMPANY MATCHES` with the address it tried. Check
the function logs after any real payment, at least until there is a more
robust join.

### Events handled

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | `paid = true` |
| `customer.subscription.deleted` | `paid = false` |
| `invoice.payment_failed` | `paid = false` |

The off-switches matter more than the on-switch. Without them a company pays
once and stays active forever.

**Known limitation:** `paid` is one true/false flag while there are two
products (monthly, yearly). A company holding two subscriptions and cancelling
one would go inactive while still paying for the other. Fix by storing a
`stripe_subscription_id` on `companies` and deciding from what remains — not
needed while every customer has exactly one subscription.

### Secrecy and deploy order

Stripe gives a signing secret per endpoint, so the endpoint has to exist
before you can set it.

1. Deploy this function first, so its URL exists
2. Create the endpoint in Stripe (**Developers -> Webhooks -> Add endpoint**),
   pointing at `https://apnjwbhwigkvhyiiynaa.supabase.co/functions/v1/stripe-webhook`
3. Subscribe it to the three events above
4. Copy the endpoint's **signing secret** (`whsec_...`)
5. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as function secrets
6. Redeploy so the function picks up the secrets
7. Use Stripe's **Send test event** button — no real payment needed

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
```

### Testing without a real payment

Stripe's **Send test event** in the endpoint page fires a synthetic event at
the function. Watch the function logs for:

- `has stripe key: true   has webhook secret: true`
- `event: checkout.session.completed`
- `set paid = true for [...]` — or `NO COMPANY MATCHES`

A synthetic event carries no real email, so `NO COMPANY MATCHES` is the
expected outcome there. What it proves is that the signature verified and the
handler ran. To test the real path, use Stripe test mode and a test Payment
Link with an address that matches a `companies` row.

## Deploying either function

If you deploy from the CLI, `--no-verify-jwt` matters for both. If you edit
in the dashboard instead, set **Verify JWT** to **off** on the function page.
Neither function is called by a browser, so no user JWT is ever present and
verification would reject every call before the body runs.

## Secrets

| Function | Name | Value |
| --- | --- | --- |
| send-booking-email | `RESEND_API_KEY` | Resend key, `re_...` |
| stripe-webhook | `STRIPE_SECRET_KEY` | Stripe key, `sk_...` |
| stripe-webhook | `STRIPE_WEBHOOK_SECRET` | endpoint signing secret, `whsec_...` |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. The
service role key bypasses row level security — it must never appear in
`config.js`, in a page, or in this repo.

## The from-address

`send-booking-email` sends from `CrewBoard <notifications@crewboard.fit>`. It
must be on a domain verified in Resend. If it is not, Resend still accepts
the call and the mail is silently dropped — check the Resend dashboard, not
just the function response.

## URL strings and the paste trap

Every URL in these functions is assembled from separate string pieces, e.g.

```js
const RESEND_URL = "https:/" + "/api.resend.com" + "/emails";
```

That is deliberate. Pasting a complete URL into an editor or a chat window can
turn it into a Markdown link — `[domain](https://...)` — which `fetch` cannot
parse and which surfaces as an unhelpful runtime error. One of these cost most
of a day. Do not tidy them into a single string.
