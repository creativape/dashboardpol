/**
 * /api/dashboard.js  —  Vercel Serverless Function (Node.js)
 *
 * FUENTES GRATUITAS SIN TARJETA DE CRÉDITO:
 * ─────────────────────────────────────────
 * 1. Reddit JSON público   → sin API key, endpoint nativo .json de Reddit
 *    Subreddits: r/Peru, r/PolíticaPeruana + búsqueda por keywords
 *    Límite: 60 req/min (anónimo con User-Agent bien formado)
 *
 * 2. NewsData.io           → 200 req/día gratis, soporta español y Perú
 *    Regístrate en https://newsdata.io  →  key en NEWSDATA_KEY
 *
 * 3. Claude (Anthropic)    → analiza TODO: sentimiento, temas, crisis, análisis
 *    Modelo: claude-haiku-4-5 (el más económico y rápido)
 *
 * VARIABLES DE ENTORNO REQUERIDAS:
 * ─────────────────────────────────
 *   ANTHROPIC_API_KEY   →  tu clave de Anthropic (console.anthropic.com)
 *   NEWSDATA_KEY        →  tu clave de NewsData.io (newsdata.io/register)
 *
 * DESPLIEGUE:
 * ───────────
 *   1. Sube esta carpeta a Vercel o cualquier hosting Node.js
 *   2. Configura las variables de entorno en el panel de Vercel
 *   3. El HTML apunta a /api/dashboard  —  todo funciona solo
 */

export default async function handler(req, res) {

  // ── CORS: permite que el HTML lo llame desde cualquier origen ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const NEWSDATA_KEY  = process.env.NEWSDATA_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Falta ANTHROPIC_API_KEY en variables de entorno.' });
  }

  try {

    // ════════════════════════════════════════════════════════════
    // 1. FUENTE A — Reddit JSON público (gratis, sin API key)
    //    Buscamos posts recientes sobre López Aliaga en subreddits peruanos
    // ════════════════════════════════════════════════════════════
    const redditPosts = await fetchReddit();

    // ════════════════════════════════════════════════════════════
    // 2. FUENTE B — NewsData.io (200 req/día gratis)
    //    Si no hay key configurada, se omite silenciosamente
    // ════════════════════════════════════════════════════════════
    const newsdataArticles = NEWSDATA_KEY ? await fetchNewsData(NEWSDATA_KEY) : [];

    // ════════════════════════════════════════════════════════════
    // 3. UNIFICAR Y DEDUPLICAR FUENTES
    // ════════════════════════════════════════════════════════════
    const rawItems = deduplicar([...redditPosts, ...newsdataArticles]);

    if (rawItems.length === 0) {
      return res.status(200).json(respuestaVacia('No se encontraron menciones recientes.'));
    }

    // ════════════════════════════════════════════════════════════
    // 4. CLAUDE — Análisis completo de sentimiento, temas y diagnóstico
    // ════════════════════════════════════════════════════════════
    const analisis = await analizarConClaude(rawItems, ANTHROPIC_KEY);

    // ════════════════════════════════════════════════════════════
    // 5. RESPUESTA FINAL
    // ════════════════════════════════════════════════════════════
    return res.status(200).json(normalizar(analisis, rawItems));

  } catch (err) {
    console.error('[dashboard] Error general:', err.message);
    return res.status(200).json(respuestaVacia('Error al obtener datos: ' + err.message));
  }
}


/* ═══════════════════════════════════════════════════════════════
   REDDIT — JSON público sin auth
   Busca en r/Peru y r/PolíticaPeruana + search global de Reddit
═══════════════════════════════════════════════════════════════ */
async function fetchReddit() {
  const UA = 'MonitorElectoral/1.0 (dashboard politico Peru 2026)';
  const keywords = ['López Aliaga', 'Lopez Aliaga', 'RenovaciónPopular', 'elecciones Peru 2026'];
  const subreddits = ['Peru', 'PolíticaPeruana', 'LatinAmerica'];

  const urls = [
    // Búsqueda por subreddit
    ...subreddits.map(sub =>
      `https://www.reddit.com/r/${sub}/search.json?q=Lopez+Aliaga&sort=new&limit=10&restrict_sr=1&t=week`
    ),
    // Búsqueda global de Reddit
    `https://www.reddit.com/search.json?q=Lopez+Aliaga+Peru+elecciones&sort=new&limit=15&t=week`,
  ];

  const results = [];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) continue;
      const data = await r.json();
      const posts = data?.data?.children || [];

      for (const child of posts) {
        const p = child.data;
        if (!p || !p.title) continue;
        // Filtrar por relevancia mínima
        const txt = (p.title + ' ' + (p.selftext || '')).toLowerCase();
        if (!keywords.some(k => txt.includes(k.toLowerCase()))) continue;

        results.push({
          titulo:  p.title,
          fuente:  'Reddit r/' + (p.subreddit || 'unknown'),
          resumen: p.selftext
            ? p.selftext.slice(0, 280).replace(/\n+/g, ' ')
            : p.title,
          url:     'https://reddit.com' + p.permalink,
          fecha:   new Date(p.created_utc * 1000).toISOString(),
          score:   p.score || 0,
          origen:  'reddit'
        });
      }
    } catch (e) {
      console.warn('[Reddit] URL falló:', e.message);
    }
  }

  // Ordenar por más reciente y tomar los 15 más relevantes
  return results
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 15);
}


/* ═══════════════════════════════════════════════════════════════
   NEWSDATA.IO — 200 req/día gratis, soporta español + Perú
   Documentación: https://newsdata.io/documentation
═══════════════════════════════════════════════════════════════ */
async function fetchNewsData(key) {
  const queries = [
    'López Aliaga',
    'elecciones Peru 2026 candidatos',
  ];
  const results = [];

  for (const q of queries) {
    try {
      const url = new URL('https://newsdata.io/api/1/latest');
      url.searchParams.set('apikey', key);
      url.searchParams.set('q',      q);
      url.searchParams.set('language','es');
      url.searchParams.set('country', 'pe');   // solo fuentes peruanas
      url.searchParams.set('size',    '10');

      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.warn('[NewsData] HTTP', r.status); continue; }

      const data = await r.json();
      if (data.status !== 'success') { console.warn('[NewsData] Error:', data.message); continue; }

      for (const art of (data.results || [])) {
        if (!art.title) continue;
        results.push({
          titulo:  art.title,
          fuente:  art.source_name || art.source_id || 'Medio peruano',
          resumen: art.description || art.content?.slice(0, 280) || art.title,
          url:     art.link || '',
          fecha:   art.pubDate || new Date().toISOString(),
          score:   0,
          origen:  'newsdata'
        });
      }
    } catch (e) {
      console.warn('[NewsData] Falló query:', q, e.message);
    }
  }

  return results
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 15);
}


/* ═══════════════════════════════════════════════════════════════
   CLAUDE — Análisis completo
   Clasifica sentimiento, extrae temas, genera diagnóstico político
═══════════════════════════════════════════════════════════════ */
async function analizarConClaude(items, apiKey) {

  // Preparar texto de entrada para Claude (máx ~2000 chars de input)
  const inputTexto = items.slice(0, 20).map((item, i) =>
    `[${i+1}] FUENTE: ${item.fuente}\nTÍTULO: ${item.titulo}\nRESUMEN: ${item.resumen?.slice(0, 200) || ''}`
  ).join('\n\n');

  const prompt = `Eres un analista político experto en elecciones peruanas 2026.
Analiza estas ${items.length} publicaciones reales de medios y redes sociales sobre Rafael López Aliaga.

PUBLICACIONES:
${inputTexto}

Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta (sin texto adicional, sin markdown):
{
  "crisis": true o false,
  "riesgo": "alto" | "medio" | "bajo",
  "tema_principal": "frase corta de máximo 70 caracteres",
  "resumen_ejecutivo": "párrafo de 2-3 oraciones con el diagnóstico general de la situación mediática",
  "noticias": [
    {
      "t": "título",
      "f": "fuente",
      "r": "resumen de 1-2 oraciones",
      "s": "neg" | "pos" | "neu",
      "tags": ["etiqueta1", "etiqueta2"],
      "nuevo": true
    }
  ],
  "temas": [
    { "nombre": "Tema", "pct": número 0-100, "tono": "neg" | "pos" | "neu" }
  ],
  "analisis": {
    "situacion_encuestas": "texto",
    "imagen_regional": "texto",
    "fortalezas": "texto",
    "segunda_vuelta": "texto"
  },
  "tendencia_redes": {
    "mencionesPos": número,
    "mencionesNeg": número,
    "mencionesNeu": número,
    "plataformas": ["Reddit", "NewsData"]
  }
}

REGLAS:
- "crisis": true solo si más del 65% de las publicaciones son negativas
- "temas" debe tener entre 4 y 8 elementos extraídos literalmente de los textos
- Para noticias, incluye TODAS las publicaciones recibidas clasificadas
- "pct" en temas representa el porcentaje de cobertura relativo a ese tema
- Responde SOLO el JSON, absolutamente nada más`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!r.ok) throw new Error('Claude HTTP ' + r.status);

  const data = await r.json();
  const rawText = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Limpiar posibles backticks de markdown
  const clean = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Claude] JSON parse error. Raw:', clean.slice(0, 400));
    // Fallback: construir respuesta básica con los items crudos
    return buildFallback(items);
  }
}


/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

/** Elimina items duplicados por título similar */
function deduplicar(items) {
  const vistos = new Set();
  return items.filter(item => {
    const key = item.titulo.toLowerCase().slice(0, 60);
    if (vistos.has(key)) return false;
    vistos.add(key);
    return true;
  });
}

/** Respuesta mínima cuando no hay datos o hay error total */
function respuestaVacia(msg) {
  return {
    crisis: false, riesgo: 'bajo',
    tema_principal: 'Sin datos disponibles',
    resumen_ejecutivo: msg,
    error: msg,
    noticias: [], temas: [],
    analisis: { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' },
    tendencia_redes: { mencionesPos:0, mencionesNeg:0, mencionesNeu:0, plataformas:[] }
  };
}

/** Fallback cuando Claude no pudo parsear JSON */
function buildFallback(items) {
  return {
    crisis: false, riesgo: 'medio',
    tema_principal: 'Datos en tiempo real',
    resumen_ejecutivo: 'Se obtuvieron datos de múltiples fuentes. El análisis de IA no está disponible temporalmente.',
    noticias: items.map((it, i) => ({
      t: it.titulo, f: it.fuente,
      r: it.resumen || it.titulo,
      s: 'neu', tags: ['Noticias'], nuevo: i < 3
    })),
    temas: [],
    analisis: { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' },
    tendencia_redes: { mencionesPos:0, mencionesNeg:0, mencionesNeu:0, plataformas:['Reddit'] }
  };
}

/** Garantiza que todos los campos existan con valores válidos */
function normalizar(data, rawItems) {
  if (!Array.isArray(data.noticias) || data.noticias.length === 0) {
    data.noticias = rawItems.slice(0, 15).map((it, i) => ({
      t: it.titulo, f: it.fuente,
      r: it.resumen || it.titulo,
      s: 'neu', tags: [], nuevo: i < 3
    }));
  }
  if (!Array.isArray(data.temas))  data.temas  = [];
  if (!data.analisis) data.analisis = { situacion_encuestas:'', imagen_regional:'', fortalezas:'', segunda_vuelta:'' };
  if (typeof data.crisis !== 'boolean') data.crisis = false;
  if (!['alto','medio','bajo'].includes(data.riesgo)) data.riesgo = 'bajo';
  if (!data.tema_principal)    data.tema_principal    = '';
  if (!data.resumen_ejecutivo) data.resumen_ejecutivo = '';
  if (!data.tendencia_redes)   data.tendencia_redes   = { mencionesPos:0, mencionesNeg:0, mencionesNeu:0, plataformas:[] };
  return data;
}
