// ------------------------------------------------------------------
// The database connection for CrewBoard, plus the shared helpers that
// every page needs. Loaded by all nine pages, right after the
// Supabase library and before each page's own script.
//
// SB_URL is your Supabase project URL. It is public and safe to share.
//
// SB_KEY is the Supabase "Publishable key" (Settings -> API Keys).
// It is meant to be public: it ships inside the web page, so anyone
// can read it in the page source. That is normal, and it is why the
// database rules in Supabase decide what is allowed.
//
// NEVER put the "Secret key" here. That one grants full access to
// your whole database with no restrictions, and must stay private.
// ------------------------------------------------------------------

window.SB_URL = "https://apnjwbhwigkvhyiiynaa.supabase.co";
window.SB_KEY = "sb_publishable_d6P3dt_qVYkw71eebA3dBg_zNTUsJSX";

// ------------------------------------------------------------------
// Shared helpers. These run on every page.
// ------------------------------------------------------------------
(function () {
  var sb = null;
  try {
    if (window.supabase && window.SB_URL && window.SB_KEY) {
      sb = window.supabase.createClient(window.SB_URL, window.SB_KEY);
    }
  } catch (e) { sb = null; }
  window.CB_SB = sb;

  // Give an element a small orange count pill, or clear it.
  function setBadge(el, n) {
    if (!el) return;
    var old = el.querySelector(".cb-badge");
    if (old) old.remove();
    if (!n) { el.style.removeProperty("font-weight"); return; }
    var span = document.createElement("span");
    span.className = "cb-badge";
    span.textContent = n;
    el.appendChild(span);
    el.style.fontWeight = "700";
  }

  // Count this freelancer's pending booking requests and show the number
  // next to "Requests" in the nav. Only visible to a signed-in freelancer,
  // and only while they are on the site (email notification is separate).
  window.cbShowRequestBadge = async function () {
    if (!sb) return;
    var link = null;
    var links = document.querySelectorAll(".nav nav a");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("href") === "requests.html") { link = links[i]; break; }
    }
    if (!link) return;
    try {
      var u = await sb.auth.getUser();
      if (!u || !u.data || !u.data.user) { setBadge(link, 0); return; }
      var r = await sb.from("bookings")
        .select("id")
        .eq("freelancer_id", u.data.user.id)
        .eq("status", "pending");
      setBadge(link, (r && r.data) ? r.data.length : 0);
    } catch (e) { /* stay quiet; the badge is optional */ }
  };

  // Inject the pill styling once, so no page needs its own copy.
  function addBadgeStyle() {
    if (document.getElementById("cb-badge-style")) return;
    var s = document.createElement("style");
    s.id = "cb-badge-style";
    s.textContent =
      ".cb-badge{display:inline-flex;align-items:center;justify-content:center;" +
      "min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:9px;" +
      "background:#ff6b2c;color:#fff;font-size:.72rem;font-weight:800;line-height:1;" +
      "vertical-align:middle}";
    document.head.appendChild(s);
  }

  window.addEventListener("DOMContentLoaded", function () {
    addBadgeStyle();
    window.cbShowRequestBadge();
  });
})();
