/**
 * /api/dashboard-test.js — Endpoint de diagnóstico
 *
 * Sube este archivo a la carpeta /api/ de tu proyecto Vercel.
 * Luego abre /test.html en el navegador para ver el diagnóstico completo.
 *
 * NO contiene datos sensibles — solo prueba conectividad.
 * Puedes eliminarlo después de resolver el problema.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    env: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      newsdata:  !!process.env.NEWSDATA_KEY,
    },
    reddit:   null,
    newsdata: null,
    claude:   null,
  };

  /* ── TEST REDDIT ─────────────────────────────────────────── */
  try {
    const r = await fetch(
      'https://www.reddit.com/search.json?q=Lopez+Aliaga+Peru&sort=new&limit=5&t=week',
      {
        headers: { 'User-Agent': 'MonitorElectoral-Test/1.0' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const posts = data?.data?.children || [];
    result.reddit = {
      ok: true,
      count: posts.length,
      titles: posts.slice(0, 3).map(p => p.data?.title || ''),
    };
  } catch (e) {
    result.reddit = { ok: false, error: e.message };
  }

  /* ── TEST NEWSDATA ───────────────────────────────────────── */
  const NEWSDATA_KEY = process.env.NEWSDATA_KEY;
  if (!NEWSDATA_KEY) {
    result.newsdata = { ok: false, error: 'NEWSDATA_KEY no configurada' };
  } else {
    try {
      const url = `https://newsdata.io/api/1/latest?apikey=${NEWSDATA_KEY}&q=Lopez+Aliaga&language=es&country=pe&size=3`;
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (data.status !== 'success') throw new Error(data.message || 'status !== success');
      result.newsdata = {
        ok: true,
        count: (data.results || []).length,
      };
    } catch (e) {
      result.newsdata = { ok: false, error: e.message };
    }
  }

  /* ── TEST CLAUDE ─────────────────────────────────────────── */
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    result.claude = { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  } else {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 30,
          messages:   [{ role: 'user', content: 'Responde solo: OK' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error('HTTP ' + r.status + ': ' + txt.slice(0, 150));
      }
      const data = await r.json();
      const reply = (data.content || []).map(b => b.text).join('');
      result.claude = {
        ok:    true,
        model: 'claude-haiku-4-5-20251001',
        reply: reply.trim(),
      };
    } catch (e) {
      result.claude = { ok: false, error: e.message };
    }
  }

  return res.status(200).json(result);
}
