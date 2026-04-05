// /api/dashboard.js  — Vercel / Next.js API Route
// Trae noticias reales de GNews, las analiza con Claude y devuelve
// un JSON completo que el frontend consume para TODOS los paneles.

export default async function handler(req, res) {

  // ── CORS (por si el HTML corre en un origen distinto) ──────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {

    // ════════════════════════════════════════════════════════════
    // 1. GNEWS — noticias reales
    // ════════════════════════════════════════════════════════════
    const GNEWS_TOKEN = process.env.GNEWS_TOKEN || '78bf95dff98ab4dfc415eea5eb2188db';
    const query       = encodeURIComponent('López Aliaga Perú');
    const gnewsUrl    = `https://gnews.io/api/v4/search?q=${query}&lang=es&max=10&token=${GNEWS_TOKEN}`;

    const newsRes = await fetch(gnewsUrl);

    if (!newsRes.ok) {
      throw new Error(`GNews respondió ${newsRes.status}: ${await newsRes.text()}`);
    }

    const newsData = await newsRes.json();

    // GNews puede devolver { errors } si el token está mal o expiró
    if (newsData.errors) {
      throw new Error('GNews error: ' + JSON.stringify(newsData.errors));
    }

    const articles = newsData.articles || [];

    // Construir lista de titulares + descripción para enviar a Claude
    const titulares = articles.map((a, i) =>
      `${i + 1}. [${a.source?.name || 'Medio'}] ${a.title}${a.description ? ' — ' + a.description : ''}`
    );

    // ════════════════════════════════════════════════════════════
    // 2. CLAUDE — análisis de sentimiento, temas y diagnóstico
    // ════════════════════════════════════════════════════════════
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',   // modelo más rápido y económico
        max_tokens: 1200,
        messages: [
          {
            role: 'user',
            content: `Eres un analista político especializado en elecciones peruanas 2026.
Analiza estas noticias sobre Rafael López Aliaga y devuelve EXCLUSIVAMENTE un objeto JSON válido,
sin texto adicional, sin comillas de markdown, sin explicaciones.

Estructura exacta requerida:
{
  "crisis": true | false,
  "riesgo": "alto" | "medio" | "bajo",
  "tema_principal": "string corto (máx 60 chars)",
  "resumen_ejecutivo": "2-3 oraciones de análisis general",
  "noticias": [
    {
      "t": "título de la noticia",
      "f": "nombre del medio",
      "r": "resumen de 1-2 oraciones",
      "s": "neg" | "pos" | "neu",
      "tags": ["etiqueta1", "etiqueta2"]
    }
  ],
  "temas": [
    { "nombre": "Tema", "pct": 0-100, "tono": "neg" | "pos" | "neu" }
  ],
  "analisis": {
    "situacion_encuestas": "texto",
    "imagen_regional":     "texto",
    "fortalezas":          "texto",
    "segunda_vuelta":      "texto"
  }
}

Reglas:
- "crisis" = true si más del 60% de las noticias son negativas
- "riesgo" refleja el daño potencial a la campaña
- "temas" debe tener entre 5 y 8 elementos extraídos de las noticias
- Cada noticia debe tener máximo 2 tags
- Devuelve SOLO el JSON, nada más

Noticias a analizar:
${titulares.join('\n')}`
          }
        ]
      })
    });

    if (!aiRes.ok) {
      throw new Error(`Claude respondió ${aiRes.status}: ${await aiRes.text()}`);
    }

    const aiData = await aiRes.json();

    // Extraer el texto de la respuesta (puede venir con bloques de tipo text)
    const rawText = (aiData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Limpiar posibles backticks de markdown que Claude a veces incluye
    const cleanText = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    let resultado;
    try {
      resultado = JSON.parse(cleanText);
    } catch (parseErr) {
      // Si Claude devolvió algo no parseable, construimos respuesta de fallback
      // usando los artículos de GNews sin análisis de IA
      console.error('JSON parse error:', parseErr.message, '\nRaw:', cleanText.slice(0, 300));
      resultado = buildFallback(articles);
    }

    // Garantizar estructura mínima (por si Claude omitió algún campo)
    resultado = normalizar(resultado, articles);

    // ════════════════════════════════════════════════════════════
    // 3. RESPUESTA FINAL
    // ════════════════════════════════════════════════════════════
    res.status(200).json(resultado);

  } catch (error) {
    console.error('[dashboard] Error general:', error.message);

    // En caso de error total, devolvemos datos mínimos para que el frontend
    // no se rompa y muestre un estado de error descriptivo
    res.status(200).json({
      crisis: false,
      riesgo: 'bajo',
      tema_principal: 'Error al obtener datos',
      resumen_ejecutivo: 'No se pudieron obtener datos en este momento. Intente de nuevo.',
      error: error.message,
      noticias: [],
      temas: [],
      analisis: {
        situacion_encuestas: 'Sin datos disponibles.',
        imagen_regional:     'Sin datos disponibles.',
        fortalezas:          'Sin datos disponibles.',
        segunda_vuelta:      'Sin datos disponibles.'
      }
    });
  }
}

/* ── HELPERS ──────────────────────────────────────────────────── */

/** Construye respuesta de fallback cuando Claude no responde o falla el parse */
function buildFallback(articles) {
  return {
    crisis: false,
    riesgo: 'medio',
    tema_principal: 'Noticias en tiempo real',
    resumen_ejecutivo: 'Datos obtenidos de GNews. Análisis de IA no disponible temporalmente.',
    noticias: articles.map(a => ({
      t:    a.title,
      f:    a.source?.name || 'Medio',
      r:    a.description  || a.title,
      s:    'neu',
      tags: ['Noticias']
    })),
    temas: [],
    analisis: {
      situacion_encuestas: 'Análisis no disponible.',
      imagen_regional:     'Análisis no disponible.',
      fortalezas:          'Análisis no disponible.',
      segunda_vuelta:      'Análisis no disponible.'
    }
  };
}

/** Garantiza que todos los campos existan con valores por defecto */
function normalizar(data, articles) {
  if (!data.noticias || !Array.isArray(data.noticias) || data.noticias.length === 0) {
    data.noticias = articles.map(a => ({
      t:    a.title,
      f:    a.source?.name || 'Medio',
      r:    a.description  || a.title,
      s:    'neu',
      tags: ['Noticias']
    }));
  }
  if (!data.temas   || !Array.isArray(data.temas))  data.temas   = [];
  if (!data.analisis) data.analisis = {
    situacion_encuestas: '', imagen_regional: '', fortalezas: '', segunda_vuelta: ''
  };
  if (typeof data.crisis !== 'boolean') data.crisis = false;
  if (!['alto','medio','bajo'].includes(data.riesgo)) data.riesgo = 'bajo';
  if (!data.tema_principal)    data.tema_principal    = '';
  if (!data.resumen_ejecutivo) data.resumen_ejecutivo = '';
  return data;
}
