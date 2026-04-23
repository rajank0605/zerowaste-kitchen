export default async function handler(req, res) {
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.send(
        JSON.stringify({ error: "API key missing" })
      );
    }

    res.setHeader("Content-Type", "application/json");

    return res.send(
      JSON.stringify({
        message: "API is working ✅"
      })
    );

  } catch (error) {
    return res.send(
      JSON.stringify({
        error: "Something went wrong",
        details: error.message
      })
    );
  }
}
