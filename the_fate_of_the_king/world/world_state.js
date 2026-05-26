function nowISO() {
  return new Date().toISOString();
}

function createInitialWorldState(king) {
  return {
    version: 1,
    updatedAt: nowISO(),
    turn: 0,
    king: {
      name: king.name,
      age: king.age
    },
    facts: [

    ],
    arcs: [

    ],
    memory: {
      lastEventSummary: "",
      lastChoiceSummary: "",
      recentThemes: []
    },
    constraints: {
      tone: "dark medieval",
      noModern: true
    }
  };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function summarizeCard(card) {
  const t = (card?.title || "").trim();
  const d = (card?.description || "").trim();
  const shortD = d.length > 180 ? d.slice(0, 177) + "..." : d;
  return `${t}: ${shortD}`.trim();
}


function applyChoiceToWorld(world, card, choiceIndex, effects, theme) {
  const w = { ...world };
  w.turn = (w.turn || 0) + 1;
  w.updatedAt = nowISO();

  const choiceText = card?.choices?.[choiceIndex]?.text || "";


  w.memory = w.memory || {};
  w.memory.lastEventSummary = summarizeCard(card);
  w.memory.lastChoiceSummary = choiceText.trim().slice(0, 200);


  const prev = Array.isArray(w.memory.recentThemes) ? w.memory.recentThemes : [];
  const nextThemes = [theme, ...prev].filter(Boolean).slice(0, 5);
  w.memory.recentThemes = nextThemes;


  w.facts = Array.isArray(w.facts) ? w.facts : [];
  const impact =
    Math.abs(effects.army || 0) +
    Math.abs(effects.economy || 0) +
    Math.abs(effects.diplomacy || 0) +
    Math.abs(effects.loyalty || 0);

  if (impact >= 25) {
    w.facts.push({
      id: `fact_turn_${w.turn}`,
      text: `Существенное решение принято: "${choiceText}".`,
      tags: [theme || "event"],
      confidence: 0.75,
      createdTurn: w.turn
    });
  }


  w.arcs = Array.isArray(w.arcs) ? w.arcs : [];
  const active = w.arcs.find(a => a.status === "active");
  if (active) {
    const neg =
      clamp(-(effects.army || 0), 0, 20) +
      clamp(-(effects.economy || 0), 0, 20) +
      clamp(-(effects.diplomacy || 0), 0, 20) +
      clamp(-(effects.loyalty || 0), 0, 20);

    active.tension = clamp((active.tension || 0) + Math.round(neg * 1.5), 0, 100);
    if (active.tension >= 70 && (active.stage ?? 0) < 3) active.stage = (active.stage ?? 0) + 1;


    if (active.stage >= 3 && active.tension <= 20) {
      active.status = "resolved";
    }
  }

  return w;
}


function compressWorldForPrompt(world) {
  if (!world) return null;

  const facts = Array.isArray(world.facts) ? world.facts : [];
  const arcs = Array.isArray(world.arcs) ? world.arcs : [];
  const lastFacts = facts.slice(-8).map(f => ({
    text: f.text,
    tags: f.tags || [],
    createdTurn: f.createdTurn
  }));
  const activeArcs = arcs
    .filter(a => a.status === "active")
    .slice(0, 3)
    .map(a => ({
      id: a.id,
      title: a.title,
      stage: a.stage,
      tension: a.tension
    }));

  return {
    turn: world.turn,
    memory: {
      lastEventSummary: world.memory?.lastEventSummary || "",
      lastChoiceSummary: world.memory?.lastChoiceSummary || "",
      recentThemes: world.memory?.recentThemes || []
    },
    facts: lastFacts,
    arcs: activeArcs,
    constraints: world.constraints || {}
  };
}

module.exports = {
  createInitialWorldState,
  applyChoiceToWorld,
  compressWorldForPrompt
};