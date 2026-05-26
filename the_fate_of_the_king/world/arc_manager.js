function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

const ALLOWED_KINDS = new Set(["rebellion", "war", "famine", "plague", "church", "intrigue", "succession", "trade"]);
const ALLOWED_METRICS = new Set(["army", "economy", "loyalty", "diplomacy"]);

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

function pickLowestMetric(metrics) {
  const entries = Object.entries(metrics).filter(([k]) => ALLOWED_METRICS.has(k));
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0]?.[0] || "loyalty";
}

function kindByMetric(metric) {
  switch (metric) {
    case "loyalty": return "rebellion";
    case "diplomacy": return "war";
    case "economy": return "famine";
    case "army": return "war";
    default: return "intrigue";
  }
}

function defaultArcSeed(metrics) {
  const triggerMetric = pickLowestMetric(metrics);
  const kind = kindByMetric(triggerMetric);

  const titleByKind = {
    rebellion: "Шёпот баронов",
    war: "Пограничное пламя",
    famine: "Пустые амбары",
    plague: "Чёрный кашель",
    church: "Гнев кафедры",
    intrigue: "Тени при дворе",
    succession: "Спор о наследии",
    trade: "Разрыв торговых путей"
  };

  return {
    title: titleByKind[kind] || "Надвигающаяся буря",
    kind,
    expectedTurns: 4,
    triggerMetric,
    stakes: "Ставки растут. Королевству нужна решимость."
  };
}

function arcOutcome(kind, status, triggerMetric) {

  const ok = status === "resolved";

  const map = {
    rebellion: ok
      ? "Вожаки недовольных усмирены, двор временно спокоен."
      : "Бунт разгорелся: часть знати отступилась, провинции кипят.",
    war: ok
      ? "Граница укреплена: враг отступил, переговоры принесли передышку."
      : "Поражение или затяжной конфликт истощили людей и казну.",
    famine: ok
      ? "Запасы восстановлены: хлеб пошёл в деревни, цены стабилизировались."
      : "Голод усилился: бродяги у городских стен, растёт преступность.",
    plague: ok
      ? "Карантин и меры помогли: вспышка затухает."
      : "Мор не отступил: ремесло встало, страх парализует рынки.",
    church: ok
      ? "Достигнут компромисс: кафедра благословляет власть."
      : "Кафедра осудила двор: влияние церкви подрывает легитимность.",
    intrigue: ok
      ? "Заговор раскрыт: виновные наказаны, двор присмирел."
      : "Интриги победили: доверие исчезает, союзники сомневаются.",
    succession: ok
      ? "Вопрос наследия временно решён: дом короля укрепился."
      : "Спор о наследии расколол двор: претенденты набирают силу.",
    trade: ok
      ? "Караваны снова идут: пошлины и товар оживили казну."
      : "Пути перекрыты: дефицит и рост цен бьют по лояльности."
  };

  const base = map[kind] || (ok ? "Кризис улажен." : "Кризис обострился.");
  return `${base} (ключевой фактор: ${triggerMetric})`;
}

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
    arc.outcome_text = arcOutcome(arc.kind, arc.status, arc.trigger_metric);
  }

  return arc;
}

module.exports = {
  normalizeArcSeed,
  defaultArcSeed,
  createActiveArcFromSeed,
  advanceArcRow
};