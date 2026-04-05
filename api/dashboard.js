export default async function handler(req, res) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: "Dame 5 noticias actuales del Perú en formato titular corto"
          }
        ]
      })
    });

    const data = await response.json();

    // 🔥 si hay error, devuelve fallback
    if (data.error) {
      return res.status(200).json({
        fallback: true,
        noticias: [
          "No hay conexión con IA (sin crédito)",
          "Agrega saldo en Anthropic",
          "El sistema está listo, solo falta activar API",
          "Puedes seguir usando noticias base",
          "Dashboard funcionando en modo demo"
        ]
      });
    }

    res.status(200).json(data);

  } catch (err) {
    res.status(200).json({
      fallback: true,
      noticias: [
        "Error conectando con IA",
        "Revisa tu API o conexión",
        "Sistema funcionando en modo local"
      ]
    });
  }
}
