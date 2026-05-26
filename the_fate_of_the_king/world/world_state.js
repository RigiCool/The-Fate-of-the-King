function nowISO() {
  return new Date().toISOString();
}

function createInitialWorldState(king) {
  return {
    version: 3,
    updatedAt: nowISO(),
    turn: 0,
    king: { name: king.name, age: king.age },
    memory: {
      lastEventSummary: "",
      lastChoiceSummary: "",
      recentThemes: [],
      lastArc: null // { title, kind, status, endedTurn }
    },
    constraints: {
      tone: "dark medieval",
      noModern: true
    }
  };
}

function summarizeCard(card) {
  const t = (card?.title || "").trim();
  const d = (card?.description || "").trim();
  const shortD = d.length > 180 ? d.slice(0, 177) + "..." : d;
  return `${t}: ${shortD}`.trim();
}

function applyChoiceToMemory(worldState, card, choiceIndex, theme) {
  const w = { ...worldState };
  w.turn = (w.turn || 0) + 1;
  w.updatedAt = nowISO();

  const choiceText = card?.choices?.[choiceIndex]?.text || "";

  w.memory = w.memory || {};
  w.memory.lastEventSummary = summarizeCard(card);
  w.memory.lastChoiceSummary = String(choiceText).trim().slice(0, 200);

  const prev = Array.isArray(w.memory.recentThemes) ? w.memory.recentThemes : [];
  w.memory.recentThemes = [theme, ...prev].filter(Boolean).slice(0, 6);

  return w;
}

function compressWorldForPrompt(worldRow, activeArcRow, factsRows) {
  const memory = worldRow?.memory || {};
  const facts = Array.isArray(factsRows) ? factsRows : [];

  const compactFacts = facts.slice(-8).map(f => ({
    text: f.text,
    tags: safeJsonParse(f.tags_json, []),
    createdTurn: f.created_turn
  }));

  const arc = activeArcRow
    ? {
        title: activeArcRow.title,
        kind: activeArcRow.kind,
        phase: activeArcRow.phase,
        tension: activeArcRow.tension,
        stage: activeArcRow.stage,
        expiresTurn: activeArcRow.expires_turn
      }
    : null;

  return {
    turn: worldRow?.turn ?? 0,
    memory: {
      lastEventSummary: memory.lastEventSummary || "",
      lastChoiceSummary: memory.lastChoiceSummary || "",
      recentThemes: memory.recentThemes || [],
      lastArc: memory.lastArc || null
    },
    facts: compactFacts,
    arc,
    constraints: worldRow?.constraints || {}
  };
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

module.exports = {
  createInitialWorldState,
  applyChoiceToMemory,
  compressWorldForPrompt
};