// Pagos de Pasaporte English con Mercado Pago.
//   /api/pago        → la app pide precios, estado del plan, crear un pago, verificarlo o cancelar.
//   /api/mp-webhook  → Mercado Pago avisa de pagos y suscripciones.
// Nunca se confía en lo que llega en el aviso: siempre se consulta el estado real a Mercado Pago.
//
// Variables de entorno en Netlify:
//   MP_ACCESS_TOKEN   (obligatoria) Access Token de tu aplicación de Mercado Pago.
//   PRECIO_MENSUAL    (opcional, por defecto 29)   PRECIO_SEMESTRAL (opcional, por defecto 129)   MONEDA (opcional, PEN)
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";

export const config = { path: ["/api/pago", "/api/mp-webhook"] };

const MP = "https://api.mercadopago.com";
const DAY = 864e5;
const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const store = () => getStore({ name: "pasaporte-cuentas", consistency: "strong" });
const prices = () => ({
  mensual: Number(process.env.PRECIO_MENSUAL || 29),
  semestral: Number(process.env.PRECIO_SEMESTRAL || 129),
  moneda: process.env.MONEDA || "PEN"
});

async function mp(path, opts = {}) {
  const res = await fetch(MP + path, {
    ...opts,
    headers: { Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Mercado Pago ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
    const err = new Error("mercadopago " + res.status); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

async function userFromToken(s, token) {
  if (!/^[0-9a-f]{48}$/.test(String(token || ""))) return null;
  const sess = await s.get("s/" + token, { type: "json" });
  if (!sess || sess.exp < Date.now()) return null;
  const user = await s.get(sess.key, { type: "json" });
  return user ? { key: sess.key, user } : null;
}

function planInfo(user) {
  const p = user.plan || {};
  const premium = !!p.hasta && p.hasta > Date.now();
  return { premium, tipo: p.tipo || null, hasta: p.hasta || 0, estado: p.estado || (premium ? "activo" : "gratis") };
}

async function updatePlan(s, key, fn) {
  const user = await s.get(key, { type: "json" });
  if (!user) return null;
  user.plan = user.plan || {};
  user.plan.pagos = user.plan.pagos || [];
  user.plan.historial = user.plan.historial || [];
  fn(user.plan);
  user.plan.pagos = user.plan.pagos.slice(-60);
  user.plan.historial = user.plan.historial.slice(-60);
  await s.setJSON(key, user);
  return user;
}
const keyOf = ref => { const k = String(ref || "").split("|")[0]; return k.startsWith("u/") ? k : null; };

// Pago único de 6 meses (Checkout Pro)
async function applyPayment(s, payment) {
  const key = keyOf(payment.external_reference);
  if (!key || payment.status !== "approved") return null;
  return updatePlan(s, key, plan => {
    const mark = "p" + payment.id;
    if (plan.pagos.includes(mark)) return;
    plan.pagos.push(mark);
    plan.historial.push({ fecha: Date.now(), tipo: "semestral", monto: Number(payment.transaction_amount) || 0, moneda: payment.currency_id || "PEN", mpId: String(payment.id) });
    plan.hasta = Math.max(plan.hasta || 0, Date.now()) + 183 * DAY;
    if (plan.estado !== "activa") { plan.tipo = "semestral"; plan.estado = "activo"; }
  });
}
// Suscripción mensual (estado del enlace de suscripción)
async function applyPreapproval(s, pre) {
  const key = keyOf(pre.external_reference);
  if (!key) return null;
  return updatePlan(s, key, plan => {
    plan.mpPreapproval = pre.id;
    if (pre.status === "authorized") {
      plan.tipo = "mensual"; plan.estado = "activa";
      // Unos días de acceso mientras llega la confirmación del primer cobro.
      plan.hasta = Math.max(plan.hasta || 0, Date.now() + 3 * DAY);
    } else if (pre.status === "cancelled") {
      if (plan.tipo === "mensual") plan.estado = "cancelada";
    } else if (pre.status === "paused") {
      if (plan.tipo === "mensual") plan.estado = "pausada";
    } else if (!plan.estado || plan.estado === "gratis") {
      plan.estado = "pendiente";
    }
  });
}
// Cobro mensual de la suscripción
async function applyAuthorizedPayment(s, ap) {
  if (!ap.payment || ap.payment.status !== "approved" || !ap.preapproval_id) return null;
  const pre = await mp("/preapproval/" + encodeURIComponent(ap.preapproval_id));
  const key = keyOf(pre.external_reference);
  if (!key) return null;
  return updatePlan(s, key, plan => {
    const mark = "a" + ap.id;
    if (plan.pagos.includes(mark)) return;
    plan.pagos.push(mark);
    plan.historial.push({ fecha: Date.now(), tipo: "mensual", monto: Number(ap.transaction_amount) || 0, moneda: ap.currency_id || "PEN", mpId: String((ap.payment && ap.payment.id) || ap.id) });
    plan.tipo = "mensual"; plan.estado = "activa"; plan.mpPreapproval = pre.id;
    plan.hasta = Math.max(plan.hasta || 0, Date.now()) + 32 * DAY;
  });
}

async function webhook(req, url, s) {
  let body = {};
  try { body = await req.json(); } catch {}
  const type = body.type || body.topic || url.searchParams.get("type") || url.searchParams.get("topic") || "";
  const id = String((body.data && body.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
  if (!id || !/^[\w-]+$/.test(id) || !process.env.MP_ACCESS_TOKEN) return json(200, { ok: true });
  try {
    if (type === "payment") await applyPayment(s, await mp("/v1/payments/" + id));
    else if (type === "subscription_preapproval" || type === "preapproval") await applyPreapproval(s, await mp("/preapproval/" + id));
    else if (type === "subscription_authorized_payment" || type === "authorized_payment") await applyAuthorizedPayment(s, await mp("/authorized_payments/" + id));
  } catch (err) {
    console.error("Webhook de Mercado Pago:", err.message);
  }
  return json(200, { ok: true });   // Mercado Pago espera 200 rápido; si no, reintenta.
}

export default async function handler(req) {
  const url = new URL(req.url);
  const s = store();
  if (url.pathname.endsWith("/mp-webhook")) return webhook(req, url, s);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  let b;
  try { b = await req.json(); } catch { return json(400, { error: "invalid_json" }); }

  if (b.action === "precios") return json(200, prices());

  const who = await userFromToken(s, b.token);
  if (!who) return json(401, { error: "session" });

  if (b.action === "estado") return json(200, { ...planInfo(who.user), precios: prices() });

  if (!process.env.MP_ACCESS_TOKEN) return json(503, { error: "pagos_no_configurados" });

  try {
    if (b.action === "crear") {
      const P = prices();
      const back = url.origin + "/?pago=volver#premium";
      if (b.plan === "mensual") {
        const email = String(b.mpEmail || who.user.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(400, { error: "email" });
        const pre = await mp("/preapproval", {
          method: "POST",
          body: JSON.stringify({
            reason: "Pasaporte English Premium mensual",
            external_reference: who.key + "|mensual",
            payer_email: email,
            auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: P.mensual, currency_id: P.moneda },
            back_url: back,
            status: "pending"
          })
        });
        await updatePlan(s, who.key, plan => { plan.mpPreapproval = pre.id; if (!plan.estado || plan.estado === "gratis") plan.estado = "pendiente"; });
        return json(200, { url: pre.init_point });
      }
      if (b.plan === "semestral") {
        const pref = await mp("/checkout/preferences", {
          method: "POST",
          body: JSON.stringify({
            items: [{ id: "premium-6-meses", title: "Pasaporte English Premium · 6 meses", quantity: 1, unit_price: P.semestral, currency_id: P.moneda }],
            payer: { email: who.user.email },
            external_reference: who.key + "|semestral|" + randomBytes(6).toString("hex"),
            back_urls: { success: back, pending: back, failure: back },
            auto_return: "approved",
            notification_url: url.origin + "/api/mp-webhook"
          })
        });
        return json(200, { url: pref.init_point });
      }
      return json(400, { error: "plan" });
    }

    if (b.action === "verificar") {
      if (b.payment_id && /^\d+$/.test(String(b.payment_id))) {
        const pay = await mp("/v1/payments/" + b.payment_id);
        if (keyOf(pay.external_reference) === who.key) await applyPayment(s, pay);
      }
      const preId = b.preapproval_id || (who.user.plan && who.user.plan.mpPreapproval);
      if (preId && /^[\w-]+$/.test(String(preId))) {
        const pre = await mp("/preapproval/" + preId);
        if (keyOf(pre.external_reference) === who.key) await applyPreapproval(s, pre);
      }
      const fresh = await s.get(who.key, { type: "json" });
      return json(200, { ...planInfo(fresh), precios: prices() });
    }

    if (b.action === "cancelar") {
      const preId = who.user.plan && who.user.plan.mpPreapproval;
      if (!preId) return json(400, { error: "sin_suscripcion" });
      const pre = await mp("/preapproval/" + preId, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
      await applyPreapproval(s, pre.status ? pre : { ...pre, id: preId, status: "cancelled", external_reference: who.key + "|mensual" });
      const fresh = await s.get(who.key, { type: "json" });
      return json(200, { ...planInfo(fresh), precios: prices() });
    }
  } catch (err) {
    return json(502, { error: "mercadopago", status: err.status || 0 });
  }
  return json(400, { error: "action" });
}
