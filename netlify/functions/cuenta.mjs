// Cuentas de Pasaporte English: iniciar sesión y guardar el progreso en la nube (Netlify Blobs).
// Las contraseñas nunca se guardan: solo un hash PBKDF2 con sal aleatoria.
//
// Recuperar contraseña: se envía un código de 6 dígitos por correo. Configura en Netlify UNA de estas opciones:
//   BREVO_API_KEY  + MAIL_FROM (el correo remitente verificado en Brevo, por ejemplo tucorreo@gmail.com)
//   RESEND_API_KEY + MAIL_FROM (un remitente de un dominio verificado en Resend)
// Opcional: SOPORTE_WHATSAPP (por ejemplo 51987654321) para mostrarlo si el correo no está configurado.
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/cuenta" };

const MAX_DATA = 200000;                       // tamaño máximo del progreso guardado (caracteres)
const SESSION_MS = 1000 * 60 * 60 * 24 * 90;   // la sesión dura 90 días
const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const store = () => getStore({ name: "pasaporte-cuentas", consistency: "strong" });
const userKey = email => "u/" + createHash("sha256").update(email).digest("hex");
const hashPw = (pw, salt) => pbkdf2Sync(pw, salt, 120000, 32, "sha256").toString("hex");
const CODE_MS = 15 * 60 * 1000;   // el código de recuperación vale 15 minutos
const resetKey = email => "r/" + createHash("sha256").update("reset|" + email).digest("hex");
const codeHash = (email, code) => createHash("sha256").update(email + "|" + code).digest("hex");
function setPassword(user, pw) {
  user.salt = randomBytes(16).toString("hex");
  user.hash = hashPw(pw, user.salt);
  user.pwChanged = Date.now();   // las sesiones abiertas antes de este momento dejan de valer
}
function mailReady() { return !!(process.env.MAIL_FROM && (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY)); }
async function sendMail(to, subject, text, html) {
  const from = process.env.MAIL_FROM;
  let res;
  if (process.env.BREVO_API_KEY) {
    const m = /^(.*)<([^>]+)>\s*$/.exec(from);
    const sender = m ? { name: m[1].trim() || "Pasaporte English", email: m[2].trim() } : { name: "Pasaporte English", email: from.trim() };
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
  } else {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html })
    });
  }
  if (!res.ok) { console.error("Correo no enviado:", res.status, (await res.text()).slice(0, 300)); return false; }
  return true;
}

function cleanEmail(value) {
  const e = String(value || "").trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}
function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  const f = v => String(v ?? "").trim().slice(0, 100);
  return { names: f(p.names), last: f(p.last), phone: f(p.phone), email: f(p.email) };
}
function cleanData(data) {
  if (data == null) return null;
  const str = JSON.stringify(data);
  return str.length <= MAX_DATA ? JSON.parse(str) : undefined;
}

export default async function handler(req) {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  let b;
  try { b = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  const s = store();
  const action = b && b.action;

  if (action === "registro" || action === "entrar") {
    const email = cleanEmail(b.email);
    const pw = String(b.password || "");
    if (!email) return json(400, { error: "email" });
    if (pw.length < 8 || pw.length > 200) return json(400, { error: "password" });
    const key = userKey(email);
    let user = await s.get(key, { type: "json" });
    if (action === "registro") {
      if (user) return json(409, { error: "exists" });
      const data = cleanData(b.data);
      if (data === undefined) return json(413, { error: "too_large" });
      const salt = randomBytes(16).toString("hex");
      user = { email, salt, hash: hashPw(pw, salt), created: Date.now(), updated: Date.now(), data, perfil: cleanProfile(b.perfil || (data && data.perfil)) };
      await s.setJSON(key, user);
    } else {
      if (!user) return json(401, { error: "credentials" });
      const ok = timingSafeEqual(Buffer.from(hashPw(pw, user.salt), "hex"), Buffer.from(user.hash, "hex"));
      if (!ok) return json(401, { error: "credentials" });
    }
    const token = randomBytes(24).toString("hex");
    await s.setJSON("s/" + token, { key, exp: Date.now() + SESSION_MS, at: Date.now() });
    return json(200, { token, email: user.email, data: user.data || null, updated: user.updated || 0 });
  }

  // Recuperar contraseña, paso 1: enviar un código al correo.
  // La respuesta es la misma exista o no la cuenta, para no revelar qué correos están registrados.
  if (action === "recuperar") {
    const email = cleanEmail(b.email);
    if (!email) return json(400, { error: "email" });
    if (!mailReady()) return json(200, { modo: "manual", soporte: String(process.env.SOPORTE_WHATSAPP || "").replace(/\D/g, "") });
    const user = await s.get(userKey(email), { type: "json" });
    if (user) {
      const rk = resetKey(email);
      const prev = (await s.get(rk, { type: "json" })) || {};
      const sent = (prev.sent || []).filter(t => t > Date.now() - 3600000);
      if (sent.length >= 3) return json(429, { error: "too_many" });
      const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
      await s.setJSON(rk, { h: codeHash(email, code), exp: Date.now() + CODE_MS, tries: 0, sent: [...sent, Date.now()] });
      const ok = await sendMail(email, "Tu código para cambiar la contraseña · Pasaporte English",
        `Tu código es: ${code}\n\nEscríbelo en la app para crear una contraseña nueva. Vence en 15 minutos.\nSi no lo pediste, ignora este correo: tu contraseña no cambia.`,
        `<div style="font-family:Arial,sans-serif;font-size:16px;color:#0F1B33"><p>Hola,</p><p>Tu código para crear una contraseña nueva en <b>Pasaporte English</b> es:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#2F5BEA">${code}</p><p>Vence en 15 minutos.</p><p style="color:#5A6479;font-size:14px">Si no lo pediste, ignora este correo: tu contraseña no cambia.</p></div>`);
      if (!ok) return json(502, { error: "mail" });
    } else {
      await new Promise(r => setTimeout(r, 400));
    }
    return json(200, { modo: "email" });
  }

  // Recuperar contraseña, paso 2: comprobar el código y guardar la contraseña nueva.
  if (action === "restablecer") {
    const email = cleanEmail(b.email);
    const code = String(b.code || "").replace(/\D/g, "");
    const pw = String(b.password || "");
    if (!email) return json(400, { error: "email" });
    if (pw.length < 8 || pw.length > 200) return json(400, { error: "password" });
    const rk = resetKey(email);
    const rec = await s.get(rk, { type: "json" });
    if (!rec || !rec.h || rec.exp < Date.now() || rec.tries >= 5) return json(400, { error: "code_expired" });
    const okCode = code.length === 6 && timingSafeEqual(Buffer.from(codeHash(email, code), "hex"), Buffer.from(rec.h, "hex"));
    if (!okCode) { rec.tries = (rec.tries || 0) + 1; await s.setJSON(rk, rec); return json(400, { error: "code", left: Math.max(0, 5 - rec.tries) }); }
    const key = userKey(email);
    const user = await s.get(key, { type: "json" });
    if (!user) return json(400, { error: "code_expired" });
    setPassword(user, pw);
    await s.setJSON(key, user);
    await s.delete(rk);
    const token = randomBytes(24).toString("hex");
    await s.setJSON("s/" + token, { key, exp: Date.now() + SESSION_MS, at: Date.now() });
    return json(200, { token, email: user.email, data: user.data || null, updated: user.updated || 0 });
  }

  // Panel del administrador: necesita la variable ADMIN_KEY en Netlify.
  if (typeof action === "string" && action.startsWith("admin_")) {
    const adminKey = process.env.ADMIN_KEY || "";
    if (adminKey.length < 12) return json(503, { error: "admin_not_configured" });
    const a = createHash("sha256").update(adminKey).digest();
    const g = createHash("sha256").update(String(b.adminKey || "")).digest();
    if (!timingSafeEqual(a, g)) { await new Promise(r => setTimeout(r, 800)); return json(401, { error: "admin" }); }

    if (action === "admin_lista") {
      const { blobs } = await s.list({ prefix: "u/" });
      const users = [];
      for (let i = 0; i < blobs.length; i += 20) {
        const chunk = await Promise.all(blobs.slice(i, i + 20).map(x => s.get(x.key, { type: "json" })));
        for (const u of chunk) {
          if (!u) continue;
          const d = u.data || {};
          const pf = u.perfil || cleanProfile(d.perfil) || {};
          const plan = u.plan || {};
          const porModulo = [0, 0, 0, 0, 0, 0];
          for (const k of Object.keys(d.p || {})) { const m = Number(k.split(":")[0]); if (m >= 0 && m < 6) porModulo[m]++; }
          users.push({
            email: u.email, names: pf.names || "", last: pf.last || "", phone: pf.phone || "",
            nivel: d.nivel && d.nivel.level ? d.nivel.level : "", nivelFecha: d.nivel && d.nivel.date || "",
            nivelPor: d.nivel && Array.isArray(d.nivel.per) ? d.nivel.per : null,
            done: d.p ? Object.keys(d.p).length : 0, porModulo, ex: d.ex && typeof d.ex === "object" ? d.ex : {}, ex: d.ex && typeof d.ex === "object" ? d.ex : {},
            created: u.created || 0, updated: u.updated || 0,
            plan: plan.hasta > Date.now() ? (plan.tipo || "premium") : "gratis",
            planHasta: plan.hasta || 0, planEstado: plan.estado || "gratis", mpPreapproval: plan.mpPreapproval || "",
            historial: plan.historial || []
          });
        }
      }
      users.sort((x, y) => y.created - x.created);
      return json(200, { users });
    }

    const email = cleanEmail(b.email);
    if (!email) return json(400, { error: "email" });
    const key = userKey(email);
    const user = await s.get(key, { type: "json" });
    if (!user) return json(404, { error: "not_found" });

    if (action === "admin_plan") {
      const dias = Math.round(Number(b.dias));
      if (!(dias >= 0 && dias <= 400)) return json(400, { error: "dias" });
      user.plan = user.plan || {};
      user.plan.historial = user.plan.historial || [];
      if (dias === 0) {
        user.plan.hasta = 0; user.plan.estado = "gratis"; user.plan.tipo = null;
        user.plan.historial.push({ fecha: Date.now(), tipo: "retirado", monto: 0, nota: "Premium retirado por el administrador" });
      } else {
        user.plan.hasta = Math.max(user.plan.hasta || 0, Date.now()) + dias * 864e5;
        if (user.plan.estado !== "activa") { user.plan.tipo = "cortesia"; user.plan.estado = "activo"; }
        user.plan.historial.push({ fecha: Date.now(), tipo: "cortesia", monto: 0, nota: dias + " días de cortesía" });
      }
      user.plan.historial = user.plan.historial.slice(-60);
      await s.setJSON(key, user);
      return json(200, { ok: true });
    }
    if (action === "admin_clave") {
      // Contraseña temporal para un cliente que no puede recibir el correo.
      const abc = "abcdefghjkmnpqrstuvwxyz23456789";
      const clave = Array.from(randomBytes(10), x => abc[x % abc.length]).join("");
      setPassword(user, clave);
      await s.setJSON(key, user);
      return json(200, { clave });
    }
    if (action === "admin_borrar") {
      await s.delete(key);
      return json(200, { ok: true });
    }
    return json(400, { error: "action" });
  }

  // Acciones con sesión iniciada
  const token = String(b && b.token || "");
  if (!/^[0-9a-f]{48}$/.test(token)) return json(401, { error: "session" });
  const sess = await s.get("s/" + token, { type: "json" });
  if (!sess || sess.exp < Date.now()) return json(401, { error: "session" });
  const user = await s.get(sess.key, { type: "json" });
  if (!user || (user.pwChanged && (sess.at || 0) < user.pwChanged)) return json(401, { error: "session" });

  if (action === "cargar") return json(200, { email: user.email, data: user.data || null, updated: user.updated || 0 });
  if (action === "guardar") {
    const data = cleanData(b.data);
    if (data === undefined) return json(413, { error: "too_large" });
    user.data = data; user.updated = Date.now();
    if (data && data.perfil) user.perfil = cleanProfile(data.perfil);
    await s.setJSON(sess.key, user);
    return json(200, { updated: user.updated });
  }
  if (action === "salir") { await s.delete("s/" + token); return json(200, { ok: true }); }
  return json(400, { error: "action" });
}
