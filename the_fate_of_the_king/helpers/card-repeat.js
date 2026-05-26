// ----------------------------------------- //
// ---------- Card repeat helpers ---------- //
// ----------------------------------------- //



// --------------------------------------- //
// ---------- Utility functions ---------- //
// --------------------------------------- //
function normalizeRepeatText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/["'`]+/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}



function tokenize(text) {
  return normalizeRepeatText(text)
    .split(" ")
    .filter((token) => token.length >= 3);
}



function uniqueTokens(text) {
  return new Set(tokenize(text));
}



function jaccardSimilarity(left, right) {
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = new Set([...left, ...right]).size || 1;
  return intersection / union;
}

// ------------------------------- //
// ---------- Functions ---------- //
// ------------------------------- //

// Convert a card to a normalized shape for comparison
function toCardShape(card) {
  const title = String(card?.title || "").trim();
  const description = String(card?.description || "").trim();

  return {
    title,
    description,
    titleNorm: normalizeRepeatText(title),
    descriptionNorm: normalizeRepeatText(description),
    descriptionLead: normalizeRepeatText(description).slice(0, 220),
    descriptionTokens: uniqueTokens(description)
  };
}



// Search recent cards for near-duplicates based on title and description similarity
function isNearDuplicateCard(card, recentCards, { minDescriptionSimilarity = 0.62 } = {}) {
  const candidate = toCardShape(card);
  const recent = Array.isArray(recentCards) ? recentCards : [];

  if (!candidate.titleNorm && !candidate.descriptionNorm) {
    return { duplicate: false, reason: null, matchedCard: null };
  }

  for (const priorRaw of recent) {
    const prior = toCardShape(priorRaw);
    const sameTitle = candidate.titleNorm && candidate.titleNorm === prior.titleNorm;
    const sameDescription = candidate.descriptionNorm && candidate.descriptionNorm === prior.descriptionNorm;
    const sameLead = candidate.descriptionLead && candidate.descriptionLead === prior.descriptionLead;
    const descriptionSimilarity = jaccardSimilarity(candidate.descriptionTokens, prior.descriptionTokens);

    if (sameTitle && (sameDescription || sameLead || descriptionSimilarity >= minDescriptionSimilarity)) {
      return {
        duplicate: true,
        reason: `Repeated recent event: ${prior.title || "untitled"}`,
        matchedCard: priorRaw,
        descriptionSimilarity
      };
    }

    if (sameDescription && descriptionSimilarity >= minDescriptionSimilarity) {
      return {
        duplicate: true,
        reason: `Repeated recent event description: ${prior.title || "untitled"}`,
        matchedCard: priorRaw,
        descriptionSimilarity
      };
    }
  }

  return { duplicate: false, reason: null, matchedCard: null };
}



// Generate an additional list of recent cards for the LLM to avoid repeatition
function buildRepeatAvoidanceBlock(recentCards, { limit = 8 } = {}) {
  const recent = (Array.isArray(recentCards) ? recentCards : [])
    .slice(0, limit)
    .map((card) => {
      const title = String(card?.title || "").trim() || "(untitled)";
      const description = String(card?.description || "").trim();
      const snippet = description.length > 180 ? `${description.slice(0, 177)}...` : description;
      return `- ${title}${snippet ? ` :: ${snippet}` : ""}`;
    });
  console.log("Recent cards for anti-repeat block:");
  if (!recent.length) return "";

  return [
    "ANTI-REPEAT HARD CONSTRAINTS:",
    "- Do not reuse any recent title.",
    "- Do not restate the same opening situation or core dilemma.",
    "- Change the central actors, stakes, and first sentence",
    "- Continue the story and conflict that was in the final stages of the background knowledge.",
    "Recent cards to avoid:",
    ...recent
  ].join("\n");
}



// Generate a fallback card when the LLM fail
function buildFallbackCard(prompt, { attempt = 1 } = {}) {
  const normalizedPrompt = normalizeRepeatText(prompt).slice(0, 120);
  const promptHint = normalizedPrompt ? ` Prompt focus: ${normalizedPrompt}.` : "";

  return {
    title: "Fallback Card",
    description: `The LLM failed to generate a card. This is a fallback.${promptHint} Recovery attempt ${attempt}.`,
    choices: [
      { text: "Option 1", effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
      { text: "Option 2", effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
    ]
  };
}

module.exports = {
  normalizeRepeatText,
  isNearDuplicateCard,
  buildRepeatAvoidanceBlock,
  buildFallbackCard
};