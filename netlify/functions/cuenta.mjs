// Cuentas de Pasaporte English: iniciar sesión y guardar el progreso en la nube (Netlify Blobs).
// Las contraseñas nunca se guardan: solo un hash PBKDF2 con sal aleatoria.
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/cuenta" };

const MAX_DATA = 200000;                       // tamaño máximo del progreso guardado (caracteres)
const SESSION_MS = 1000 * 60 * 60 * 24 * 90;   // la sesión dura 90 días
const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const store = () => getStore({ name: "pasaporte-cuentas", consistency: "strong" });
const userKey = email => "u/" + createHash("sha256").update(email).digest("hex");
const hashPw = (pw, salt) => pbkdf2Sync(pw, salt, 120000, 32, "sha256").toString("hex");

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
    await s.setJSON("s/" + token, { key, exp: Date.now() + SESSION_MS });
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
            done: d.p ? Object.keys(d.p).length : 0, porModulo,
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
  if (!user) return json(401, { error: "session" });

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
