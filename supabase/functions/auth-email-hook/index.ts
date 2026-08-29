/**
 * Supabase Auth "Send Email" hook — every signup / verification / recovery
 * email is rendered with the clean Megsy template and delivered over our own
 * SMTP. Enable it in Supabase Dashboard → Authentication → Hooks → Send Email.
 */
import { sendSmtp, smtpConfigured } from "../_shared/smtp.ts";
import { renderCleanEmail, toPlainText, type MailLang } from "../_shared/email-templates/campaign.ts";
import { welcomeEmail } from "../_shared/email-templates/copy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, webhook-id, webhook-timestamp, webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITE = "https://megsyai.com";
const HERO = Deno.env.get("EMAIL_HERO_WELCOME") || Deno.env.get("EMAIL_HERO_CAMPAIGN") || "";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function pickLang(user: Record<string, unknown>): MailLang {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const raw = String(meta.preferred_language || meta.locale || meta.lang || "").toLowerCase();
  return raw.startsWith("ar") ? "ar" : "en";
}

const SUBJECTS: Record<MailLang, Record<string, string>> = {
  en: {
    signup: "Confirm your email — Megsy",
    recovery: "Reset your Megsy password",
    magiclink: "Your Megsy sign-in link",
    invite: "You are invited to Megsy",
    email_change: "Confirm your new email — Megsy",
    default: "Megsy",
  },
  ar: {
    signup: "تأكيد بريدك الإلكتروني — ميغسي",
    recovery: "إعادة تعيين كلمة مرور ميغسي",
    magiclink: "رابط الدخول إلى ميغسي",
    invite: "دعوة للانضمام إلى ميغسي",
    email_change: "تأكيد بريدك الجديد — ميغسي",
    default: "ميغسي",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!smtpConfigured()) return json({ error: "smtp not configured" }, 500);

  let body: Record<string, any> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const user = body.user ?? {};
  const data = body.email_data ?? {};
  const to = String(user.email || "");
  if (!to) return json({ error: "no recipient" }, 400);

  const lang = pickLang(user);
  const action = String(data.email_action_type || "signup");
  const code = data.token ? String(data.token) : null;

  const confirmUrl =
    data.redirect_to && data.token_hash
      ? `${String(data.site_url || SITE)}/auth/v1/verify?token=${data.token_hash}&type=${action}&redirect_to=${data.redirect_to}`
      : `${SITE}/chat`;

  const input = welcomeEmail(lang, HERO, code);
  input.ctaUrl = confirmUrl;
  if (code) {
    input.ctaLabel = lang === "ar" ? "تأكيد البريد" : "Confirm email";
  }

  const subject = SUBJECTS[lang][action] || SUBJECTS[lang].default;

  try {
    await sendSmtp({
      from: Deno.env.get("SMTP_USER")!,
      fromName: "Megsy",
      to,
      subject,
      text: toPlainText(input),
      html: renderCleanEmail(input),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "smtp failed" }, 502);
  }

  return json({});
});
