const { callLLMJson } = require("../llm");
const { makeValidator, parseStrictJson, normalizeCard } = require("../validator/validator.js");
const { CARD_SCHEMA } = require("../schema/card-schema");
const { KING_SCHEMA } = require("../schema/king-schema");
const { buildRepeatAvoidanceBlock, isNearDuplicateCard, buildFallbackCard } = require("../helpers/card-repeat");

const validateCard = makeValidator(CARD_SCHEMA.schema);
const validateKing = makeValidator(KING_SCHEMA.schema);

async function generateCard(prompt, {
  model = process.env.MODEL_ID || "arcee-ai/trinity-large-preview:free",
  systemPrompt,
  recentCards = [],
  maxAttempts = 3
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("generateCard requires a non-empty prompt");
  }

  const message = systemPrompt || `ROLE: You are a professional dark medieval narrative designer. Return only valid JSON with fields title, description, choices[]. Optionally include arc field with title, kind, expectedTurns, triggerMetric, stakes.`;
  const antiRepeatBlock = buildRepeatAvoidanceBlock(recentCards);
  const basePrompt = antiRepeatBlock ? `${prompt}\n\n${antiRepeatBlock}` : prompt;

  let rawResponse = null;
  let content = null;
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    const retryBlock = attempt > 1
      ? `\n\nRETRY CONSTRAINTS:\n- The previous draft was invalid or too similar to a recent event.\n- Use a different title.\n- Use a different opening sentence.\n- If ACTIVE arc exists: Continue the story and conflict that was in the final stages of the background knowledge.`
      : "";

    try {
      rawResponse = await callLLMJson(
        {
          model,
          messages: [
            { role: "system", content: message },
            { role: "user", content: `${basePrompt}${retryBlock}` }
          ]
        },
        CARD_SCHEMA
      );
      content = rawResponse?.choices?.[0]?.message?.content || rawResponse?.choices?.[0]?.text;
      const parsed = parseStrictJson(content);
      const card = normalizeCard(parsed);
      const validation = validateCard(card);
      if (!validation.ok) {
        lastError = new Error("Card failed validation");
        continue;
      }

      const duplicateCheck = isNearDuplicateCard(card, recentCards);
      if (duplicateCheck.duplicate) {
        lastError = new Error(duplicateCheck.reason);
        continue;
      }

      return { card, validation, raw: content, rawResponse };
    } catch (err) {
      lastError = err;
    }
  }

  const fallback = buildFallbackCard(prompt, { attempt: Math.max(1, maxAttempts) });
  const validation = validateCard(fallback);
  return { card: fallback, validation, raw: content, rawResponse, error: lastError ? String(lastError.message || lastError) : null };
}

async function generateKing(prompt, { model = process.env.MODEL_ID || "arcee-ai/trinity-large-preview:free", systemPrompt } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("generateKing requires a non-empty prompt");
  }

  const message = systemPrompt || `ROLE: You are a medieval history expert and narrative designer. Generate a unique king with name, age (14-90), and origin story. Return only valid JSON.`;

  const rawResponse = await callLLMJson(
    {
      model,
      messages: [
        { role: "system", content: message },
        { role: "user", content: prompt }
      ]
    },
    KING_SCHEMA
  );

  const content = rawResponse?.choices?.[0]?.message?.content || rawResponse?.choices?.[0]?.text;
  const king = parseStrictJson(content);
  const validation = validateKing(king);

  return { king, validation, raw: content, rawResponse };
}

module.exports = { 
  generateCard, 
  generateKing
};
