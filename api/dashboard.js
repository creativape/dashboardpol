/**
 * /api/dashboard.js — Vercel Serverless Function
 *
 * FUENTES (todas funcionan desde Vercel sin bloqueos):
 * ─────────────────────────────────────────────────────
 * 1. NewsData.io       → noticias peruanas en español (200 req/día gratis)
 * 2. RSS de medios PE  → La República, RPP, El Comercio, Infobae Perú
 *    Convertidos via rss2json.com (gratis, sin key, 10k req/día)
 * 3. Claude IA         → análisis de sentimiento, temas y diagnóstico
 *
 * VARIABLES DE ENTORNO (Vercel → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY  →  sk-ant-api03-...   (console.anthropic.com)
 *   NEWSDATA_KEY       →  pub_...            (newsdata.io — opcional)
 */

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NEWSDATA_KEY  = process.env.NEWSDATA_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(200).json(emptyResponse(
      'ANTHROPIC_API_KEY no configurada. Ve a Vercel → Settings → Environment Variables y agrégala.'
    ));
  }

  try {
    // Obtener noticias de múltiples fuentes en paralelo
    const [rssItems, newsdataItems] = await Promise.all([
      fetchRSS(),
      NEWSDATA_KEY ? fetchNewsData(NEWSDATA_KEY) : [],
    ]);

    const rawItems = dedup([...rssItems, ...newsdataItems]);

    if (rawItems.length === 0) {
      return res.status(200).json(emptyResponse(
        'No se encontraron noticias recientes. Los feeds RSS pueden estar temporalmente lentos. Intenta en unos minutos.'
      ));
    }

    // Analizar con Claude
    const analysis = await analyzeWithClaude(rawItems, ANTHROPIC_KEY);
    return res.status(200).json(normalize(analysis, rawItems));

  } catch (err) {
    console.error('[dashboard]', err.message);
    return res.status(200).json(emptyResponse('Error interno: ' + err.message));
  }
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 1 — RSS de medios peruanos
   Convertidos a JSON via rss2json.com (gratis, sin key, 10k/día)
   Medios: La República, RPP Noticias, El Comercio, Infobae Perú,
           Gestión, América Noticias
══════════════════════════════════════════════════════════════ */
async function fetchRSS() {
  const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

  // RSS feeds de medios peruanos que cubren política
  const feeds = [
    { url: 'https://larepublica.pe/feeds/rss', name: 'La República' },
    { url: 'https://rpp.pe/rss/politica.xml',  name: 'RPP Noticias' },
    { url: 'https://elcomercio.pe/rss/politica.xml', name: 'El Comercio' },
    { url: 'https://www.infobae.com/feeds/rss/peru/', name: 'Infobae Perú' },
    { url: 'https://gestion.pe/rss/politica', name: 'Gestión' },
  ];

  // Keywords para filtrar solo lo relevante
  const KEYWORDS = [
    'lópez aliaga', 'lopez aliaga', 'renovación popular', 'renovacion popular',
    'aliaga', 'elecciones 2026', 'candidato', 'primera vuelta', 'segunda vuelta',
  ];

  const items = [];

  // Fetch todos en paralelo con timeout individual
  const promises = feeds.map(async (feed) => {
    try {
      const url = RSS2JSON + encodeURIComponent(feed.url) + '&count=20';
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const data = await r.json();
      if (data.status !== 'ok' || !Array.isArray(data.items)) return;

      for (const item of data.items) {
        if (!item.title) continue;
        const txt = (item.title + ' ' + (item.description || '')).toLowerCase();
        if (!KEYWORDS.some(k => txt.includes(k))) continue;

        // Limpiar HTML de la descripción
        const desc = (item.description || item.content || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);

        items.push({
          titulo:  item.title,
          fuente:  feed.name,
          resumen: desc || item.title,
          fecha:   item.pubDate || new Date().toISOString(),
          origen:  'rss',
        });
      }
    } catch (e) {
      console.warn('[RSS]', feed.name, e.message);
    }
  });

  await Promise.all(promises);

  return dedup(items)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 20);
}

/* ══════════════════════════════════════════════════════════════
   FUENTE 2 — NewsData.io
   200 req/día gratis · registro en newsdata.io/register
══════════════════════════════════════════════════════════════ */
async function fetchNewsData(key) {
  const queries = [
    'López Aliaga elecciones Peru',
    'elecciones presidenciales Peru 2026',
  ];
  const items = [];

  for (const q of queries) {
    try {
      const url = `https://newsdata.io/api/1/latest`
        + `?apikey=${encodeURIComponent(key)}`
        + `&q=${encodeURIComponent(q)}`
        + `&language=es&country=pe&size=8`;

      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) { console.warn('[NewsData] HTTP', r.status); continue; }

      const data = await r.json();
      if (data.status !== 'success') { console.warn('[NewsData]', data.message); continue; }

      for (const a of (data.results || [])) {
        if (!a.title) continue;
        items.push({
          titulo:  a.title,
          fuente:  a.source_name || a.source_id || 'Medio peruano',
          resumen: a.description || (a.content || '').slice(0, 300) || a.title,
          fecha:   a.pubDate || new Date().toISOString(),
          origen:  'newsdata',
        });
      }
    } catch (e) {
      console.warn('[NewsData]', e.message);
    }
  }

  return dedup(items)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 15);
}

/* ══════════════════════════════════════════════════════════════
   CLAUDE — análisis completo de sentimiento, temas y diagnóstico
══════════════════════════════════════════════════════════════ */
async function analyzeWithClaude(items, apiKey) {
  const texto = items.slice(0, 20).map((it, i) =>
    `[${i + 1}] FUENTE: ${it.fuente}\nTÍTULO: ${it.titulo}\nRESUMEN: ${(it.resumen || '').slice(0, 250)}`
  ).join('\n\n');

  const prompt = `Eres un analista político experto en las elecciones peruanas 2026.
Analiza estas ${items.length} noticias reales de medios peruanos sobre Rafael López Aliaga.

NOTICIAS:
${texto}

Devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin backticks:
{
  "crisis": true o false,
  "riesgo": "alto"|"medio"|"bajo",
  "tema_principal": "frase corta máx 70 caracteres",
  "resumen_ejecutivo": "2-3 oraciones de diagnóstico general",
  "noticias": [
    { "t": "título", "f": "fuente", "r": "resumen 1-2 oraciones", "s": "neg"|"pos"|"neu", "tags": ["tag1","tag2"] }
  ],
  "temas": [
    { "nombre": "Tema", "pct": número 0-100, "tono": "neg"|"pos"|"neu" }
  ],
  "analisis": {
    "situacion_encuestas": "texto basado en las noticias",
    "imagen_regional": "texto basado en las noticias",
    "fortalezas": "texto basado en las noticias",
    "segunda_vuelta": "texto basado en las noticias"
  }
}
REGLAS: crisis=true si >65% negativos. temas: 4-8 elementos. Incluye TODAS las noticias. Solo el JSON.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Claude HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }

  const data  = await r.json();
  const raw   = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Claude parse error]', clean.slice(0, 300));
    return fallback(items);
  }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
function dedup(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.titulo.toLowerCase().slice(0, 55);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyResponse(msg) {
  return {
    error: msg, crisis: false, riesgo: 'bajo',
    tema_principal: 'Sin datos', resumen_ejecutivo: msg,
    noticias: [], temas: [],
    analisis: { situacion_encuestas: '', imagen_regional: '', fortalezas: '', segunda_vuelta: '' },
  };
}

function fallback(items) {
  return {
    crisis: false, riesgo: 'medio',
    tema_principal: 'Noticias de medios peruanos',
    resumen_ejecutivo: 'Datos obtenidos de RSS y NewsData. Análisis de IA temporalmente no disponible.',
    noticias: items.map((it, i) => ({
      t: it.titulo, f: it.fuente, r: it.resumen || it.titulo,
      s: 'neu', tags: [], nuevo: i < 3,
    })),
    temas: [],
    analisis: { situacion_encuestas: '', imagen_regional: '', fortalezas: '', segunda_vuelta: '' },
  };
}

function normalize(data, rawItems) {
  if (!Array.isArray(data.noticias) || data.noticias.length === 0) {
    data.noticias = rawItems.slice(0, 15).map((it, i) => ({
      t: it.titulo, f: it.fuente, r: it.resumen || it.titulo,
      s: 'neu', tags: [], nuevo: i < 3,
    }));
  }
  if (!Array.isArray(data.temas))  data.temas = [];
  if (!data.analisis) data.analisis = { situacion_encuestas: '', imagen_regional: '', fortalezas: '', segunda_vuelta: '' };
  if (typeof data.crisis !== 'boolean') data.crisis = false;
  if (!['alto', 'medio', 'bajo'].includes(data.riesgo)) data.riesgo = 'bajo';
  data.tema_principal    = data.tema_principal    || '';
  data.resumen_ejecutivo = data.resumen_ejecutivo || '';
  return data;
}
