// stripe-webhook
// -----------------------------------------------------------------
// Flips companies.paid when a subscription starts or stops. This is what
// activates a company account: company-signup.html inserts paid: false and
// nothing else ever changes it.
//
// Handled events:
//   checkout.session.completed     -> paid = true
//   customer.subscription.deleted  -> paid = false
//   invoice.payment_failed         -> paid = false
//
// Paired with whatever "send test event" events are already arriving -
// see the note at the bottom about STRIPE_WEBHOOK_SECRET and rotation.
//
// Secrets required:
//   STRIPE_SECRET_KEY      - sk_... (or rk_... restricted key)
//   STRIPE_WEBHOOK_SECRET  - whsec_... from the endpoint you create in Stripe
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase
//
// IMPORTANT: signature verification needs the RAW request body. Reading it
// with req.json() first and then trying to verify will fail every delivery
// with a 400, which is the classic way this looks "deployed but broken".
// The body is read as text once, verified, and only then parsed.
//
// IMPORTANT: the company is matched by EMAIL. The Payment Links were built
// by hand in the Stripe dashboard, so they carry no client_reference_id and
// there is nothing else tying a payment to a companies row. This is why the
// email column exists. If a company pays with a different address than they
// signed up with, nothing matches - that case logs loudly and must be
// checked by hand.
//
// KNOWN LIMITATION: paid is a single true/false flag while there are two
// products (monthly $74.99, yearly $720). If one company ever holds two
// subscriptions and cancels one, this sets paid = false while they are still
// paying for the other. Fix that by storing a stripe_subscription_id on
// companies and deciding from the remaining subscriptions - not needed
// while every customer has exactly one.

import Stripe from "https://esm.sh/stripe@17.5.0?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("POST only", { status: 405 });
  }

  const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  console.log("has stripe key:", !!STRIPE_KEY, "has webhook secret:", !!WEBHOOK_SECRET);

  if (!STRIPE_KEY || !WEBHOOK_SECRET) {
    console.error("missing secrets: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return new Response("missing secrets", { status: 500 });
  }

  const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2024-12-18.acacia" });
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("no stripe-signature header");
    return new Response("no signature", { status: 400 });
  }

  // Read the body ONCE, as text, before parsing. Verification needs the
  // exact bytes Stripe signed - see the header note.
  const rawBody = await req.text();

  let event: any;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("signature verification failed:", String(err));
    return new Response("invalid signature", { status: 400 });
  }

  console.log("event:", event.type, "id:", event.id);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- find the company an event belongs to -----------------------------
  // checkout.session.completed carries the customer's email on the session.
  // The subscription events do not, so the customer id is resolved to an
  // email first through Stripe.
  async function emailForSession(session: any): Promise<string> {
    return String(session?.customer_details?.email ?? session?.customer_email ?? "").toLowerCase();
  }

  async function emailForCustomer(customerId: string): Promise<string> {
    if (!customerId) return "";
    try {
      const cust: any = await stripe.customers.retrieve(customerId);
      return String(cust?.email ?? "").toLowerCase();
    } catch (e) {
      console.error("customers.retrieve failed for", customerId, String(e));
      return "";
    }
  }

  async function setPaid(email: string, paid: boolean, why: string) {
    if (!email) {
      console.error(why, "- no email to match on");
      return { matched: false, reason: "no email" };
    }

    const { data, error } = await admin
      .from("companies")
      .update({ paid })
      .ilike("email", email)
      .select("id, name, email");

    if (error) {
      console.error(why, "- companies update failed:", error.message);
      return { matched: false, reason: error.message };
    }

    if (!data || data.length === 0) {
      // The case that matters: someone paid and nothing was activated.
      console.error(
        why,
        "- NO COMPANY MATCHES",
        email,
        "- they may have paid with a different address than they signed up with",
      );
      return { matched: false, reason: "no company with that email", email };
    }

    console.log(why, "- set paid =", paid, "for", JSON.stringify(data));
    return { matched: true, paid, companies: data };
  }

  let result: any = { skipped: "unhandled event" };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const email = await emailForSession(session);
        console.log("checkout completed for:", email, "mode:", session.mode);
        result = await setPaid(email, true, "checkout.session.completed");
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const email = await emailForCustomer(String(sub.customer ?? ""));
        console.log("subscription deleted for:", email);
        result = await setPaid(email, false, "customer.subscription.deleted");
        break;
      }

      case "invoice.payment_failed": {
        const inv = event.data.object;
        const email = await emailForCustomer(String(inv.customer ?? ""));
        console.log("payment failed for:", email);
        result = await setPaid(email, false, "invoice.payment_failed");
        break;
      }

      default:
        console.log("ignoring event type:", event.type);
    }
  } catch (err) {
    console.error("handler threw:", String(err));
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }

  // Always 200 once the signature verified and the handler ran, so Stripe
  // does not retry an event that would just run again.
  return new Response(JSON.stringify({ received: true, type: event.type, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
