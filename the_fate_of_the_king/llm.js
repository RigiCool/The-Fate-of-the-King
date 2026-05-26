// ----------------------------------------------------------------- //
// ---------- OpenRouter LLM and AI image API integration ---------- //
// ----------------------------------------------------------------- //



// ------------------------------- //
// ---------- Constants ---------- //
// ------------------------------- //
const fetch = require("node-fetch");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;



// --------------------------------------------- //
// ---------- LLM and image functions ---------- //
// --------------------------------------------- //
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }



function isRetryable(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("429") ||
    msg.includes("Provider returned error")
  );
}


// Call the OpenRouter LLM API
async function callOpenRouter(body) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}


// Call the OpenRouter LLM API with retry logic
async function callOpenRouterWithRetry(body, { retries = 2, baseDelayMs = 400 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await callOpenRouter(body); }
    catch (e) {
      last = e;
      if (!isRetryable(e) || attempt === retries) break;
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw last;
}



// Call the OpenRouter LLM API with a prompt and JSON schema for structured JSON response
async function callLLMJson(body, schemaObj) {
  const useSchema = schemaObj
  const finalBody = useSchema
    ? { ...body, response_format: { type: "json_schema", json_schema: schemaObj } }
    : body;

  if (!useSchema && schemaObj) {
    finalBody.messages = [
      ...(finalBody.messages || []),
      {
        role: "user",
        content: `Return ONLY valid JSON. No markdown. Must match schema:\n${JSON.stringify(schemaObj.schema, null, 2)}`
      }
    ];
  }

  return await callOpenRouterWithRetry(finalBody);
}



// Image generation based on a llm generated prompt
async function generateImage(prompt) {
  const url = `https://ai-image-api.xeven.workers.dev/img?prompt=${encodeURIComponent(prompt)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to generate image: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return `data:image/png;base64,${base64}`;
}

module.exports = { callLLMJson, generateImage };
