// send-booking-email
// -----------------------------------------------------------------
// Emails the freelancer when a company submits a booking request.
//
// This is the function deployed in the Supabase dashboard, committed here so
// the working version is not lost if the dashboard copy is ever removed.
//
// Triggered by a Supabase Database Webhook on bookings INSERT
// (Integrations -> Webhooks).
//
// NOTE: the older pg_net trigger trg_notify_freelancer_of_booking fires on
// the same event but never delivers — every row in net._http_response has a
// NULL status code, meaning the queued requests were never executed. Drop it
// once the webhook is proven, so only one path runs.
//
// Secrets required:
//   RESEND_API_KEY  - the Resend API key (re_...)
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase
//
// IMPORTANT: the from-address below must be on a domain verified in Resend.
// If it is not, Resend accepts the call and the mail is silently dropped.
//
// IMPORTANT: RESEND_URL is deliberately assembled from separate string
// pieces. Pasting a complete URL into an editor or a chat window can turn it
// into a Markdown link — [domain](https://...) — which fetch cannot parse and
// which surfaces as an unhelpful runtime error. Do not "tidy" this line.

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const booking = payload.record ?? payload.booking ?? payload;

    console.log("payload keys:", Object.keys(payload));
    console.log("freelancer_id:", booking?.freelancer_id, "company_id:", booking?.company_id);
    console.log("has resend key:", !!Deno.env.get("RESEND_API_KEY"));
    console.log("has service key:", !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!booking?.freelancer_id) {
      console.error("no freelancer_id in payload");
      return Response.json({ skipped: "no freelancer_id" });
    }
    if (!RESEND_KEY) {
      console.error("RESEND_API_KEY is not set");
      return Response.json({ error: "missing RESEND_API_KEY" }, { status: 500 });
    }

    const authHeaders = {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
    };

    // --- freelancer email address ---------------------------------------
    let toEmail = "";
    try {
      const userRes = await fetch(
        SUPABASE_URL + "/auth/v1/admin/users/" + booking.freelancer_id,
        { headers: authHeaders },
      );
      const userJson = await userRes.json();
      toEmail = userJson?.email ?? "";
      console.log("freelancer lookup status:", userRes.status, "found email:", !!toEmail);
    } catch (e) {
      console.error("freelancer lookup threw:", String(e));
    }

    if (!toEmail) {
      console.error("no email for freelancer", booking.freelancer_id);
      return Response.json({ skipped: "no email for freelancer" });
    }

    // --- names (cosmetic; failure here must not block the send) ----------
    let firstName = "there";
    try {
      const pRes = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + booking.freelancer_id + "&select=name",
        { headers: authHeaders },
      );
      const pJson = await pRes.json();
      const nm = pJson?.[0]?.name;
      if (nm) firstName = String(nm).split(" ")[0];
    } catch (e) {
      console.error("profiles lookup threw:", String(e));
    }

    let companyName = "A company";
    try {
      const cRes = await fetch(
        SUPABASE_URL + "/rest/v1/companies?id=eq." + booking.company_id + "&select=name",
        { headers: authHeaders },
      );
      const cJson = await cRes.json();
      if (cJson?.[0]?.name) companyName = cJson[0].name;
    } catch (e) {
      console.error("companies lookup threw:", String(e));
    }

    // --- dates ------------------------------------------------------------
    let dates = booking.event_date || "not specified";
    if (booking.end_date && booking.end_date !== booking.event_date) {
      dates = booking.event_date + " to " + booking.end_date;
    }

    const lines = [
      "Hi " + firstName + ",",
      "",
      companyName + " has sent you a booking request through CrewBoard.",
      "",
      "Event: " + (booking.event_name || "not specified"),
      "Date: " + dates,
      "Location: " + (booking.location || "not specified"),
    ];

    if (booking.message && booking.message.trim().length > 0) {
      lines.push("", booking.message.trim());
    }

    lines.push(
      "",
      "Please respond as soon as you can - booking requests are",
      "time-sensitive and often need an answer quickly.",
      "",
      "View the request and respond:",
      // Split so no tool turns it into a Markdown link (see header note).
      "https://crewboard.fit" + "/requests.html",
      "",
      "If you have not already, you will need to sign in to CrewBoard",
      "to accept or decline.",
      "",
      "This message came from CrewBoard. If you were not expecting it,",
      "you can ignore it.",
    );

    // --- send ------------------------------------------------------------
    // Split into pieces so no tool can turn it into a Markdown link.
    const RESEND_URL = "https:/" + "/api.resend.com" + "/emails";

    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "CrewBoard <notifications@crewboard.fit>",
        to: [toEmail],
        subject: "New booking request: " + (booking.event_name || "a job"),
        text: lines.join("\n"),
      }),
    });

    const raw = await res.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      result = { raw };
    }

    if (!res.ok) {
      console.error("Resend rejected:", res.status, raw);
    } else {
      console.log("Resend accepted:", raw);
    }

    return Response.json({ sent: res.ok, status: res.status, resend: result });
  } catch (err) {
    console.error("function threw:", String(err));
    return Response.json({ error: String(err) }, { status: 500 });
  }
});
