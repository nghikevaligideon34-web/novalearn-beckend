// ============================================================
// NovaLearn AI — Backend (Deno Deploy)
// Handles two things, both kept off the browser for security:
//   1. Groq AI proxy          -> POST /chat
//   2. DPO Pay checkout flow  -> POST /create-checkout
//                              -> POST /verify-payment
// ============================================================
// DEPLOY STEPS:
// 1. Go to https://dash.deno.com and create a new Playground/Project.
// 2. Paste this whole file in, Save & Deploy.
// 3. In Settings -> Environment Variables, add:
//      GROQ_API_KEY        = gsk_your_real_groq_key
//      DPO_COMPANY_TOKEN   = your_dpo_company_token
//      DPO_SERVICE_TYPE    = your_dpo_service_type_id   (from your DPO dashboard)
//      DPO_LIVE_MODE       = "true"  (or leave unset/"false" to use DPO's test endpoint)
//      APP_URL             = https://your-site.netlify.app  (used for DPO redirect/back URLs)
// 4. Copy the deployed URL (e.g. https://novalearn-backend.deno.dev)
//    and paste it into CONFIG.BACKEND_BASE_URL in novalearn-ai.html.
//
// IMPORTANT — DPO SPECIFICS YOU MUST CONFIRM WITH DPO YOURSELF:
// - The exact ServiceType ID for your account/package (DPO assigns
//   this when they approve your merchant account).
// - Whether your account uses the live endpoint
//   (https://secure.3gdirectpay.com/API/v6/) or a sandbox/test
//   endpoint DPO gives you during onboarding — set DPO_LIVE_MODE
//   accordingly, and double check the sandbox host DPO gives you
//   matches DPO_TEST_ENDPOINT below (DPO has changed this before).
// - DPO's docs: https://docs.dpopay.com — this file follows their
//   general createToken / verifyToken v6 flow, but confirm field
//   names against your own account's docs before going live.
// ============================================================

// ---- Shared config ----
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

const DPO_LIVE_ENDPOINT = "https://secure.3gdirectpay.com/API/v6/";
const DPO_TEST_ENDPOINT = "https://secure1.sandbox.directpay.online/API/v6/"; // confirm with DPO onboarding docs
const DPO_LIVE_PAY_URL = "https://secure.3gdirectpay.com/payv3.php";
const DPO_TEST_PAY_URL = "https://secure1.sandbox.directpay.online/payv3.php";

// Allow requests from any origin by default. For extra safety once
// you know your final domain (e.g. Netlify), replace "*" below with
// your exact site URL, e.g. "https://novalearn-ai.netlify.app".
const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ---- Tiny XML helpers (DPO's API is XML, not JSON) ----
// Regex-based on purpose: DPO's response is a small, flat, predictable
// structure, so a full XML parser dependency isn't needed here. If you
// later need to handle more complex XML, swap this for a real parser
// (e.g. `npm:fast-xml-parser`).
function xmlTag(name: string, value: string | number) {
  return `<${name}>${String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${name}>`;
}
function extractXmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

// ---- Route: POST /chat (Groq AI proxy) ----
async function handleChat(req: Request): Promise<Response> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) {
    return json({ error: "Server is missing GROQ_API_KEY. Set it in Deno Deploy > Settings > Environment Variables." }, 500);
  }
  try {
    const body = await req.json();
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Request must include a non-empty 'messages' array." }, 400);
    }
    const MAX_MESSAGES = 30;
    const trimmedMessages = messages.slice(-MAX_MESSAGES);

    const groqResponse = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: body.model || DEFAULT_MODEL,
        messages: trimmedMessages,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.6,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 1000,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Groq API error:", groqResponse.status, errText);
      return json({ error: `Groq API returned status ${groqResponse.status}` }, 502);
    }
    const data = await groqResponse.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return json({ text });
  } catch (err) {
    console.error("Chat proxy error:", err);
    return json({ error: "Unexpected server error." }, 500);
  }
}

// ---- Route: POST /create-checkout (DPO createToken) ----
// Starts a DPO payment session for the $5.99/month subscription and
// returns a checkoutUrl the frontend should redirect/open the user to.
//
// NOTE ON RECURRING BILLING: DPO's core API creates one-off payment
// tokens. True recurring subscription billing on DPO typically needs
// either their tokenized/"save card" re-charge flow or a scheduled job
// on your own backend that re-charges a saved token monthly. This
// function only covers the *first* charge — treat monthly re-billing
// as a separate TODO once your DPO account is fully set up, likely
// using Deno KV or Supabase to store the customer's saved payment
// token and a cron trigger to re-charge it.
async function handleCreateCheckout(req: Request): Promise<Response> {
  const companyToken = Deno.env.get("DPO_COMPANY_TOKEN");
  const serviceType = Deno.env.get("DPO_SERVICE_TYPE");
  const appUrl = Deno.env.get("APP_URL") || "https://example.com";
  const liveMode = (Deno.env.get("DPO_LIVE_MODE") || "false").toLowerCase() === "true";

  if (!companyToken || !serviceType) {
    return json({
      error: "Server is missing DPO_COMPANY_TOKEN or DPO_SERVICE_TYPE. Set them in Deno Deploy > Settings > Environment Variables once your DPO merchant account is approved.",
    }, 500);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email : "student@example.com";
    const reference = `novalearn-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10) + " 00:00";

    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  ${xmlTag("CompanyToken", companyToken)}
  ${xmlTag("Request", "createToken")}
  <Transaction>
    ${xmlTag("PaymentAmount", "5.99")}
    ${xmlTag("PaymentCurrency", "USD")}
    ${xmlTag("CompanyRef", reference)}
    ${xmlTag("RedirectURL", `${appUrl}/?payment=success`)}
    ${xmlTag("BackURL", `${appUrl}/?payment=cancelled`)}
    ${xmlTag("CustomerEmail", email)}
    ${xmlTag("PTL", "5")}
  </Transaction>
  <Services>
    <Service>
      ${xmlTag("ServiceType", serviceType)}
      ${xmlTag("ServiceDescription", "NovaLearn AI Premium — monthly subscription")}
      ${xmlTag("ServiceDate", today)}
    </Service>
  </Services>
</API3G>`;

    const dpoEndpoint = liveMode ? DPO_LIVE_ENDPOINT : DPO_TEST_ENDPOINT;
    const dpoResponse = await fetch(dpoEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: requestXml,
    });
    const responseXml = await dpoResponse.text();

    const result = extractXmlValue(responseXml, "Result");
    const transToken = extractXmlValue(responseXml, "TransToken");
    const explanation = extractXmlValue(responseXml, "ResultExplanation");

    if (result !== "000" || !transToken) {
      console.error("DPO createToken failed:", result, explanation, responseXml);
      return json({ error: `DPO could not start checkout: ${explanation || "unknown error"}` }, 502);
    }

    const payBaseUrl = liveMode ? DPO_LIVE_PAY_URL : DPO_TEST_PAY_URL;
    const checkoutUrl = `${payBaseUrl}?ID=${encodeURIComponent(transToken)}`;

    return json({ checkoutUrl, transToken, reference });
  } catch (err) {
    console.error("create-checkout error:", err);
    return json({ error: "Unexpected server error starting checkout." }, 500);
  }
}

// ---- Route: POST /verify-payment (DPO verifyToken) ----
// Call this after the user returns from DPO's checkout (RedirectURL)
// to confirm the payment actually succeeded before unlocking Premium.
// NOTE: this only checks a single transaction's status — it does not
// persist "this user is subscribed" anywhere. For real subscription
// gating across sessions, store the verified result against the
// user's account in a database (Deno KV / Supabase / Firebase) here.
async function handleVerifyPayment(req: Request): Promise<Response> {
  const companyToken = Deno.env.get("DPO_COMPANY_TOKEN");
  const liveMode = (Deno.env.get("DPO_LIVE_MODE") || "false").toLowerCase() === "true";
  if (!companyToken) {
    return json({ error: "Server is missing DPO_COMPANY_TOKEN." }, 500);
  }

  try {
    const body = await req.json();
    const transToken = body.transToken;
    if (!transToken) {
      return json({ error: "Request must include 'transToken'." }, 400);
    }

    const requestXml = `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  ${xmlTag("CompanyToken", companyToken)}
  ${xmlTag("Request", "verifyToken")}
  ${xmlTag("TransactionToken", transToken)}
</API3G>`;

    const dpoEndpoint = liveMode ? DPO_LIVE_ENDPOINT : DPO_TEST_ENDPOINT;
    const dpoResponse = await fetch(dpoEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: requestXml,
    });
    const responseXml = await dpoResponse.text();
    const result = extractXmlValue(responseXml, "Result");

    // DPO result "000" = transaction paid successfully.
    const active = result === "000";
    return json({ active, result });
  } catch (err) {
    console.error("verify-payment error:", err);
    return json({ error: "Unexpected server error verifying payment." }, 500);
  }
}

// ---- Router ----
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json({ error: "Only POST is supported" }, 405);
  }

  const { pathname } = new URL(req.url);
  switch (pathname) {
    case "/chat":
      return handleChat(req);
    case "/create-checkout":
      return handleCreateCheckout(req);
    case "/verify-payment":
      return handleVerifyPayment(req);
    default:
      return json({ error: `Unknown route ${pathname}. Use /chat, /create-checkout, or /verify-payment.` }, 404);
  }
});
