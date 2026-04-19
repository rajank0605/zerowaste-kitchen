const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const API_KEY = process.env.GROQ_API_KEY || "";

if (!API_KEY) {
  console.error("\n❌ Missing GROQ_API_KEY environment variable.");
  console.error('Run: $env:GROQ_API_KEY="Grok_API_Key"\n');
  process.exit(1);
}

console.log("🔑 API KEY LOADED:", API_KEY.substring(0, 10) + "...");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function groqRequest(messages, { temperature = 0.6, max_tokens = 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      temperature,
      max_tokens,
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    console.log("🚀 Sending to Groq [type from caller]...");

    const req = https.request(options, (apiRes) => {
      let data = "";
      console.log("📡 Groq STATUS:", apiRes.statusCode);
      apiRes.on("data", (chunk) => (data += chunk));
      apiRes.on("end", () => {
        console.log("✅ Groq done");
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || "Groq API error"));
          const text = json?.choices?.[0]?.message?.content || "";
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Groq response: " + e.message));
        }
      });
    });

    req.on("error", (e) => reject(new Error("Network error: " + e.message)));
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(payload);
    req.end();
  });
}

function buildInventoryContext(inventory) {
  if (!inventory || inventory.length === 0) return "No ingredients in inventory.";
  const urgent = inventory.filter(i => i.expiry === "urgent");
  const soon   = inventory.filter(i => i.expiry === "soon");
  const ok     = inventory.filter(i => i.expiry === "ok");
  const fresh  = inventory.filter(i => i.expiry === "fresh");
  let ctx = "CURRENT INVENTORY (sorted by urgency):\n";
  if (urgent.length) ctx += `🔴 MUST USE TODAY (expires today): ${urgent.map(i => i.name).join(", ")}\n`;
  if (soon.length)   ctx += `🟠 Use within 2-3 days: ${soon.map(i => i.name).join(", ")}\n`;
  if (ok.length)     ctx += `🟡 Use this week: ${ok.map(i => i.name).join(", ")}\n`;
  if (fresh.length)  ctx += `🟢 Fresh (good 1+ week): ${fresh.map(i => i.name).join(", ")}\n`;
  return ctx;
}

function sendJSON(res, corsHeaders, status, obj) {
  res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  if (req.method === "POST" && req.url === "/api/claude") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return sendJSON(res, corsHeaders, 400, { error: "Bad JSON" }); }

      const { type, inventory = [], filters = {}, chatHistory = [], userMessage = "" } = parsed;

      try {
        // ── RECIPE ──────────────────────────────────────────────
        if (type === "recipe") {
          const invCtx = buildInventoryContext(inventory);
          const { cuisine, time, diet } = filters;

          const systemPrompt = `You are an expert zero-waste chef. Your top priority is using ingredients that expire soonest to prevent food waste. Output ONLY a valid JSON object — no markdown, no backticks, no extra text before or after.`;

          const userPrompt = `${invCtx}

User filters:
- Cuisine: ${cuisine || "any"}
- Max cooking time: ${time || "any"}
- Diet: ${diet || "any"}

RULES:
1. MUST prioritize ingredients labeled "MUST USE TODAY" then "Use within 2-3 days"
2. Respect all user filters above
3. Only use inventory ingredients plus basic staples (salt, pepper, oil, water, common spices)
4. Return exactly ONE recipe

Return ONLY this JSON (no other text):
{"emoji":"🍳","title":"Recipe Name","description":"One sentence about the dish","time":"25 min","uses":["ingredient1","ingredient2"],"ingredients":["200g chicken breast","1 cup spinach"],"steps":["Step 1","Step 2","Step 3","Step 4"],"wasteSaved":"3 expiring items used"}`;

          const raw = await groqRequest(
            [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
            { temperature: 0.5, max_tokens: 700 }
          );

          let text = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          if (start !== -1 && end !== -1) text = text.slice(start, end + 1);

          let recipeObj;
          try { recipeObj = JSON.parse(text); }
          catch {
            recipeObj = { emoji:"⚠️", title:"Could not parse recipe", description:"Please try again", time:"–", uses:[], ingredients:[], steps:["Try generating again"], wasteSaved:"0" };
          }

          return sendJSON(res, corsHeaders, 200, { content: [{ type: "text", text: JSON.stringify(recipeObj) }] });
        }

        // ── CHAT ────────────────────────────────────────────────
        if (type === "chat") {
          const invCtx = buildInventoryContext(inventory);
          const systemPrompt = `You are a friendly, expert zero-waste kitchen chef assistant. Help users cook smart meals using what they already have, reduce food waste, and give practical advice.

${invCtx}

IMPORTANT:
- Ingredients marked "MUST USE TODAY" are urgent — always mention ways to use them first
- Give specific advice based on the actual inventory above, not generic advice
- Be warm, practical, and concise
- When suggesting recipes, include key ingredients and brief steps
- Always account for expiry urgency`;

          const messages = [
            { role: "system", content: systemPrompt },
            ...chatHistory,
            { role: "user", content: userMessage }
          ];

          const reply = await groqRequest(messages, { temperature: 0.7, max_tokens: 900 });
          return sendJSON(res, corsHeaders, 200, { content: [{ type: "text", text: reply }] });
        }

        // ── WEEK PLAN ────────────────────────────────────────────
        if (type === "weekplan") {
          const invCtx = buildInventoryContext(inventory);
          const userPrompt = `${invCtx}

Create a 7-day meal plan (Monday to Sunday):
- Monday/Tuesday: use all "MUST USE TODAY" and "Use within 2-3 days" ingredients
- Wednesday/Thursday: use "Use this week" ingredients
- Friday onwards: use "Fresh" ingredients
- Include breakfast, lunch, dinner for each day
- Name which inventory items are used each day
- Add brief storage or prep tips where useful
Be specific and practical.`;

          const reply = await groqRequest(
            [
              { role: "system", content: "You are a practical zero-waste meal planning chef. Create realistic varied weekly meal plans that prevent food waste by using the most perishable ingredients first." },
              { role: "user", content: userPrompt }
            ],
            { temperature: 0.6, max_tokens: 1500 }
          );
          return sendJSON(res, corsHeaders, 200, { content: [{ type: "text", text: reply }] });
        }

        // ── DAY SUGGESTION ───────────────────────────────────────
        if (type === "daysuggestion") {
          const invCtx = buildInventoryContext(inventory);
          const { day } = filters;

          const userPrompt = `${invCtx}

Suggest ONE great meal for ${day || "today"} that uses the most urgent expiring ingredients. Give:
1. The meal name
2. 2 sentences: what makes it good and which expiring items it uses
3. One quick tip`;

          const reply = await groqRequest(
            [
              { role: "system", content: "You are a concise zero-waste chef. Give a specific, practical meal suggestion focused on preventing food waste from the user's inventory." },
              { role: "user", content: userPrompt }
            ],
            { temperature: 0.6, max_tokens: 250 }
          );
          return sendJSON(res, corsHeaders, 200, { content: [{ type: "text", text: reply }] });
        }

        return sendJSON(res, corsHeaders, 400, { error: "Unknown type: " + type });

      } catch (e) {
        console.error("❌ Error:", e.message);
        return sendJSON(res, corsHeaders, 500, { error: e.message });
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log("\n🌿 ZeroWaste Kitchen is running!");
  console.log(`   Open: http://localhost:${PORT}\n`);
});
