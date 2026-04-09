/**
 * /api/dashboard.js — Vercel Serverless Function
 *
 * Todas las fuentes buscan EXCLUSIVAMENTE noticias sobre López Aliaga.
 * El análisis de Claude clasifica sentimiento respecto a él.
 *
 * VARIABLES DE ENTORNO:
 *   ANTHROPIC_API_KEY  → console.anthropic.com
 *   NEWSDATA_KEY       → newsdata.io/register (gratis, 200 req/día)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NEWSDATA_KEY  = process.env.NEWSDATA_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(200).json(vacio('Falta ANTHROPIC_API_KEY en Vercel → Settings → Environment Variables.'));
  }

  try {
    /* Buscar noticias sobre López Aliaga en paralelo */
    const [rssItems, newsdataItems] = await Promise.all([
      fetchRSS(),
      NEWSDATA_KEY ? fetchNewsData(NEWSDATA_KEY) : [],
    ]);

    const items = dedup([...rssItems, ...newsdataItems]);

    if (items.length === 0) {
      return res.status(200).json(vacio(
        'No se encontraron noticias sobre López Aliaga en este momento. Los feeds RSS pueden estar lentos — intenta en unos minutos.'
      ));
    }

    const resultado = await analizarClaude(items, ANTHROPIC_KEY);
    return res.status(200).json(normalizar(resultado, items));

  } catch (err) {
    console.error('[dashboard]', err.message);
    return res.status(200).json(vacio('Error: ' + err.message));
  }
}

/* ══════════════════════════════════════════════════════
   FUENTE 1 — RSS de medios peruanos filtrado para López Aliaga
   Convertido a JSON via rss2json.com (gratis, 10k req/día, sin key)
══════════════════════════════════════════════════════ */
async function fetchRSS() {
  const BASE = 'https://api.rss2json.com/v1/api.json?rss_url=';

  /* Feeds de medios peruanos con cobertura política */
  const feeds = [
    { url: 'https://larepublica.pe/feeds/rss',           nombre: 'La República' },
    { url: 'https://rpp.pe/rss/politica.xml',            nombre: 'RPP Noticias' },
    { url: 'https://elcomercio.pe/rss/politica.xml',     nombre: 'El Comercio' },
    { url: 'https://www.infobae.com/feeds/rss/peru/',    nombre: 'Infobae Perú' },
    { url: 'https://gestion.pe/rss/politica',            nombre: 'Gestión' },
    { url: 'https://peru21.pe/feed/',                    nombre: 'Peru21' },
  ];

  /* Solo nos interesan noticias que hablen de él */
  const KEYS = ['lópez aliaga','lopez aliaga','aliaga','renovación popular','renovacion popular'];

  const todos = [];
  await Promise.all(feeds.map(async (feed) => {
    try {
      const url = BASE + encodeURIComponent(feed.url) + '&count=25';
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const data = await r.json();
      if (data.status !== 'ok' || !Array.isArray(data.items)) return;

      for (const item of data.items) {
        if (!item.title) continue;
        /* Filtro estricto: el título o descripción deben mencionar a López Aliaga */
        const txt = (item.title + ' ' + (item.description || '')).toLowerCase();
        if (!KEYS.some(k => txt.includes(k))) continue;

        const desc = (item.description || item.content || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320);

        todos.push({
          titulo:  item.title,
          fuente:  feed.nombre,
          resumen: desc || item.title,
          fecha:   item.pubDate || new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn('[RSS]', feed.nombre, e.message);
    }
  }));

  return dedup(todos).sort((a,b) => new Date(b.fecha)-new Date(a.fecha)).slice(0, 18);
}

/* ══════════════════════════════════════════════════════
   FUENTE 2 — NewsData.io buscando solo a López Aliaga
══════════════════════════════════════════════════════ */
async function fetchNewsData(key) {
  /* Queries específicas para López Aliaga */
  const queries = [
    '"López Aliaga"',
    'Lopez Aliaga Peru elecciones',
  ];
  const todos = [];

  for (const q of queries) {
    try {
      const url = 'https://newsdata.io/api/1/latest'
        + '?apikey=' + encodeURIComponent(key)
        + '&q='      + encodeURIComponent(q)
        + '&language=es&country=pe&size=8';

      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.status !== 'success') continue;

      for (const a of (data.results || [])) {
        if (!a.title) continue;
        /* Doble verificación: que realmente hable de él */
        const txt = (a.title + ' ' + (a.description||'')).toLowerCase();
        if (!txt.includes('aliaga')) continue;

        todos.push({
          titulo:  a.title,
          fuente:  a.source_name || 'Medio peruano',
          resumen: a.description || (a.content||'').slice(0,320) || a.title,
          fecha:   a.pubDate || new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn('[NewsData]', e.message);
    }
  }

  return dedup(todos).sort((a,b) => new Date(b.fecha)-new Date(a.fecha)).slice(0, 12);
}

/* ══════════════════════════════════════════════════════
   CLAUDE — clasifica sentimiento RESPECTO A LÓPEZ ALIAGA
   y genera temas, análisis y diagnóstico sobre él
══════════════════════════════════════════════════════ */
async function analizarClaude(items, apiKey) {
  const texto = items.slice(0, 20).map((it, i) =>
    `[${i+1}] FUENTE: ${it.fuente}\nTÍTULO: ${it.titulo}\nRESUMEN: ${(it.resumen||'').slice(0,280)}`
  ).join('\n\n');

  const prompt = `Eres un analista político especializado en la campaña de Rafael López Aliaga en las elecciones peruanas 2026.

Analiza estas ${items.length} noticias reales de medios peruanos. Todas hablan sobre López Aliaga.

IMPORTANTE — criterio de sentimiento:
- "pos" = la noticia es favorable para López Aliaga (lo defiende, muestra apoyo, logros, encuestas subiendo, base electoral fuerte)
- "neg" = la noticia es desfavorable para él (protestas en su contra, caída en encuestas, críticas, escándalos, rechazo)
- "neu" = noticia informativa sin tono claro (debate, agenda, declaraciones sin juicio)

NOTICIAS:
${texto}

Devuelve ÚNICAMENTE este JSON válido, sin texto adicional, sin backticks:
{
  "crisis": true o false,
  "riesgo": "alto"|"medio"|"bajo",
  "tema_principal": "frase corta máx 70 chars sobre la situación actual de López Aliaga",
  "resumen_ejecutivo": "2-3 oraciones: diagnóstico de cómo está López Aliaga en los medios hoy",
  "noticias": [
    {
      "t": "título de la noticia",
      "f": "nombre del medio",
      "r": "resumen de 1-2 oraciones sobre qué dice la noticia de López Aliaga",
      "s": "neg"|"pos"|"neu",
      "tags": ["Encuestas", "Protestas"] (máx 2 tags descriptivos del tema)
    }
  ],
  "temas": [
    {
      "nombre": "nombre del tema (ej: Caída en encuestas, Protestas en el sur, Lima base fuerte)",
      "pct": número del 0 al 100 que indica cuánto peso tiene ese tema en la cobertura,
      "tono": "neg"|"pos"|"neu"
    }
  ],
  "analisis": {
    "situacion_encuestas": "cómo están sus números en las encuestas según las noticias",
    "imagen_regional": "cómo lo tratan en Lima vs regiones según las noticias",
    "fortalezas": "qué lo favorece según la cobertura actual",
    "segunda_vuelta": "perspectiva de segunda vuelta según las noticias"
  }
}

REGLAS:
- crisis=true si más del 65% de las noticias son negativas para él
- temas: entre 4 y 8 temas extraídos de los textos reales
- El campo "pct" de temas debe sumar aproximadamente 100 entre todos
- Incluye TODAS las noticias en el array "noticias"
- Solo responde el JSON, nada más`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Claude HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }

  const data  = await r.json();
  const raw   = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();

  try {
    return JSON.parse(clean);
  } catch(e) {
    console.error('[Claude parse]', clean.slice(0,300));
    return fallback(items);
  }
}

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */
function dedup(items) {
  const seen = new Set();
  return items.filter(it => {
    const k = it.titulo.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function vacio(msg) {
  return {
    error: msg, crisis: false, riesgo: 'bajo',
    tema_principal: 'Sin datos', resumen_ejecutivo: msg,
    noticias: [], temas: [],
    analisis: { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' },
  };
}

function fallback(items) {
  return {
    crisis: false, riesgo: 'medio',
    tema_principal: 'Noticias sobre López Aliaga',
    resumen_ejecutivo: 'Datos obtenidos de medios peruanos. Análisis de IA no disponible temporalmente.',
    noticias: items.map((it,i) => ({ t:it.titulo, f:it.fuente, r:it.resumen||it.titulo, s:'neu', tags:[], nuevo:i<3 })),
    temas: [],
    analisis: { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' },
  };
}

function normalizar(data, items) {
  if (!Array.isArray(data.noticias) || !data.noticias.length) {
    data.noticias = items.slice(0,15).map((it,i) => ({ t:it.titulo, f:it.fuente, r:it.resumen||it.titulo, s:'neu', tags:[], nuevo:i<3 }));
  }
  if (!Array.isArray(data.temas))  data.temas  = [];
  if (!data.analisis) data.analisis = { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' };
  if (typeof data.crisis !== 'boolean') data.crisis = false;
  if (!['alto','medio','bajo'].includes(data.riesgo)) data.riesgo = 'bajo';
  data.tema_principal    = data.tema_principal    || '';
  data.resumen_ejecutivo = data.resumen_ejecutivo || '';
  return data;
}
