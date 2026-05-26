const Ajv = require("ajv");

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function extractFirstJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function parseStrictJson(content) {
  if (content == null) return null;
  if (typeof content === "object") return content;

  try {
    return JSON.parse(content);
  } catch {
    const extracted = extractFirstJsonObject(String(content));
    if (!extracted) return null;
    try {
      return JSON.parse(extracted);
    } catch {
      return null;
    }
  }
}

function makeValidator(schema) {
  const validate = ajv.compile(schema);
  return (data) => {
    const ok = validate(data);
    return { ok, errors: validate.errors || [] };
  };
}


function normalizeArcSeedLike(arc) {
  if (!arc || typeof arc !== "object") return undefined;

  const title = String(arc.title ?? "").trim();
  const kind = String(arc.kind ?? "").trim();
  const triggerMetric = String(arc.triggerMetric ?? "").trim();


  const expectedTurnsRaw = arc.expectedTurns;
  const expectedTurns = clamp(parseInt(expectedTurnsRaw, 10) || 4, 2, 8);

  const stakes = arc.stakes != null ? String(arc.stakes).trim() : "";

  if (!title) return undefined;


  return {
    title: title.length > 80 ? title.slice(0, 77) + "..." : title,
    kind,
    expectedTurns,
    triggerMetric,
    stakes: stakes.length > 160 ? stakes.slice(0, 157) + "..." : stakes
  };
}

function normalizeCard(card) {
  if (!card || typeof card !== "object") return card;

  const out = {
    title: String(card.title ?? "").trim(),
    description: String(card.description ?? "").trim(),
    choices: Array.isArray(card.choices) ? card.choices.slice(0, 2) : []
  };

  while (out.choices.length < 2) {
    out.choices.push({ text: "…", effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } });
  }

  out.choices = out.choices.map((c) => {
    const text = String(c?.text ?? "").trim();
    const e = c?.effects || {};
    return {
      text: text || "…",
      effects: {
        army: clamp(Number.isFinite(e.army) ? e.army : parseInt(e.army, 10) || 0, -20, 20),
        economy: clamp(Number.isFinite(e.economy) ? e.economy : parseInt(e.economy, 10) || 0, -20, 20),
        loyalty: clamp(Number.isFinite(e.loyalty) ? e.loyalty : parseInt(e.loyalty, 10) || 0, -20, 20),
        diplomacy: clamp(Number.isFinite(e.diplomacy) ? e.diplomacy : parseInt(e.diplomacy, 10) || 0, -20, 20)
      }
    };
  });

  if (out.title.length > 120) out.title = out.title.slice(0, 117) + "...";
  if (out.description.length > 800) out.description = out.description.slice(0, 797) + "...";
  out.choices = out.choices.map(c => ({
    ...c,
    text: c.text.length > 180 ? c.text.slice(0, 177) + "..." : c.text
  }));


  const arcNorm = normalizeArcSeedLike(card.arc);


  if (arcNorm) out.arc = arcNorm;

  return out;
}

module.exports = {
  makeValidator,
  parseStrictJson,
  normalizeCard
};