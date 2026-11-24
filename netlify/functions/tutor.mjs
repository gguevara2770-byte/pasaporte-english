// Tutor IA incluido de Pasaporte English (función de Netlify).
// Usa TU clave, guardada como variable de entorno en Netlify (nunca en el código ni en el navegador):
//   GEMINI_API_KEY     → usa Gemini (Google). Tiene nivel gratuito.
//   ANTHROPIC_API_KEY  → usa Claude (Anthropic). Si están las dos, se usa Claude.
// Opcionales: GEMINI_MODEL (por defecto gemini-flash-latest) y CLAUDE_MODEL (por defecto claude-opus-5-5).
import Anthropic from "@anthropic-ai/sdk";

export const config = { path: "/api/tutor" };

const JSON_HINT = '\n\nReply with ONLY a JSON object, no other text, with exactly this shape: {"reply": "...", "reply_es": "...", "feedback": {"ok": true, "corrected": "...", "why_es": "..."}, "ideas": [{"en": "...", "es": "..."}, {"en": "...", "es": "..."}]}';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reply = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

let DATA = null;
async function loadData(req) {
  if (DATA) return DATA;
  const res = await fetch(new URL("/data/tutor.json", req.url));
  if (!res.ok) throw new Error("No se pudo leer data/tutor.json: " + res.status);
  DATA = await res.json();
  return DATA;
}

class InvalidRequest extends Error {}
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));

function buildPrompt(D, body) {
  if (!body || typeof body !== "object") throw new InvalidRequest("body");
  const level = Object.prototype.hasOwnProperty.call(D.levels, body.level) ? body.level : "A1";
  let scene, character;
  if (body.topic === "custom") {
    const t = String(body.scene ?? "").trim().slice(0, 80);
    if (!t) throw new InvalidRequest("scene");
    scene = { t, goal: "Conversar en inglés sobre el tema que elegiste.", role: "a friendly conversation partner who is curious about this topic chosen by the student: " + t };
    character = D.chars.custom;
  } else {
    const topic = D.groups.flatMap(g => g.topics).find(x => x.id === body.topic);
    if (!topic) throw new InvalidRequest("topic");
    character = D.chars[topic.id] || D.chars.custom;
    if (typeof body.scene === "string") {
      // Tema libre escrito por el usuario dentro de un tema (por ejemplo, Fútbol).
      const t = body.scene.trim().slice(0, 80);
      if (!t) throw new InvalidRequest("scene");
      scene = { t, goal: "Conversar en inglés sobre el tema que elegiste.", role: fill(D.customRole || "talking with the student about this topic related to {topic}: {text}", { topic: topic.name, text: t }) };
    } else {
      scene = topic.scen[Number(body.scene)];
      if (!scene) throw new InvalidRequest("scene");
    }
  }
  const history = Array.isArray(body.history) ? body.history : [];
  if (history.length > 20) throw new InvalidRequest("history");
  const messages = [{ role: "user", content: D.start }];
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") throw new InvalidRequest("message");
    const max = m.role === "user" ? 600 : 3000;
    if (!m.content.trim() || m.content.length > max) throw new InvalidRequest("length");
    messages.push({ role: m.role, content: m.content });
  }
  if (messages[messages.length - 1].role !== "user") throw new InvalidRequest("order");
  const system = fill(D.prompt, { name: character.n, persona: character.p, role: scene.role, scene: scene.t, goal: scene.goal, level, guide: D.levels[level] });
  return { system, messages };
}

function parseReply(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}

class UpstreamError extends Error { constructor(status) { super("upstream " + status); this.status = status; } }

async function askGemini(system, messages) {
  const key = process.env.GEMINI_API_KEY;
  const models = [...new Set([process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"].filter(Boolean))];
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + m.content; else contents.push({ role, parts: [{ text: m.content }] });
  }
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system + JSON_HINT }] }, contents, generationConfig: { responseMimeType: "application/json" } });
  let lastStatus = 502;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body
      });
      if (res.ok) {
        const d = await res.json();
        const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
        if (!parts) throw new UpstreamError(d.promptFeedback && d.promptFeedback.blockReason ? 422 : 502);
        const data = parseReply(parts.map(p => p.text || "").join(""));
        if (!data) throw new UpstreamError(502);
        return data;
      }
      lastStatus = res.status;
      console.error(`Gemini ${model} respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if (res.status === 503 || res.status === 500 || res.status === 429) { await sleep(1200); continue; }  // saturado: reintenta
      break;                                                                                                  // 404 u otro: siguiente modelo
    }
    if ([400, 401, 403].includes(lastStatus)) break;                                                         // clave mal: no seguir
  }
  throw new UpstreamError(lastStatus === 429 ? 429 : 502);
}

async function askClaude(system, messages, D) {
  const client = new Anthropic();
  const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";
  const params = {
    model, max_tokens: 8000, system, messages,
    output_config: { effort: "low", format: { type: "json_schema", schema: D.schema } }
  };
  if (/^claude-(opus|sonnet|fable)-/.test(model)) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
  let msg;
  try {
    msg = await client.beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new UpstreamError(429);
    if (err instanceof Anthropic.AuthenticationError) { console.error("ANTHROPIC_API_KEY no es válida."); throw new UpstreamError(503); }
    if (err instanceof Anthropic.APIError) { console.error(`Claude ${err.status}:`, err.message); throw new UpstreamError(502); }
    throw err;
  }
  if (msg.stop_reason === "refusal") throw new UpstreamError(422);
  const data = parseReply(msg.content.filter(b => b.type === "text").map(b => b.text).join(""));
  if (!data) throw new UpstreamError(502);
  return data;
}

export default async function handler(req) {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error("Falta la variable GEMINI_API_KEY (o ANTHROPIC_API_KEY) en Netlify.");
    return reply(503, { error: "no_api_key" });
  }
  let body;
  try { body = await req.json(); } catch { return reply(400, { error: "invalid_json" }); }

  let D, prompt;
  try {
    D = await loadData(req);
    prompt = buildPrompt(D, body);
  } catch (err) {
    if (err instanceof InvalidRequest) return reply(400, { error: "invalid_request" });
    console.error(err);
    return reply(502, { error: "server" });
  }

  try {
    const data = process.env.ANTHROPIC_API_KEY
      ? await askClaude(prompt.system, prompt.messages, D)
      : await askGemini(prompt.system, prompt.messages);
    if (!data || typeof data.reply !== "string") return reply(502, { error: "bad_output" });
    return reply(200, data);
  } catch (err) {
    if (err instanceof UpstreamError) return reply(err.status, { error: "upstream" });
    console.error(err);
    return reply(502, { error: "upstream" });
  }
}
