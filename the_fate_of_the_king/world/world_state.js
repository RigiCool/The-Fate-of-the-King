function nowISO() {
  return new Date().toISOString();
}

function createInitialWorldState(king) {
  return {
    version: 4,
    updatedAt: nowISO(),
    turn: 0,
    king: { name: king.name, age: king.age },
    memory: {
      lastEventSummary: "",
      lastChoiceSummary: "",
      recentThemes: [],
      lastArc: null,
      pendingArcResolution: null
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
  w.memory.lastChoiceSummary = String(choiceText).trim().slice(0, 220);

  const prev = Array.isArray(w.memory.recentThemes) ? w.memory.recentThemes : [];
  w.memory.recentThemes = [theme, ...prev].filter(Boolean).slice(0, 6);

  return w;
}

module.exports = {
  createInitialWorldState,
  applyChoiceToMemory
};