// --------------------------------- //
// ---------- World State ---------- //
// --------------------------------- //



function nowISO() {
  return new Date().toISOString();
}



// Create the initial world state for a new king, with default values and constraints
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



// Trim and summarize a card's title and description for world state memory
function summarizeCard(card) {
  const t = (card?.title || "").trim();
  const d = (card?.description || "").trim();
  const shortD = d.length > 180 ? d.slice(0, 177) + "..." : d;
  return `${t}: ${shortD}`.trim();
}



// Get recent event summary for world state memory
function applyChoiceToMemory(worldState, card, choiceIndex, theme) {
  const world = { ...worldState };
  world.turn = (world.turn || 0) + 1;
  world.updatedAt = nowISO();

  const choiceText = card?.choices?.[choiceIndex]?.text || "";

  world.memory = world.memory || {};
  world.memory.lastEventSummary = summarizeCard(card);
  world.memory.lastChoiceSummary = String(choiceText).trim().slice(0, 220);

  const prev = Array.isArray(world.memory.recentThemes) ? world.memory.recentThemes : [];
  world.memory.recentThemes = [theme, ...prev].filter(Boolean).slice(0, 6);

  return world;
}

module.exports = {
  createInitialWorldState,
  applyChoiceToMemory,
  summarizeCard
};