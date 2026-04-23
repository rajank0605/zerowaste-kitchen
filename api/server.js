export default async function handler(req, res) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API key missing" });
  }

  return res.status(200).json({
    message: "API is working 🚀",
    key_present: true
  });
}
