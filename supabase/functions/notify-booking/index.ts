// notify-booking
// -----------------------------------------------------------------
// Sends two emails when a company submits a booking request:
//   1. the freelancer, telling them a request arrived and to check
//      their CrewBoard inbox
//   2. the company, confirming the request was sent
//
// Triggered by a Supabase Database Webhook on bookings INSERT.
// Wired up in the dashboard, not in this file.
//
// Secrets required (Supabase -> Edge Functions -> Secrets):
//   RESEND_API_KEY    the Resend API key (re_...)
//   BOOKING_FROM      verified sender, e.g. bookings@crewboard.fit
//   SITE_URL          optional, defaults to https://crewboard.fit
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase
// automatically. The service role key is what lets us read auth.users
// for the freelancer's address; it must never reach the browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

const SITE_URL = env("SITE_URL", "https://crewboard.fit");

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string
  );
}

function fmtDate(d: string | null): string {
  if (!d) return "not set";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
    });
  } catch {
    return d;
  }
}

function fmtRange(start: string | null, end: string | null): string {
  if (!start && !end) return "not set";
  if (!end || start === end) return fmtDate(start);
  return fmtDate(start) + " to " + fmtDate(end);
}

function firstName(full: string | null | undefined): string {
  const n = String(full ?? "").trim();
  return n ? n.split(" ")[0] : "there";
}

// Sends one message and reports exactly what happened. A 200 from Resend means
// ACCEPTED, not delivered, so we log the message id on success and the full
// error body on failure — the address and the reason, not a bare "failed".
async function send(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });

    const bodyText = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        detail: `Resend ${res.status} to ${to}: ${bodyText}`,
      };
    }

    let id = "";
    try {
      id = JSON.parse(bodyText)?.id ?? "";
    } catch { /* body was not JSON; the send still succeeded */ }

    return { ok: true, detail: `accepted for ${to}${id ? ` (id ${id})` : ""}` };
  } catch (e) {
    return { ok: false, detail: `network error to ${to}: ${String(e)}` };
  }
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f6fb">
<div style="max-width:560px;margin:0 auto;padding:28px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a1a2f">
  <p style="font-size:1.15rem;font-weight:800;margin:0 0 18px;letter-spacing:-.01em">
    <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:7px;background:#ff6b2c;color:#fff;font-weight:800;margin-right:8px">C</span>CrewBoard
  </p>
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:26px">
    <h1 style="font-size:1.3rem;margin:0 0 14px;letter-spacing:-.015em">${title}</h1>
    ${body}
  </div>
  <p style="color:#64748b;font-size:.8rem;line-height:1.5;margin:18px 0 0">
    CrewBoard is a directory, not an employer. We do not employ freelancers, handle pay,
    or manage contracts. Always confirm credentials, insurance and union status directly.
  </p>
  <p style="color:#94a3b8;font-size:.8rem;margin:10px 0 0">&copy; 2026 CrewBoard &middot; crewboard.fit</p>
</div>
</body></html>`;
}

function detailRows(b: Record<string, unknown>): string {
  const rows: Array<[string, string]> = [
    ["Event", esc(b.event_name) || "Booking request"],
    ["Dates", esc(fmtRange(b.event_date as string, b.end_date as string))],
  ];
  if (b.location) rows.push(["Venue / city", esc(b.location)]);
  if (b.offered_rate) rows.push(["Offered day rate", "$" + esc(b.offered_rate) + " / day"]);

  return rows.map(([label, value]) =>
    `<tr>
       <td style="padding:6px 14px 6px 0;color:#64748b;font-weight:600;vertical-align:top;white-space:nowrap">${label}</td>
       <td style="padding:6px 0;vertical-align:top">${value}</td>
     </tr>`
  ).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  const apiKey = env("RESEND_API_KEY");
  const from = env("BOOKING_FROM");

  if (!apiKey || !from) {
    const missing = [
      !apiKey ? "RESEND_API_KEY" : null,
      !from ? "BOOKING_FROM" : null,
    ].filter(Boolean).join(", ");
    console.error(`notify-booking: missing secret(s): ${missing}`);
    return new Response(JSON.stringify({ error: `missing secrets: ${missing}` }), { status: 500 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "body was not JSON" }), { status: 400 });
  }

  // A Database Webhook sends { type, table, record, old_record, schema }.
  // The record for an INSERT is the new booking row.
  const booking = payload?.record ?? payload?.booking ?? null;
  if (!booking || !booking.id) {
    console.error("notify-booking: no record in payload", JSON.stringify(payload).slice(0, 500));
    return new Response(JSON.stringify({ error: "no booking record in payload" }), { status: 400 });
  }

  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Freelancer address: auth.users, via the booking's freelancer_id.
  // Companies address: companies.email (see migrations 001 and 002).
  // profiles is read for the display name only, and profiles_public is
  // deliberately avoided — its column list is fixed and can lag behind.
  const freelancerId = booking.freelancer_id as string | undefined;
  const companyId = booking.company_id as string | undefined;

  if (!freelancerId) {
    console.error(`notify-booking: booking ${booking.id} has no freelancer_id`);
    return new Response(JSON.stringify({ error: "booking has no freelancer_id" }), { status: 400 });
  }

  let freelancerEmail = "";
  let freelancerName = "";
  try {
    const { data: u, error } = await admin.auth.admin.getUserById(freelancerId);
    if (error) console.error(`notify-booking: getUserById(${freelancerId}) failed:`, error.message);
    freelancerEmail = u?.user?.email ?? "";
  } catch (e) {
    console.error(`notify-booking: getUserById(${freelancerId}) threw:`, String(e));
  }

  try {
    const { data: p } = await admin
      .from("profiles")
      .select("name")
      .eq("id", freelancerId)
      .maybeSingle();
    freelancerName = p?.name ?? "";
  } catch { /* the name is cosmetic; the send does not depend on it */ }

  let companyEmail = "";
  let companyName = "";
  if (companyId) {
    try {
      const { data: c, error } = await admin
        .from("companies")
        .select("name, email")
        .eq("id", companyId)
        .maybeSingle();
      if (error) console.error(`notify-booking: companies lookup failed:`, error.message);
      companyEmail = c?.email ?? "";
      companyName = c?.name ?? "";
    } catch (e) {
      console.error(`notify-booking: companies lookup threw:`, String(e));
    }
  }

  const results: Record<string, string> = {};

  // --- to the freelancer -------------------------------------------------
  if (!freelancerEmail) {
    results.freelancer = `no email on auth.users for ${freelancerId}`;
    console.error("notify-booking: " + results.freelancer);
  } else {
    const fn = firstName(freelancerName);
    const who = esc(companyName) || "A company";
    const html = shell(
      `New booking request`,
      `<p style="margin:0 0 16px;color:#334155">Hi ${esc(fn)}, <strong>${who}</strong> sent you a booking request through CrewBoard.</p>
       <table style="width:100%;border-collapse:collapse;font-size:.94rem">${detailRows(booking)}</table>
       ${booking.message ? `<p style="margin:16px 0 0;padding:14px;background:#f3f6fb;border-radius:9px;color:#334155;font-size:.94rem"><strong>Message:</strong> ${esc(booking.message)}</p>` : ""}
       <p style="margin:18px 0 0">
         <a href="${SITE_URL}/requests.html" style="display:inline-block;background:#ff6b2c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:700">Accept or decline</a>
       </p>
       <p style="color:#64748b;font-size:.86rem;margin:14px 0 0">Rates and availability are supplied by freelancers themselves.</p>`
    );
    const r = await send(apiKey, from, freelancerEmail, `Booking request from ${companyName || "a company"}`, html);
    results.freelancer = r.detail;
    if (!r.ok) console.error("notify-booking: freelancer send failed -> " + r.detail);
  }

  // --- to the company ----------------------------------------------------
  if (!companyEmail) {
    results.company = companyId
      ? `no email on companies row ${companyId} (was it created before migration 001?)`
      : "booking has no company_id";
    console.error("notify-booking: " + results.company);
  } else {
    const who = firstName(freelancerName) || "The freelancer";
    const html = shell(
      `Your request was sent`,
      `<p style="margin:0 0 16px;color:#334155">Your booking request went to <strong>${esc(who)}</strong>. They will see it in their CrewBoard inbox and reply to you there.</p>
       <table style="width:100%;border-collapse:collapse;font-size:.94rem">${detailRows(booking)}</table>
       <p style="margin:18px 0 0">
         <a href="${SITE_URL}/directory.html" style="display:inline-block;background:#ff6b2c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:700">Back to the directory</a>
       </p>
       <p style="color:#64748b;font-size:.86rem;margin:14px 0 0">If you do not hear back, browse the directory for someone else on the same dates.</p>`
    );
    const r = await send(apiKey, from, companyEmail, `Your CrewBoard request was sent`, html);
    results.company = r.detail;
    if (!r.ok) console.error("notify-booking: company send failed -> " + r.detail);
  }

  const anyFailed = Object.values(results).some((v) =>
    v.startsWith("network error") || v.startsWith("Resend ")
  );

  console.log(`notify-booking: booking ${booking.id} ->`, JSON.stringify(results));

  // Always 200 unless something genuinely broke, so Supabase does not retry a
  // send that already partially succeeded and duplicate the mail. The details
  // live in the response body and in the function logs.
  return new Response(
    JSON.stringify({ booking: booking.id, results, anyFailed }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
