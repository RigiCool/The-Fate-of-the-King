// --------------------------------- //
// ---------- Arc Manager ---------- //
// --------------------------------- //


// ---------------------------------------------------------- //
// ---------- Clamp and random utilities functions ---------- //
// ---------------------------------------------------------- //
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function clampInt(n, a, b) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}



// ----------------------------------- //
// ---------- Arc Constants ---------- //
// ----------------------------------- //
const ALLOWED_KINDS = new Set(["rebellion", "war", "famine", "plague", "church", "intrigue", "succession", "trade"]);
const ALLOWED_METRICS = new Set(["army", "economy", "loyalty", "diplomacy"]);

const ARC_LEN_MIN = 3;
const ARC_LEN_MAX = 6;
const ARC_GAP_MIN = 3;
const ARC_GAP_MAX = 4;



// ---------------------------------------------- //
// ---------- Arc Management Functions ---------- //
// ---------------------------------------------- //

// Plan next arc start turn and maintain arc length history
function ensureArcCadenceMemory(mem) {
  const m = mem || {};
  if (m.nextArcStartTurn === undefined || m.nextArcStartTurn === null) {
    m.nextArcStartTurn = 3;
  }
  if (!Array.isArray(m.arcLengthHistory)) m.arcLengthHistory = [];
  if (m.pendingNextArcGap === undefined) m.pendingNextArcGap = null;
  return m;
}



// Get the next arc gap
function getArcGap() {
  return randInt(ARC_GAP_MIN, ARC_GAP_MAX);
}



// Get the next arc length based on history
function getArcLengthFromHistory(lengthHistory) {
  const weights = { 3: 4, 4: 4, 5: 3, 6: 2 };

  const hist = Array.isArray(lengthHistory) ? lengthHistory.slice(-6) : [];
  const count3 = hist.filter(x => x === 3).length;
  const count6 = hist.filter(x => x === 6).length;

  if (count3 >= 3) { weights[6] += 4; weights[5] += 2; }
  if (count6 >= 2) { weights[3] += 3; weights[4] += 2; }
  if (hist.length === 0) weights[4] += 2;

  const items = Object.entries(weights).map(([k, w]) => [parseInt(k, 10), Math.max(0, w)]);
  const sum = items.reduce((acc, [, w]) => acc + w, 0) || 1;
  let r = Math.random() * sum;
  for (const [len, w] of items) {
    r -= w;
    if (r <= 0) return len;
  }
  return 4;
}



// Arc start availability validation
function isArcStartEligible({ memory, currentTurn }) {
  const m = ensureArcCadenceMemory(memory);
  const t = Number(currentTurn || 0);
  const next = Number(m.nextArcStartTurn || 0);
  return t >= next;
}



// Schedule the next arc start turn
function enforceArcSeedTurns(seed, length) {
  const s = seed && typeof seed === "object" ? { ...seed } : {};
  s.expectedTurns = clampInt(length, ARC_LEN_MIN, ARC_LEN_MAX);
  return s;
}



// Get the prompt hint for long arc stakes
function getLongArcStakesHint(stakes) {
  const base = String(stakes || "").trim();
  const addon =
    "Long Arc (6 turns): Follow a chain of clues/suspects or search for a hiding place/treasure." +
    "Each turn must reveal a new fragment of truth (key, witness, map, cipher, discovered artifact).";
  if (!base) return addon;
  if (base.length > 120) return base;
  return `${base} ${addon}`.trim();
}



// Normalize and validate an arc seed object
function normalizeArcSeed(seed) {
  if (!seed || typeof seed !== "object") return null;

  const title = String(seed.title || "").trim();
  const kind = String(seed.kind || "").trim();
  const expectedTurns = parseInt(seed.expectedTurns, 10);
  const triggerMetric = String(seed.triggerMetric || "").trim();
  const stakes = seed.stakes != null ? String(seed.stakes).trim() : "";

  if (!title) return null;
  if (!ALLOWED_KINDS.has(kind)) return null;
  if (!ALLOWED_METRICS.has(triggerMetric)) return null;

  return {
    title: title.length > 80 ? title.slice(0, 77) + "..." : title,
    kind,
    expectedTurns: clamp(Number.isFinite(expectedTurns) ? expectedTurns : 4, 2, 8),
    triggerMetric,
    stakes: stakes.length > 160 ? stakes.slice(0, 157) + "..." : stakes
  };
}



// Determine the lowest metric and king for arc direction
function getLowestMetric(metrics) {
  const entries = Object.entries(metrics).filter(([k]) => ALLOWED_METRICS.has(k));
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0]?.[0] || "loyalty";
}



// Get the narrative outcome text for an arc based on kind and resolution status
function getKindByMetric(metric) {
  switch (metric) {
    case "loyalty": return "rebellion";
    case "diplomacy": return "war";
    case "economy": return "famine";
    case "army": return "war";
    default: return "intrigue";
  }
}



// Get a default arc seed based on current lowest metric
function getDefaultArcSeed(metrics) {
  const triggerMetric = getLowestMetric(metrics);
  const kind = getKindByMetric(triggerMetric);

  const titleByKind = {
    rebellion: "Whispers of the Barons",
    war: "Flames Upon the Border",
    famine: "The Empty Granaries",
    plague: "The Black Cough",
    church: "Wrath of the Cathedral",
    intrigue: "Shadows at Court",
    succession: "The Question of Heirship",
    trade: "The Shattered Trade Routes"
  };

  return {
    title: titleByKind[kind] || "The Gathering Storm",
    kind,
    expectedTurns: 4,
    triggerMetric,
    stakes: "The stakes are rising. The realm demands resolve."
  };
}



// Get the narrative outcome text for an arc based on kind and resolution status
function getArcOutcome(kind, status, triggerMetric) {
  const resolved = status === "resolved";

  const map = {
    rebellion: resolved
      ? "The rebellious lords have been subdued; the court stands calm, for now."
      : "The rebellion spreads: nobles waver in loyalty, and the provinces boil with unrest.",

    war: resolved
      ? "The frontier is secured; the enemy withdraws, and uneasy peace returns."
      : "Defeat or prolonged war has drained the treasury and broken the spirits of the people.",

    famine: resolved
      ? "The granaries are replenished; bread reaches the villages, and prices steady."
      : "Hunger deepens; beggars crowd the gates, and crime rises in desperation.",

    plague: resolved
      ? "Quarantine and discipline prevailed; the pestilence wanes."
      : "The sickness lingers; workshops fall silent and fear grips the markets.",

    church: resolved
      ? "A compromise is reached; the Cathedral grants its blessing to the Crown."
      : "The Cathedral condemns the throne; faith turns against royal authority.",

    intrigue: resolved
      ? "The conspiracy is unveiled; the guilty stand punished, and the court grows wary."
      : "Intrigue triumphs; trust dissolves and alliances begin to fracture.",

    succession: resolved
      ? "The matter of succession is settled; the royal house stands strengthened."
      : "The claim to the throne divides the court; rival heirs gather support.",

    trade: resolved
      ? "Caravans return to the roads; duties and coin flow once more into the treasury."
      : "The trade routes remain broken; scarcity and rising prices erode loyalty."
  };

  const base = map[kind] || (resolved
    ? "The crisis has been contained."
    : "The crisis has worsened.");

  return `${base} (Key factor: ${triggerMetric})`;
}



// Create a new active arc object from a seed and current turn
function createActiveArcFromSeed(seed, turn) {
  return {
    title: seed.title,
    kind: seed.kind,
    trigger_metric: seed.triggerMetric,
    stakes: seed.stakes || "",
    status: "active",
    phase: "start",
    stage: 0,
    tension: 10,
    created_turn: turn,
    expires_turn: turn + seed.expectedTurns,
    ended_turn: null,
    outcome_text: ""
  };
}



// Arc progression logic based on player choice effects, current metrics, and turn to increase arc narrative tension
function advanceArcRow(arcRow, effects, metrics, currentTurn) {
  if (!arcRow || arcRow.status !== "active") return arcRow;

  const arc = { ...arcRow };

  const neg =
    clamp(-(effects.army || 0), 0, 20) +
    clamp(-(effects.economy || 0), 0, 20) +
    clamp(-(effects.diplomacy || 0), 0, 20) +
    clamp(-(effects.loyalty || 0), 0, 20);

  const pos =
    clamp((effects.army || 0), 0, 20) +
    clamp((effects.economy || 0), 0, 20) +
    clamp((effects.diplomacy || 0), 0, 20) +
    clamp((effects.loyalty || 0), 0, 20);

  arc.tension = clamp((arc.tension || 10) + Math.round(neg * 1.4) - Math.round(pos * 0.8), 0, 100);

  if (arc.tension >= 40 && arc.stage < 1) arc.stage = 1;
  if (arc.tension >= 65 && arc.stage < 2) arc.stage = 2;
  if (arc.tension >= 85 && arc.stage < 3) arc.stage = 3;

  arc.phase = arc.stage >= 2 ? "climax" : "start";

  if (arc.tension >= 97) {
    arc.status = "failed";
  }

  if (arc.status === "active" && currentTurn >= arc.expires_turn) {
    const m = metrics?.[arc.trigger_metric];
    const okMetric = Number.isFinite(m) ? m >= 140 : false;
    arc.status = okMetric && arc.tension <= 55 ? "resolved" : "failed";
  }

  if (arc.status === "active" && arc.stage >= 3 && arc.tension <= 20) {
    arc.status = "resolved";
  }

  if (arc.status !== "active") {
    arc.phase = "end";
    arc.ended_turn = currentTurn;
    arc.outcome_text = getArcOutcome(arc.kind, arc.status, arc.trigger_metric);
  }

  return arc;
}

module.exports = {
  normalizeArcSeed,
  getDefaultArcSeed,
  createActiveArcFromSeed,
  advanceArcRow,

  clamp,
  clampInt,
  randInt,
  getLowestMetric,
  getKindByMetric,
  getArcOutcome,

  ARC_LEN_MIN,
  ARC_LEN_MAX,
  ARC_GAP_MIN,
  ARC_GAP_MAX,
  ensureArcCadenceMemory,
  getArcGap,
  getArcLengthFromHistory,
  isArcStartEligible,
  enforceArcSeedTurns,
  getLongArcStakesHint
};