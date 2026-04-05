export default async function handler(req, res) {
  try {
    // 1️⃣ TRAER NOTICIAS REALES
    const newsRes = await fetch(
      "https://gnews.io/api/v4/search?q=López Aliaga Perú&lang=es&token=TU_API_KEY"
    );

    const newsData = await newsRes.json();

    const titulos = newsData.articles.map(a => a.title);

    // 2️⃣ ANALIZAR CON IA (Claude)
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content:
              "Analiza estas noticias del Perú. Devuelve JSON con lista de noticias con tono (pos, neg, neu):\n" +
              titulos.join("\n")
          }
        ]
      })
    });

    const aiData = await aiRes.json();

    let noticias = [];

    try {
      noticias = JSON.parse(aiData.content[0].text);
    } catch {
      noticias = titulos.map(t => ({
        t,
        s: "neu"
      }));
    }

    res.status(200).json({ noticias });

  } catch (error) {
    res.status(200).json({
      noticias: ["Error obteniendo datos reales"]
    });
  }
}
