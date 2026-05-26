require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");

const { CARD_SCHEMA } = require("./schema/card_schema.js");
const { KING_SCHEMA } = require("./schema/king_schema.js");

const { makeValidator, parseStrictJson, normalizeCard } = require("./validator/index.js");
const { buildPlannerPacket } = require("./planner/index.js");
const { createInitialWorldState, applyChoiceToMemory } = require("./world/world_state.js");
const {
  normalizeArcSeed,
  defaultArcSeed,
  createActiveArcFromSeed,
  advanceArcRow
} = require("./world/arc_manager.js");

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_ID = process.env.MODEL_ID || "arcee-ai/trinity-large-preview:free";

const db = new Database("./game.db");

db.exec(`
CREATE TABLE IF NOT EXISTS kings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  age INTEGER,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  king_id INTEGER,
  army INTEGER DEFAULT 150,
  economy INTEGER DEFAULT 150,
  diplomacy INTEGER DEFAULT 150,
  loyalty INTEGER DEFAULT 150,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

CREATE TABLE IF NOT EXISTS world_state (
  king_id INTEGER PRIMARY KEY,
  turn INTEGER NOT NULL DEFAULT 0,
  memory_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

CREATE TABLE IF NOT EXISTS arcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  king_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  trigger_metric TEXT NOT NULL,
  stakes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,      -- active | resolved | failed
  phase TEXT NOT NULL,       -- start | climax | end
  stage INTEGER NOT NULL DEFAULT 0,
  tension INTEGER NOT NULL DEFAULT 10,
  created_turn INTEGER NOT NULL,
  expires_turn INTEGER NOT NULL,
  ended_turn INTEGER,
  outcome_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_arcs_one_active
ON arcs(king_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  king_id INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  chosen_index INTEGER,
  effects_json TEXT,
  summary TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_one_per_turn
ON events(king_id, turn);

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  king_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- fact | event | arc_outcome
  ref_table TEXT,
  ref_id INTEGER,
  turn INTEGER NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  text,
  tags,
  king_id UNINDEXED,
  turn UNINDEXED,
  content=''
);
`);

function ensureEventsColumns() {
  const cols = db.prepare(`PRAGMA table_info(events)`).all().map(r => r.name);
  const need = [
    { name: "chosen_index", sql: `ALTER TABLE events ADD COLUMN chosen_index INTEGER` },
    { name: "effects_json", sql: `ALTER TABLE events ADD COLUMN effects_json TEXT` },
    { name: "summary", sql: `ALTER TABLE events ADD COLUMN summary TEXT` }
  ];
  for (const c of need) if (!cols.includes(c.name)) db.exec(c.sql);
}
ensureEventsColumns();

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
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

async function callOpenRouterWithRetry(body, { retries = 2, baseDelayMs = 400 } = {}) {
  let last = null;
  for (let a = 0; a <= retries; a++) {
    try { return await callOpenRouter(body); }
    catch (e) {
      last = e;
      if (!isRetryable(e) || a === retries) break;
      await sleep(baseDelayMs * Math.pow(2, a));
    }
  }
  throw last;
}

function modelSupportsJsonSchema(modelId) {
  const m = String(modelId || "").toLowerCase();
  if (m.includes("gemma-3-27b-it")) return false;
  return true;
}

async function callLLMJson(body, schemaObj) {
  const useSchema = schemaObj && modelSupportsJsonSchema(body.model);
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

async function generateImage(prompt) {
  const url = `https://ai-image-api.xeven.workers.dev/img?prompt=${encodeURIComponent(prompt)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to generate image: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return `data:image/png;base64,${base64}`;
}

const validateKing = makeValidator(KING_SCHEMA.schema);
const validateCard = makeValidator(CARD_SCHEMA.schema);

function clampMetric(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(300, Math.round(n)));
}

function clampInt(n, a, b) {
  const x = parseInt(n, 10);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}


const ARC_LEN_MIN = 3;
const ARC_LEN_MAX = 6;
const ARC_GAP_MIN = 3;
const ARC_GAP_MAX = 8;


function ensureArcCadenceMemory(mem) {
  const m = mem || {};
  if (m.nextArcStartTurn === undefined || m.nextArcStartTurn === null) {
    m.nextArcStartTurn = 3;
  }
  if (!Array.isArray(m.arcLengthHistory)) m.arcLengthHistory = [];
  if (m.pendingNextArcGap === undefined) m.pendingNextArcGap = null;
  return m;
}

function pickArcGap() {
  return randInt(ARC_GAP_MIN, ARC_GAP_MAX);
}

function pickArcLengthFromHistory(lengthHistory) {
  const weights = { 3: 4, 4: 4, 5: 3, 6: 2 };

  const hist = Array.isArray(lengthHistory) ? lengthHistory.slice(-6) : [];
  const count3 = hist.filter(x => x === 3).length;
  const count6 = hist.filter(x => x === 6).length;

  if (count3 >= 3) {
    weights[6] += 4;
    weights[5] += 2;
  }

  if (count6 >= 2) {
    weights[3] += 3;
    weights[4] += 2;
  }

  if (hist.length === 0) {
    weights[4] += 2;
  }

  const items = Object.entries(weights).map(([k, w]) => [parseInt(k, 10), Math.max(0, w)]);
  const sum = items.reduce((acc, [, w]) => acc + w, 0) || 1;
  let r = Math.random() * sum;
  for (const [len, w] of items) {
    r -= w;
    if (r <= 0) return len;
  }
  return 4;
}

function isArcStartEligible({ memory, currentTurn }) {
  const m = ensureArcCadenceMemory(memory);
  const t = Number(currentTurn || 0);
  const next = Number(m.nextArcStartTurn || 0);
  return t >= next;
}

function enforceArcSeedTurns(seed, length) {
  const s = seed && typeof seed === "object" ? { ...seed } : {};
  s.expectedTurns = clampInt(length, ARC_LEN_MIN, ARC_LEN_MAX);
  return s;
}

function longArcStakesHint(stakes, kind) {
  const base = String(stakes || "").trim();
  const addon =
    "Длинная арка (6 ходов): веди цепочку улик/подозреваемых или поиск тайника/клада. " +
    "Каждый ход должен давать новый фрагмент истины (ключ, свидетель, карта, код, найденный предмет).";
  if (!base) return addon;
  if (base.length > 120) return base;
  return `${base} ${addon}`.trim();
}

function getKingRow(kingId) {
  return db.prepare(`SELECT id, name, age, description FROM kings WHERE id=?`).get(kingId) || null;
}

function getMetrics(kingId) {
  return db.prepare(`SELECT army, economy, diplomacy, loyalty FROM metrics WHERE king_id=?`).get(kingId);
}

function getWorldRow(kingId) {
  const row = db.prepare(`SELECT turn, memory_json, constraints_json FROM world_state WHERE king_id=?`).get(kingId);
  if (!row) return null;
  return {
    turn: row.turn,
    memory: safeJsonParse(row.memory_json, {}),
    constraints: safeJsonParse(row.constraints_json, {})
  };
}

function saveWorldRow(kingId, worldObj) {
  db.prepare(`
    INSERT INTO world_state (king_id, turn, memory_json, constraints_json, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(king_id) DO UPDATE SET
      turn=excluded.turn,
      memory_json=excluded.memory_json,
      constraints_json=excluded.constraints_json,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    kingId,
    worldObj.turn ?? 0,
    JSON.stringify(worldObj.memory || {}),
    JSON.stringify(worldObj.constraints || {})
  );
}

function getActiveArc(kingId) {
  return db.prepare(`SELECT * FROM arcs WHERE king_id=? AND status='active' LIMIT 1`).get(kingId) || null;
}

function getEventIdByTurn(kingId, turn) {
  return db.prepare(`SELECT id FROM events WHERE king_id=? AND turn=? LIMIT 1`).get(kingId, turn)?.id ?? null;
}

function getEventCardByTurn(kingId, turn) {
  const row = db.prepare(`SELECT card_json FROM events WHERE king_id=? AND turn=? LIMIT 1`).get(kingId, turn);
  if (!row) return null;
  return safeJsonParse(row.card_json, null);
}

function getRecentEventSummaries(kingId, limit = 4) {
  const rows = db.prepare(`
    SELECT turn, card_json, summary
    FROM events
    WHERE king_id=? AND chosen_index IS NOT NULL
    ORDER BY turn DESC
    LIMIT ?
  `).all(kingId, limit);

  const out = [];
  for (const r of rows) {
    const card = safeJsonParse(r.card_json, null);
    const title = String(card?.title || "").trim();
    const desc = String(card?.description || "").trim();
    const short = desc.length > 140 ? desc.slice(0, 137) + "..." : desc;
    const line = `- (turn ${r.turn}) ${title}${short ? ` — ${short}` : ""}`.trim();
    if (title) out.push(line);
  }
  return out;
}

function insertEvent({ kingId, turn, card }) {
  const existing = getEventIdByTurn(kingId, turn);
  if (existing) return existing;
  const info = db.prepare(`
    INSERT INTO events (king_id, turn, card_json, chosen_index, effects_json, summary, created_at)
    VALUES (?, ?, ?, NULL, NULL, '', CURRENT_TIMESTAMP)
  `).run(kingId, turn, JSON.stringify(card));
  return info.lastInsertRowid;
}

function updateEventChoice({ kingId, turn, choiceIndex, effects, summary }) {
  db.prepare(`
    UPDATE events SET chosen_index=?, effects_json=?, summary=?
    WHERE king_id=? AND turn=?
  `).run(choiceIndex, JSON.stringify(effects), summary || "", kingId, turn);
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const s = String(t || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .trim()
      .replace(/\s+/g, "_");
    if (!s || s.length < 2) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 12);
}

function upsertKnowledgeFTS({ rowid, kingId, turn, text, tags = [] }) {
  const normTags = normalizeTags(tags);
  db.prepare(`
    INSERT OR REPLACE INTO knowledge_fts (rowid, text, tags, king_id, turn)
    VALUES (?, ?, ?, ?, ?)
  `).run(rowid, String(text || ""), normTags.join(" "), kingId, turn);
}

function insertKnowledge({ kingId, kind, refTable = null, refId = null, turn, tags = [], text }) {
  const t = String(text || "").trim();
  if (!t) return null;

  const normTags = normalizeTags(tags);

  const info = db.prepare(`
    INSERT INTO knowledge (king_id, kind, ref_table, ref_id, turn, tags_json, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(kingId, kind, refTable, refId, turn, JSON.stringify(normTags), t);

  const rowid = info.lastInsertRowid;
  upsertKnowledgeFTS({ rowid, kingId, turn, text: t, tags: normTags });
  return rowid;
}

function pruneFacts(kingId, maxFacts = 80) {
  const ids = db.prepare(`
    SELECT id FROM knowledge
    WHERE king_id=? AND kind='fact'
    ORDER BY turn DESC, id DESC
    LIMIT ?
  `).all(kingId, maxFacts).map(r => r.id);

  if (ids.length < maxFacts) return;

  const keepMinId = Math.min(...ids);
  db.prepare(`
    DELETE FROM knowledge
    WHERE king_id=? AND kind='fact' AND id < ?
  `).run(kingId, keepMinId);

  db.prepare(`
    DELETE FROM knowledge_fts
    WHERE rowid IN (
      SELECT f.rowid FROM knowledge_fts f
      LEFT JOIN knowledge k ON k.id=f.rowid
      WHERE k.id IS NULL
    )
  `).run();
}

function maybeInsertFact({ kingId, turn, text, tags = [] }) {
  const t = String(text || "").trim();
  if (!t) return null;

  const exists = db.prepare(`
    SELECT 1 FROM knowledge
    WHERE king_id=? AND kind='fact' AND text=? AND turn >= ?
    LIMIT 1
  `).get(kingId, t, Math.max(0, turn - 6));
  if (exists) return null;

  const rowid = insertKnowledge({
    kingId,
    kind: "fact",
    turn,
    tags: ["fact", ...tags],
    text: t
  });

  pruneFacts(kingId, 80);
  return rowid;
}

function insertDecisionFactAlways({ kingId, turn, theme, card, choiceIndex }) {
  const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
  if (!(card && (ci === 0 || ci === 1))) return;

  const title = String(card.title || "").trim();
  const choiceText = String(card.choices?.[ci]?.text || "").trim();
  if (!choiceText) return;

  maybeInsertFact({
    kingId,
    turn,
    tags: [theme || "event", "decision"],
    text: `Решение короля (${title || "событие"}): ${choiceText}`
  });
}

function insertImpactFacts({ kingId, turn, theme, effects }) {
  const deltas = [
    ["army", effects?.army || 0, "армия"],
    ["economy", effects?.economy || 0, "казна"],
    ["diplomacy", effects?.diplomacy || 0, "дипломатия"],
    ["loyalty", effects?.loyalty || 0, "лояльность"]
  ];
  for (const [k, d, label] of deltas) {
    if (Math.abs(d) >= 10) {
      const sign = d > 0 ? "выросла" : "упала";
      maybeInsertFact({
        kingId,
        turn,
        tags: [theme || "event", k, "impact"],
        text: `Последствие решения: ${label} заметно ${sign} (Δ${k}=${d}).`
      });
    }
  }
}

function retrieveKnowledgeFTS({ kingId, query, topK = 10 }) {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const rows = db.prepare(`
      SELECT
        k.id AS rowid,
        k.text AS text,
        f.tags AS tags,
        k.turn AS turn,
        bm25(knowledge_fts, 1.0, 0.3) AS score
      FROM knowledge_fts f
      JOIN knowledge k ON k.id = f.rowid
      WHERE knowledge_fts MATCH ?
        AND k.king_id = ?
      ORDER BY score ASC
      LIMIT ?
    `).all(q, kingId, topK);

    return rows.map(r => ({
      rowid: r.rowid,
      text: r.text,
      tags: String(r.tags || "").split(" ").filter(Boolean),
      turn: r.turn,
      score: r.score
    }));
  } catch (e) {
    try {
      const fallback = q.split(/\s+OR\s+/).slice(0, 6).join(" ");
      const rows2 = db.prepare(`
        SELECT
          k.id AS rowid,
          k.text AS text,
          f.tags AS tags,
          k.turn AS turn,
          bm25(knowledge_fts, 1.0, 0.3) AS score
        FROM knowledge_fts f
        JOIN knowledge k ON k.id = f.rowid
        WHERE knowledge_fts MATCH ?
          AND k.king_id = ?
        ORDER BY score ASC
        LIMIT ?
      `).all(fallback, kingId, topK);

      return rows2.map(r => ({
        rowid: r.rowid,
        text: r.text,
        tags: String(r.tags || "").split(" ").filter(Boolean),
        turn: r.turn,
        score: r.score
      }));
    } catch {
      return [];
    }
  }
}

function mergeRetrieved(core, situational, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const x of [...(core || []), ...(situational || [])]) {
    const rid = x.rowid ?? "";
    const key = `${rid}|${String(x.text || "").slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

function selectAnchors(retrieved, { isFinale = false } = {}) {
  const list = Array.isArray(retrieved) ? retrieved.slice() : [];
  if (list.length === 0) return [];

  const byFresh = [...list].sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0));
  const byScore = [...list].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const picks = [];
  const seen = new Set();

  const want = isFinale ? 6 : 4;

  function take(arr, n) {
    for (const r of arr) {
      const key = `${r.rowid}|${String(r.text || "").slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(r);
      if (picks.length >= n) break;
    }
  }

  if (isFinale) {
    take(byFresh, Math.min(3, want));
    take(byScore, want);
  } else {
    take(byFresh, 2);
    take(byScore, want);
  }

  return picks.slice(0, want);
}

function buildRetrievalQuery({ kingName, metrics, planner, worldRow, activeArc }) {
  const parts = [];

  if (planner?.intent) parts.push(planner.intent);
  if (planner?.theme) parts.push(planner.theme);

  const mem = worldRow?.memory || {};
  if (mem.lastEventSummary) parts.push(mem.lastEventSummary);
  if (mem.lastChoiceSummary) parts.push(mem.lastChoiceSummary);

  if (kingName) parts.push(kingName);

  if (activeArc?.status === "active") {
    parts.push(activeArc.kind);
    parts.push(activeArc.title);
    if (activeArc.stakes) parts.push(activeArc.stakes);
    if (activeArc.phase) parts.push(activeArc.phase);
    if (activeArc.trigger_metric) parts.push(activeArc.trigger_metric);

    const st = Number(activeArc.stage || 0);
    if (st <= 1) parts.push("rumor", "pressure", "warning");
    else if (st === 2) parts.push("ultimatum", "deadline", "uprising", "siege");
    else parts.push("confrontation", "trial", "battle", "reckoning");
  }

  if (metrics.economy < 120) parts.push("tax", "grain", "debt", "market", "trade");
  if (metrics.loyalty < 120) parts.push("nobles", "riot", "uprising", "oath");
  if (metrics.army < 120) parts.push("garrison", "deserters", "fort", "border");
  if (metrics.diplomacy < 120) parts.push("envoy", "treaty", "hostage", "alliance");

  const tagHints = [];
  if (planner?.theme) {
    const th = String(planner.theme).toLowerCase().replace(/[^\w-]+/g, "");
    if (th) tagHints.push(`tags:${th}`);
  }
  if (activeArc?.kind) {
    const ak = String(activeArc.kind).toLowerCase().replace(/[^\w-]+/g, "");
    if (ak) tagHints.push(`tags:${ak}`);
  }
  tagHints.push("tags:event", "tags:arc", "tags:fact", "tags:decision");

  const uniq = [];
  const seen = new Set();
  for (const p of parts.join(" ").split(/\s+/).filter(Boolean)) {
    const w = p.replace(/[^\p{L}\p{N}_-]+/gu, "").toLowerCase();
    if (!w || w.length < 3) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= 16) break;
  }

  const base = uniq.join(" OR ");
  const tagsPart = tagHints.filter(Boolean).join(" OR ");
  return [tagsPart, base].filter(Boolean).join(" OR ");
}

app.post("/debug/rebuild-fts", (req, res) => {
  try {
    db.exec(`DELETE FROM knowledge_fts;`);

    const rows = db.prepare(`
      SELECT id, king_id, turn, tags_json, text
      FROM knowledge
      ORDER BY id ASC
    `).all();

    const stmt = db.prepare(`
      INSERT INTO knowledge_fts (rowid, text, tags, king_id, turn)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const r of rows) {
        const tags = normalizeTags(safeJsonParse(r.tags_json, []));
        stmt.run(r.id, r.text, tags.join(" "), r.king_id, r.turn);
      }
    });

    tx();
    res.json({ ok: true, rebuilt: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 1000) });
  }
});

app.get("/debug/world/:kingId", (req, res) => {
  const kingId = Number(req.params.kingId);
  if (!Number.isFinite(kingId)) return res.status(400).json({ error: "Bad kingId" });
  const w = getWorldRow(kingId);
  res.json({ kingId, world: w || null });
});

app.post("/start-game", async (req, res) => {
  try {
    const data = await callLLMJson(
      {
        model: MODEL_ID,
        messages: [
          { role: "system", content: "You generate a medieval king for the game. Return ONLY JSON." },
          { role: "user", content: "Create a king: fields name, age (number), description (short story of coming to power)." }
        ]
      },
      KING_SCHEMA
    );

    const content = data.choices?.[0]?.message?.content;
    const king = parseStrictJson(content);
    if (!king) return res.status(500).json({ error: "Не удалось создать короля: неверный JSON" });

    const nk = {
      name: String(king.name || "").trim(),
      age: parseInt(king.age, 10),
      description: String(king.description || "").trim()
    };

    const v = validateKing(nk);
    if (!v.ok) return res.status(500).json({ error: "Король не прошёл валидацию", details: v.errors });

    const result = db.prepare(`INSERT INTO kings (name, age, description) VALUES (?, ?, ?)`).run(nk.name, nk.age, nk.description);
    const kingId = result.lastInsertRowid;

    db.prepare(`INSERT INTO metrics (king_id, army, economy, diplomacy, loyalty) VALUES (?, 150, 150, 150, 150)`).run(kingId);

    const ws = createInitialWorldState(nk);
    ws.memory = ensureArcCadenceMemory(ws.memory || {});
    ws.memory.kingName = nk.name;

    ws.memory.finalePendingTurn = null;
    ws.memory.lastFinaleArcId = null;
    ws.memory.lastFinaleKey = null;

    if (ws.memory.pendingArcResolution === undefined) ws.memory.pendingArcResolution = null;

    saveWorldRow(kingId, { turn: ws.turn, memory: ws.memory, constraints: ws.constraints });

    insertKnowledge({
      kingId,
      kind: "fact",
      turn: 0,
      tags: ["king", "origin"],
      text: `Король ${nk.name}: ${nk.description}`
    });

    res.json({
      id: kingId,
      ...nk,
      metrics: { army: 150, economy: 150, diplomacy: 150, loyalty: 150 }
    });
  } catch (err) {
    console.warn("Ошибка генерации короля:", err.message);
    res.status(500).json({ error: "Не удалось создать короля", details: String(err.message).slice(0, 1200) });
  }
});

app.post("/get-card", async (req, res) => {
  try {
    const { kingId } = req.body || {};
    if (!kingId) return res.status(400).json({ error: "Нужен kingId" });

    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "Метрики не найдены" });

    const kingRow = getKingRow(kingId);
    const kingName = kingRow?.name ? String(kingRow.name) : "";

    let worldRow = getWorldRow(kingId);
    if (!worldRow) {
      const memory = ensureArcCadenceMemory({
        recentThemes: [],
        lastEventSummary: "",
        lastChoiceSummary: "",
        lastArc: null,
        pendingArcResolution: null,
        finalePendingTurn: null,
        lastFinaleArcId: null,
        lastFinaleKey: null,
        kingName
      });

      saveWorldRow(kingId, {
        turn: 0,
        memory,
        constraints: { tone: "dark medieval", noModern: true }
      });
      worldRow = getWorldRow(kingId);
    } else {
      worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});
      if (!worldRow.memory.kingName && kingName) worldRow.memory.kingName = kingName;

      if (worldRow.memory.finalePendingTurn === undefined) worldRow.memory.finalePendingTurn = null;
      if (worldRow.memory.lastFinaleArcId === undefined) worldRow.memory.lastFinaleArcId = null;
      if (worldRow.memory.lastFinaleKey === undefined) worldRow.memory.lastFinaleKey = null;
      if (worldRow.memory.pendingArcResolution && worldRow.memory.pendingArcResolution.arcId === undefined) {
        worldRow.memory.pendingArcResolution.arcId = null;
      }
    }

    const nextTurn = (worldRow.turn ?? 0) + 1;

    const existingCard = getEventCardByTurn(kingId, nextTurn);
    if (existingCard) {
      return res.json({
        ...existingCard,
        turn: nextTurn,
        planner: { reused: true }
      });
    }

    const activeArc = getActiveArc(kingId);
    const planner = buildPlannerPacket(metrics, worldRow, activeArc);

    const pending = worldRow.memory?.pendingArcResolution || null;
    const pendingArcId = pending?.arcId ?? null;
    const lastFinaleArcId = worldRow.memory?.lastFinaleArcId ?? null;

    const pendingKey =
      pending && (pendingArcId == null)
        ? `${String(pending.title || "")}|${String(pending.kind || "")}|${String(pending.outcome || "")}`.slice(0, 220)
        : null;

    const isFinale =
      (!!pending && pendingArcId != null && pendingArcId !== lastFinaleArcId) ||
      (!!pendingKey && worldRow.memory.lastFinaleKey !== pendingKey);

    const arcStartEligible = !activeArc && !isFinale && isArcStartEligible({ memory: worldRow.memory, currentTurn: nextTurn });

    if (!activeArc && !isFinale) {
      recentSummaries = getRecentEventSummaries(kingId, 4);
      recentBlock = recentSummaries.length ? recentSummaries.join("\n") : "- (none)";
    }

    let retrieved = [];
    if (isFinale) {
      const coreQuery = `tags:king OR tags:origin`;
      const titlePart = String(pending?.title || "").replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
      const situationalQuery = [
        "tags:arc",
        "tags:outcome",
        "tags:start",
        "tags:event",
        titlePart ? titlePart : ""
      ].filter(Boolean).join(" OR ");

      const core = retrieveKnowledgeFTS({ kingId, query: coreQuery, topK: 3 });
      const situational = retrieveKnowledgeFTS({ kingId, query: situationalQuery, topK: 16 });
      retrieved = mergeRetrieved(core, situational, 16);
    } else {
      const coreQuery = `tags:king OR tags:origin OR tags:arc OR tags:fact OR tags:decision`;
      const situationalQuery = buildRetrievalQuery({ kingName, metrics, planner, worldRow, activeArc });

      const core = retrieveKnowledgeFTS({ kingId, query: coreQuery, topK: 6 });
      const situational = retrieveKnowledgeFTS({ kingId, query: situationalQuery, topK: 14 });
      retrieved = mergeRetrieved(core, situational, 16);
    }

    const anchorItems = selectAnchors(retrieved, { isFinale });
    const anchors =
      anchorItems.map(r => `- (turn ${r.turn}) ${String(r.text || "").trim()}`).join("\n") || "- (none)";

    let arcPacing = null;
    if (activeArc?.status === "active") {
      const totalTurns = Math.max(1, (activeArc.expires_turn - activeArc.created_turn));
      const progressTurns = Math.max(0, nextTurn - activeArc.created_turn);
      const remainingTurns = Math.max(0, activeArc.expires_turn - nextTurn);

      arcPacing = {
        totalTurns,
        progressTurns,
        remainingTurns,
        isLongArc: totalTurns >= 6
      };
    }

    const directive = isFinale
      ? {
          mode: "arc_resolution",
          arc: pending,
          note: "EPILOGUE: Must explicitly close the arc. No new conflict. No new arc seed. Choices ceremonial (zero effects)."
        }
      : {
          mode: "normal",
          theme: planner.theme,
          intent: planner.intent,
          arcDirective: planner.arcDirective,
          arcStartEligible
        };

    const finaleChoiceA = "Принять итог и продолжить правление";
    const finaleChoiceB = "Закрепить исход и продолжить правление";

    const antiRepeatSection = (!activeArc && !isFinale)
      ? `Anti-repeat (DO NOT repeat these recent situations):\n${recentBlock}\n`
      : "";

    const prompt = `
Game: The Fate of the King (medieval, grounded, dark tone).
Hard constraints:
- NO modern tech, NO guns, NO electricity, NO internet, NO cars.
- Keep names and places consistent with medieval vibe.
- Return ONLY JSON. No markdown.

Metrics (0..300, higher is better):
${JSON.stringify(metrics, null, 2)}

Directive:
${JSON.stringify(directive, null, 2)}

Active arc pacing (if any):
${JSON.stringify(arcPacing, null, 2)}

${antiRepeatSection}

Background knowledge (use at least 2, but do NOT copy verbatim):
${anchors}

Task:
Generate ONE event card with 2 choices.
Each choice must be meaningful trade-off.
Effects must be integers [-20..20].

Mode guidance:
- If there is an ACTIVE arc: advance the arc with new development (not repetition). Escalate or reveal new information.
- If there is NO active arc:
  - If arcStartEligible=false: generate a small standalone "side quest" / quick court matter (merchant, dispute, local issue). It must still reference world facts, but MUST NOT propose a new long arc.
  - If arcStartEligible=true: you MAY propose a new arc seed by including "arc" object, but only if it naturally fits.

Special rule for LONG arcs (totalTurns >= 6):
- Include investigation / mystery / trail of clues or treasure hunt style progression: each arc step reveals a NEW clue, witness, map fragment, coded letter, or hidden stash.

Arc seed rule:
- If arcStartEligible is false, DO NOT include "arc" field.
- If you include arc: expectedTurns should be between 3 and 6.

Return ONLY JSON matching schema.
`.trim();

    const label = `LLM generation ${kingId} ${Date.now()}`;
    console.time(label);

    let data;
    try {
      data = await callLLMJson(
        {
          model: MODEL_ID,
          messages: [
            { role: "system", content: "You are an event card generator. Return ONLY JSON." },
            { role: "user", content: prompt }
          ]
        },
        CARD_SCHEMA
      );
    } finally {
      console.timeEnd(label);
    }
    console.log(prompt);

    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: "Пустой ответ LLM" });

    let card = normalizeCard(parseStrictJson(content));

    if (isFinale) {
      const t = String(card.title || "").trim();
      if (!/^Эпилог:|^Развязка:/i.test(t)) {
        card.title = `Эпилог: ${t || (pending?.title ? pending.title : "Итог арки")}`.slice(0, 120);
      }

      card.choices = [
        { text: finaleChoiceA, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
        { text: finaleChoiceB, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
      ];

      if (card.arc) delete card.arc;

      const d = String(card.description || "").trim();
      const has1 = d.includes("Арка завершилась:");
      const has2 = d.includes("Цена:");
      const has3 = d.includes("Теперь:");
      if (!(has1 && has2 && has3)) {
        const outcome = String(pending?.outcome || "").trim();
        const patch = [
          has1 ? null : `Арка завершилась: ${outcome || "кризис получил ясный исход."}`,
          has2 ? null : `Цена: решение оставило след в людях и казне.`,
          has3 ? null : `Теперь: король продолжает правление в новом порядке вещей.`
        ].filter(Boolean).join("\n");
        card.description = `${d}\n\n${patch}`.trim().slice(0, 800);
      }
    } else {

      if (!arcStartEligible && card.arc) {
        delete card.arc;
      }
    }

    const vv = validateCard(card);
    if (!vv.ok) return res.status(500).json({ error: "Карточка не прошла валидацию", details: vv.errors });

    try {
      card.image = await generateImage(`${card.title}. Medieval illustration, dark, dramatic, cinematic.`);
    } catch (e) {
      console.warn("Image generation failed:", String(e.message).slice(0, 160));
      card.image = null;
    }

    insertEvent({ kingId, turn: nextTurn, card });

    if (isFinale) {
      const w2 = getWorldRow(kingId);
      w2.memory = ensureArcCadenceMemory(w2.memory || {});
      w2.memory.pendingArcResolution = null;
      w2.memory.finalePendingTurn = nextTurn;

      if (pendingArcId != null) w2.memory.lastFinaleArcId = pendingArcId;
      if (pendingKey) w2.memory.lastFinaleKey = pendingKey;

      saveWorldRow(kingId, { turn: w2.turn, memory: w2.memory, constraints: w2.constraints });
    }

    res.json({
      ...card,
      turn: nextTurn,
      planner: {
        theme: planner.theme,
        intent: planner.intent,
        mode: directive.mode,
        arcStartEligible
      },
      debug: {
        isFinale,
        arcStartEligible,
        nextArcStartTurn: worldRow.memory?.nextArcStartTurn ?? null,
        anchorsCount: anchorItems.length,
        recentCount: recentSummaries.length
      }
    });
  } catch (err) {
    console.warn("Ошибка генерации карточки:", err?.message);
    res.status(500).json({
      error: "Не удалось сгенерировать карточку",
      details: String(err?.message || err).slice(0, 1400)
    });
  }
});

app.post("/apply-choice", (req, res) => {
  const { kingId, effects, choiceIndex, card, theme } = req.body || {};
  if (!kingId || !effects) return res.status(400).json({ error: "Нужны kingId и effects" });

  try {
    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "Метрики не найдены" });

    let worldRow = getWorldRow(kingId);
    if (!worldRow) return res.status(500).json({ error: "world_state не найден" });

    worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});

    const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
    if (!(card && (ci === 0 || ci === 1))) return res.status(400).json({ error: "Нужны card и choiceIndex 0/1" });

    const supposedTurn = (worldRow.turn ?? 0) + 1;
    const isFinaleChoice =
      Number.isInteger(worldRow.memory?.finalePendingTurn) &&
      worldRow.memory.finalePendingTurn === supposedTurn;

    const eff = isFinaleChoice
      ? { army: 0, economy: 0, diplomacy: 0, loyalty: 0 }
      : {
          army: Number(effects.army) || 0,
          economy: Number(effects.economy) || 0,
          diplomacy: Number(effects.diplomacy) || 0,
          loyalty: Number(effects.loyalty) || 0
        };

    const updated = {
      army: clampMetric(metrics.army + (eff.army || 0)),
      economy: clampMetric(metrics.economy + (eff.economy || 0)),
      diplomacy: clampMetric(metrics.diplomacy + (eff.diplomacy || 0)),
      loyalty: clampMetric(metrics.loyalty + (eff.loyalty || 0))
    };

    db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`).run(
      updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId
    );

    const mergedWorld = applyChoiceToMemory(worldRow, card, ci, theme);
    mergedWorld.memory = ensureArcCadenceMemory(mergedWorld.memory || {});

    if (isFinaleChoice) {
      mergedWorld.memory.finalePendingTurn = null;
      mergedWorld.memory.pendingArcResolution = null;

      const gap = Number.isInteger(mergedWorld.memory.pendingNextArcGap)
        ? mergedWorld.memory.pendingNextArcGap
        : pickArcGap();

      mergedWorld.memory.pendingNextArcGap = null;
      mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + gap;
    }

    saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });

    updateEventChoice({
      kingId,
      turn: mergedWorld.turn,
      choiceIndex: ci,
      effects: eff,
      summary: `Choice: ${String(card.choices?.[ci]?.text || "").slice(0, 240)}`
    });

    const eventId = getEventIdByTurn(kingId, mergedWorld.turn);

    insertKnowledge({
      kingId,
      kind: "event",
      refTable: "events",
      refId: eventId,
      turn: mergedWorld.turn,
      tags: [theme || "event", "event"],
      text:
        `Ход ${mergedWorld.turn}. ${String(card.title || "").trim()} — ${String(card.description || "").trim().slice(0, 220)}. ` +
        `Выбор: "${String(card.choices?.[ci]?.text || "").trim().slice(0, 200)}".`
    });

    if (!isFinaleChoice) {
      insertDecisionFactAlways({ kingId, turn: mergedWorld.turn, theme, card, choiceIndex: ci });
      insertImpactFacts({ kingId, turn: mergedWorld.turn, theme, effects: eff });
    }

    let activeArc = getActiveArc(kingId);
    if (activeArc) {
      const advanced = advanceArcRow(activeArc, eff, updated, mergedWorld.turn);

      db.prepare(`
        UPDATE arcs
        SET status=?, phase=?, stage=?, tension=?, ended_turn=?, outcome_text=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        advanced.status,
        advanced.phase,
        advanced.stage,
        advanced.tension,
        advanced.ended_turn,
        advanced.outcome_text || "",
        activeArc.id
      );

      if (advanced.status !== "active") {

        const arcLen = Math.max(ARC_LEN_MIN, Math.min(ARC_LEN_MAX, (advanced.ended_turn - advanced.created_turn + 1)));

        const w2 = getWorldRow(kingId);
        w2.memory = ensureArcCadenceMemory(w2.memory || {});

        w2.memory.lastArc = {
          title: advanced.title,
          kind: advanced.kind,
          status: advanced.status,
          endedTurn: advanced.ended_turn,
          outcome: advanced.outcome_text,
          length: arcLen
        };

        w2.memory.arcLengthHistory = Array.isArray(w2.memory.arcLengthHistory) ? w2.memory.arcLengthHistory : [];
        w2.memory.arcLengthHistory = [...w2.memory.arcLengthHistory, arcLen].slice(-10);

        w2.memory.pendingArcResolution = {
          arcId: activeArc.id,
          title: advanced.title,
          kind: advanced.kind,
          outcome: advanced.outcome_text
        };

        w2.memory.pendingNextArcGap = pickArcGap();

        saveWorldRow(kingId, { turn: w2.turn, memory: w2.memory, constraints: w2.constraints });

        insertKnowledge({
          kingId,
          kind: "arc_outcome",
          refTable: "arcs",
          refId: activeArc.id,
          turn: mergedWorld.turn,
          tags: ["arc", advanced.kind, "outcome", advanced.status],
          text: `Развязка арки "${advanced.title}": ${advanced.outcome_text}`
        });
      }
    }

    activeArc = getActiveArc(kingId);
    const eligibleNow = !activeArc && !isFinaleChoice && isArcStartEligible({ memory: mergedWorld.memory, currentTurn: mergedWorld.turn });

    if (!activeArc && !isFinaleChoice && eligibleNow) {
      const wNow = getWorldRow(kingId);
      wNow.memory = ensureArcCadenceMemory(wNow.memory || {});
      const lastArc = wNow?.memory?.lastArc || null;

      const rawSeed = normalizeArcSeed(card.arc) || defaultArcSeed(updated);

      const pickedLen = pickArcLengthFromHistory(wNow.memory.arcLengthHistory);

      const seed = enforceArcSeedTurns(rawSeed, pickedLen);

      if (pickedLen >= 6) {
        seed.stakes = longArcStakesHint(seed.stakes, seed.kind);
      }

      const newArc = createActiveArcFromSeed(seed, mergedWorld.turn);

      const sameKey =
        lastArc &&
        String(lastArc.title || "").trim().toLowerCase() === String(newArc.title || "").trim().toLowerCase() &&
        String(lastArc.kind || "").trim().toLowerCase() === String(newArc.kind || "").trim().toLowerCase();

      if (!sameKey) {
        const info = db.prepare(`
          INSERT INTO arcs (
            king_id, title, kind, trigger_metric, stakes,
            status, phase, stage, tension,
            created_turn, expires_turn, ended_turn, outcome_text, updated_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          kingId,
          newArc.title,
          newArc.kind,
          newArc.trigger_metric,
          newArc.stakes,
          newArc.status,
          newArc.phase,
          newArc.stage,
          newArc.tension,
          newArc.created_turn,
          newArc.expires_turn
        );

        mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + 9999;

        const startTags = ["arc", newArc.kind, "start", `len_${pickedLen}`];
        if (pickedLen >= 6) startTags.push("mystery", "investigation", "treasure");

        insertKnowledge({
          kingId,
          kind: "fact",
          refTable: "arcs",
          refId: info.lastInsertRowid,
          turn: mergedWorld.turn,
          tags: startTags,
          text: `Началась арка "${newArc.title}" (${newArc.kind}, ${pickedLen} ходов). Ставки: ${newArc.stakes}`
        });

        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      } else {
        // если совпало — сдвинем окно старта немного, чтобы не зациклиться
        mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + randInt(2, 4);
        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      }
    }

    res.json(updated);
  } catch (err) {
    console.error("Ошибка apply-choice:", err?.message);
    res.status(500).json({
      error: "Не удалось применить выбор",
      details: String(err?.message || err).slice(0, 1400)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
