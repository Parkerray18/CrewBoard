// send-booking-email
// -----------------------------------------------------------------
// Emails both sides of a booking request.
//
//   bookings INSERT  -> email the freelancer (new request)
//                    -> email the company    (request sent)
//   bookings UPDATE  -> email the company    (accepted or declined)
//
// This is the working function. The INSERT path is live and delivering;
// the company confirmation and the UPDATE path were added on top of it.
//
// Triggered by a Supabase Database Webhook on bookings
// (Integrations -> Webhooks). The webhook must have BOTH events ticked:
// Insert and Update. With Insert only, the accept/decline emails never fire.
//
// IMPORTANT: with Update enabled, every change to a booking row fires this
// function. The status guard below is what stops an unrelated edit, or a
// freelancer changing their answer, from sending a second email. Do not
// remove it.
//
// NOTE: the older pg_net trigger trg_notify_freelancer_of_booking fires on
// the same INSERT but never delivers — every row in net._http_response has a
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
    console.log("event type:", payload.type, "id:", booking?.id);
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

    // --- what kind of change is this? ------------------------------------
    // INSERT = a company just sent a request.
    // UPDATE = a freelancer accepted or declined.
    const eventType = String(payload.type ?? "INSERT").toUpperCase();
    const oldStatus = payload.old_record?.status ?? null;
    const newStatus = booking?.status ?? null;

    // The guard. With Update ticked on the webhook, ANY change to a booking
    // row fires this function. Only a real status change should send mail.
    if (eventType === "UPDATE" && oldStatus === newStatus) {
      console.log("update with no status change - nothing to send");
      return Response.json({ skipped: "status unchanged" });
    }

    // --- split URL pieces (see header note - do not tidy) -----------------
    const RESEND_URL = "https:/" + "/api.resend.com" + "/emails";
    const SITE = "https://crewboard.fit";

    // --- shared: send one message ----------------------------------------
    async function sendOne(to, subject, bodyLines) {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + RESEND_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "CrewBoard <notifications@crewboard.fit>",
          to: [to],
          subject,
          text: bodyLines.join("\n"),
        }),
      });

      const raw = await res.text();
      if (!res.ok) {
        console.error("Resend rejected for", to, res.status, raw);
      } else {
        console.log("Resend accepted for", to, raw);
      }
      return { ok: res.ok, status: res.status, raw };
    }

    // --- lookups shared by both paths ------------------------------------
    let firstName = "there";
    let freelancerFullName = "";
    try {
      const pRes = await fetch(
        SUPABASE_URL + "/rest/v1/profiles?id=eq." + booking.freelancer_id + "&select=name",
        { headers: authHeaders },
      );
      const pJson = await pRes.json();
      const nm = pJson?.[0]?.name;
      if (nm) {
        freelancerFullName = String(nm);
        firstName = freelancerFullName.split(" ")[0];
      }
    } catch (e) {
      console.error("profiles lookup threw:", String(e));
    }

    // name AND email in one call - the email is what the company sends go to.
    let companyName = "A company";
    let companyEmail = "";
    if (booking.company_id) {
      try {
        const cRes = await fetch(
          SUPABASE_URL + "/rest/v1/companies?id=eq." + booking.company_id + "&select=name,email",
          { headers: authHeaders },
        );
        const cJson = await cRes.json();
        if (cJson?.[0]?.name) companyName = cJson[0].name;
        companyEmail = cJson?.[0]?.email ?? "";
      } catch (e) {
        console.error("companies lookup threw:", String(e));
      }
    }

    // --- dates ------------------------------------------------------------
    let dates = booking.event_date || "not specified";
    if (booking.end_date && booking.end_date !== booking.event_date) {
      dates = booking.event_date + " to " + booking.end_date;
    }

    // A short summary both emails can reuse.
    const summary = [
      "Event: " + (booking.event_name || "not specified"),
      "Date: " + dates,
      "Location: " + (booking.location || "not specified"),
    ];

    // =====================================================================
    // PATH A - a company sent a new request (INSERT)
    // =====================================================================
    if (eventType === "INSERT") {
      // --- to the freelancer --------------------------------------------
      let freelancerResult: any = { skipped: "not attempted" };
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
        freelancerResult = { skipped: "no email for freelancer" };
      } else {
        const body = [
          "Hi " + firstName + ",",
          "",
          companyName + " has sent you a booking request through CrewBoard.",
          "",
          ...summary,
        ];
        if (booking.message && booking.message.trim().length > 0) {
          body.push("", booking.message.trim());
        }
        body.push(
          "",
          "Please respond as soon as you can - booking requests are",
          "time-sensitive and often need an answer quickly.",
          "",
          "View the request and respond:",
          SITE + "/requests.html",
          "",
          "If you have not already, you will need to sign in to CrewBoard",
          "to accept or decline.",
          "",
          "This message came from CrewBoard. If you were not expecting it,",
          "you can ignore it.",
        );
        freelancerResult = await sendOne(
          toEmail,
          "New booking request: " + (booking.event_name || "a job"),
          body,
        );
      }

      // --- to the company (confirmation) --------------------------------
      let companyResult: any = { skipped: "not attempted" };
      if (!companyEmail) {
        console.error("no email on companies row", booking.company_id);
        companyResult = { skipped: "no email on companies row" };
      } else {
        const who = freelancerFullName || "the freelancer";
        const body = [
          "Hi " + companyName + ",",
          "",
          "Your booking request went to " + who + " through CrewBoard.",
          "They will see it in their inbox and reply to you there.",
          "",
          ...summary,
          "",
          "If you do not hear back, you can browse the directory for",
          "someone else on the same dates:",
          SITE + "/directory.html",
          "",
          "This message came from CrewBoard. If you were not expecting it,",
          "you can ignore it.",
        ];
        companyResult = await sendOne(
          companyEmail,
          "Your request was sent: " + (booking.event_name || "a job"),
          body,
        );
      }

      return Response.json({ path: "insert", freelancer: freelancerResult, company: companyResult });
    }

    // =====================================================================
    // PATH B - a freelancer accepted or declined (UPDATE)
    // =====================================================================
    if (!companyEmail) {
      console.error("no email on companies row", booking.company_id);
      return Response.json({ skipped: "no email on companies row" });
    }

    const who = freelancerFullName || "The freelancer";
    let subject: string;
    let body: string[];

    if (newStatus === "accepted") {
      subject = who + " accepted your booking request";
      body = [
        "Hi " + companyName + ",",
        "",
        who + " has accepted your booking request through CrewBoard.",
        "",
        ...summary,
        "",
        "You can see their profile and details here:",
        SITE + "/directory.html",
        "",
        "CrewBoard does not handle contracts, pay or scheduling. Confirm",
        "the details with them directly.",
      ];
    } else if (newStatus === "declined") {
      subject = who + " declined your booking request";
      body = [
        "Hi " + companyName + ",",
        "",
        who + " is not available for this request.",
        "",
        ...summary,
        "",
        "You can browse the directory for someone else on the same dates:",
        SITE + "/directory.html",
        "",
        "This message came from CrewBoard. If you were not expecting it,",
        "you can ignore it.",
      ];
    } else {
      // Status changed to something unexpected - log it, send nothing.
      console.log("unhandled status change:", oldStatus, "->", newStatus);
      return Response.json({ skipped: "unhandled status", from: oldStatus, to: newStatus });
    }

    const companyResult = await sendOne(companyEmail, subject, body);
    return Response.json({ path: "update", from: oldStatus, to: newStatus, company: companyResult });
  } catch (err) {
    console.error("function threw:", String(err));
    return Response.json({ error: String(err) }, { status: 500 });
  }
});
