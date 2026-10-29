// Cloudflare Worker — ElAthar
//  1) بروكسي لـ Gemini (POST على الرابط الأساسي /) — المفتاح بيفضل سري عندك
//  2) شات الجروب + الأونلاين + التسجيل على قاعدة D1 (من غير Firebase)
//
// الإعدادات (Settings):
//  - Variables: GEMINI_KEY (Secret) ، MODEL (اختياري — لو سيبته فاضي بيستخدم gemini-flash-latest وبيبدّل لأحدث موديل متاح تلقائيًا)
//  - Bindings ← D1 database ← Variable name = DB   (الجداول بتتعمل لوحدها)
const ROOMS = ['general', 'qs', 'prac'];
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'};
const J = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {...CORS, 'Content-Type': 'application/json'}});
let ready;
function init(env) {
  if (!env.DB) throw new Error('D1 binding missing: اربط قاعدة D1 باسم DB');
  return ready || (ready = env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, u TEXT, n TEXT, t TEXT, ts INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS msgs_room ON msgs(room, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS presence(u TEXT PRIMARY KEY, n TEXT, ts INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users(u TEXT PRIMARY KEY, n TEXT, ts INTEGER)')
  ]).catch(e => { ready = null; throw e; }));
}
const body = async req => { const s = await req.text(); if (s.length > 4000) throw new Error('too big'); try { return JSON.parse(s) } catch (e) { return {} } };
const okU = u => typeof u === 'string' && /^[a-z0-9]{4,16}$/.test(u);
const cleanN = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);

async function chat(req, env, url) {
  const room = url.pathname.split('/')[2];
  if (!ROOMS.includes(room)) return J({error: 'bad room'}, 400);
  const db = env.DB;
  if (req.method === 'GET') {
    const after = Math.max(0, +url.searchParams.get('after') || 0), limit = Math.min(100, Math.max(1, +url.searchParams.get('limit') || 60));
    const r = after
      ? await db.prepare('SELECT id,u,n,t,ts FROM msgs WHERE room=? AND id>? ORDER BY id ASC LIMIT 100').bind(room, after).all()
      : await db.prepare('SELECT id,u,n,t,ts FROM (SELECT id,u,n,t,ts FROM msgs WHERE room=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC').bind(room, limit).all();
    return J({m: r.results || []});
  }
  if (req.method === 'POST') {
    const b = await body(req), u = b.u, n = cleanN(b.n), t = String(b.t || '').trim().slice(0, 500), now = Date.now();
    if (!okU(u) || !n || !t) return J({error: 'bad message'}, 400);
    const last = await db.prepare('SELECT ts FROM msgs WHERE u=? ORDER BY id DESC LIMIT 1').bind(u).first();
    if (last && now - last.ts < 800) return J({error: 'بشويش شوية 🙂'}, 429);
    const r = await db.prepare('INSERT INTO msgs(room,u,n,t,ts) VALUES(?,?,?,?,?)').bind(room, u, n, t, now).run();
    if (Math.random() < 0.05) await db.prepare('DELETE FROM msgs WHERE room=? AND id<=(SELECT id FROM msgs WHERE room=? ORDER BY id DESC LIMIT 1 OFFSET 500)').bind(room, room).run();
    return J({ok: true, id: r.meta && r.meta.last_row_id});
  }
  return J({error: 'method'}, 405);
}

async function presence(req, env) {
  const db = env.DB, now = Date.now();
  if (req.method === 'POST') {
    const b = await body(req), n = cleanN(b.n);
    if (okU(b.u) && n) await db.prepare('INSERT INTO presence(u,n,ts) VALUES(?,?,?) ON CONFLICT(u) DO UPDATE SET n=excluded.n, ts=excluded.ts').bind(b.u, n, now).run();
    if (Math.random() < 0.03) await db.prepare('DELETE FROM presence WHERE ts<?').bind(now - 3600e3).run();
  }
  const r = await db.prepare('SELECT n FROM presence WHERE ts>? ORDER BY ts DESC LIMIT 60').bind(now - 45000).all();
  return J({on: (r.results || []).map(x => x.n)});
}

async function register(req, env) {
  const b = await body(req), n = cleanN(b.n);
  if (!okU(b.u) || !n) return J({error: 'bad'}, 400);
  await env.DB.prepare('INSERT INTO users(u,n,ts) VALUES(?,?,?) ON CONFLICT(u) DO UPDATE SET n=excluded.n').bind(b.u, n, Date.now()).run();
  return J({ok: true});
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    const url = new URL(req.url), p = url.pathname;
    if (p.startsWith('/chat/') || p === '/presence' || p === '/register') {
      try {
        await init(env);
        if (p === '/presence') return await presence(req, env);
        if (p === '/register') return await register(req, env);
        return await chat(req, env, url);
      } catch (e) { return J({error: String(e.message || e)}, 500); }
    }
    // ---- بروكسي Gemini (Streaming + إيقاف التفكير + تبديل الموديل تلقائيًا لو اتقفل) ----
    const text = await req.text();
    if (text.length > 14e6) return J({error: 'too big'}, 413);
    const stream = url.searchParams.get('stream');
    const models = [env.MODEL, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'].filter((m, i, a) => m && a.indexOf(m) === i);
    const call = (model, body) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      {method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY}, body});
    let r;
    for (const model of models) {
      let body = text;
      if (!/pro/.test(model)) { try { const o = JSON.parse(text); o.generationConfig = Object.assign({}, o.generationConfig, {thinkingConfig: {thinkingBudget: 0}}); body = JSON.stringify(o); } catch (e) {} }
      r = await call(model, body);
      if (r.status === 400 && body !== text && /thinking/i.test(await r.clone().text())) r = await call(model, text);
      if (r.ok) break;
      const t = await r.clone().text();
      if (!(r.status === 404 || /no longer available|not found|not supported|deprecat/i.test(t))) break;
    }
    return new Response(r.body, {status: r.status, headers: {...CORS, 'Content-Type': stream && r.ok ? 'text/event-stream' : 'application/json', 'Cache-Control': 'no-store'}});
  }
};
