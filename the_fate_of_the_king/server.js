require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");

const { CARD_SCHEMA } = require("./schema/card_schema.js");
const { KING_SCHEMA } = require("./schema/king_schema.js");
const { makeValidator, parseStrictJson, normalizeCard } = require("./validator/index.js");

const {
  buildPlannerPacket,
  retrieveKnowledgeFTS,
  mergeRetrieved,
  selectAnchors,
  buildRetrievalQuery
} = require("./planner/index.js");

const { createInitialWorldState, applyChoiceToMemory } = require("./world/world_state.js");
const {
  normalizeArcSeed,
  defaultArcSeed,
  createActiveArcFromSeed,
  advanceArcRow,

  ARC_LEN_MIN,
  ARC_LEN_MAX,
  ensureArcCadenceMemory,
  pickArcGap,
  pickArcLengthFromHistory,
  isArcStartEligible,
  enforceArcSeedTurns,
  longArcStakesHint
} = require("./world/arc_manager.js");

const {
  hashPassword,
  verifyPassword,
  signToken,
  authRequired,
  adminRequired
} = require("./auth.js");

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_ID = process.env.MODEL_ID || "arcee-ai/trinity-large-preview:free";

const db = new Database("./game.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT,
  age INTEGER,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reign_ended INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
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

function ensureKingsUserIdColumn() {
  const cols = db.prepare(`PRAGMA table_info(kings)`).all().map(r => r.name);
  if (!cols.includes("user_id")) {
    db.exec(`ALTER TABLE kings ADD COLUMN user_id INTEGER`);
  }
}
ensureKingsUserIdColumn();

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

async function callLLMJson(body, schemaObj) {
  const useSchema = schemaObj
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

function getRecentKingsForUser(userId, limit = 5) {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.description, ws.turn
    FROM kings k
    LEFT JOIN world_state ws ON ws.king_id = k.id
    WHERE k.user_id = ?
    ORDER BY k.id DESC
    LIMIT ?
  `).all(userId, limit);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: String(r.description || "").slice(0, 180),
    turn: r.turn ?? 0
  }));
}

function buildDynastyMemoryBlock(kings) {
  if (!kings.length) return "No previous kings.";

  return kings.map((k, i) => {
    return `${i + 1}. King ${k.name} (reign length: ${k.turn} turns) — ${k.description}`;
  }).join("\n");
}

function getKingRow(kingId) {
  return db.prepare(`SELECT id, user_id, name, age, description, created_at FROM kings WHERE id=?`).get(kingId) || null;
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
    SELECT turn, card_json
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
    text: `King's decision (${title || "event"}): ${choiceText}`
  });
}

function insertImpactFacts({ kingId, turn, theme, effects }) {
  const deltas = [
    ["army", effects?.army || 0, "army"],
    ["economy", effects?.economy || 0, "economy"],
    ["diplomacy", effects?.diplomacy || 0, "diplomacy"],
    ["loyalty", effects?.loyalty || 0, "loyalty"]
  ];
  for (const [k, d, label] of deltas) {
    if (Math.abs(d) >= 10) {
      const sign = d > 0 ? "increased" : "decreased";
      maybeInsertFact({
        kingId,
        turn,
        tags: [theme || "event", k, "impact"],
        text: `Decision consequence: ${label} significantly ${sign} (Δ${k}=${d}).`
      });
    }
  }
}

function checkGameOver(metrics) {
  if (metrics.army <= 0) return { type: "army", text: "The army has collapsed. The realm is defenseless." };
  if (metrics.economy <= 0) return { type: "economy", text: "The treasury is empty. The kingdom falls into ruin." };
  if (metrics.diplomacy <= 0) return { type: "diplomacy", text: "All alliances are broken. Enemies surround the throne." };
  if (metrics.loyalty <= 0) return { type: "loyalty", text: "The people have turned against their king." };
  return null;
}

function requireKingAccess(req, res, next) {
  const kingId = Number(req.params.kingId || req.body?.kingId);
  if (!Number.isFinite(kingId)) return res.status(400).json({ error: "Bad kingId" });

  const king = getKingRow(kingId);
  if (!king) return res.status(404).json({ error: "King not found" });

  if (req.user?.role === "admin") {
    req.king = king;
    return next();
  }

  if (king.user_id !== req.user.id) {
    return res.status(403).json({ error: "No access to this king" });
  }

  req.king = king;
  next();
}

app.post("/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "");

    if (!e || !p || p.length < 6) {
      return res.status(400).json({ error: "Email and password are required (password must be at least 6 characters)" });
    }

    const exists = db.prepare(`SELECT id FROM users WHERE email=?`).get(e);
    if (exists) return res.status(409).json({ error: "Email is already registered" });

    const passwordHash = await hashPassword(p);
    const info = db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'user')`).run(e, passwordHash);

    const user = { id: info.lastInsertRowid, email: e, role: "user" };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: "register failed", details: String(err?.message || err).slice(0, 1000) });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const e = String(email || "").trim().toLowerCase();
    const p = String(password || "");

    const u = db.prepare(`SELECT id, email, password_hash, role FROM users WHERE email=?`).get(e);
    if (!u) return res.status(401).json({ error: "Invalid email or password" });

    const ok = await verifyPassword(p, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid login or password" });

    const user = { id: u.id, email: u.email, role: u.role };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: "login failed", details: String(err?.message || err).slice(0, 1000) });
  }
});

app.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get("/kings", authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.age, k.created_at, k.reign_ended,
           ws.turn AS turn
    FROM kings k
    LEFT JOIN world_state ws ON ws.king_id = k.id
    WHERE k.user_id = ?
    ORDER BY k.id DESC
  `).all(req.user.id);

  const out = rows.map(r => {
    const activeArc = db.prepare(`SELECT title, status, phase FROM arcs WHERE king_id=? AND status='active' LIMIT 1`).get(r.id);
    const lastOutcome = db.prepare(`
      SELECT text, turn
      FROM knowledge
      WHERE king_id=? AND kind='arc_outcome'
      ORDER BY id DESC
      LIMIT 1
    `).get(r.id);

    return {
      kingId: r.id,
      name: r.name,
      age: r.age,
      createdAt: r.created_at,
      turn: r.turn ?? 0,
      reign_ended: r.reign_ended ?? 0,
      activeArc: activeArc ? { title: activeArc.title, status: activeArc.status, phase: activeArc.phase } : null,
      lastArcOutcome: lastOutcome ? { turn: lastOutcome.turn, text: lastOutcome.text } : null
    };
  });

  res.json({ kings: out });
});

app.get("/kings/:kingId", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);

  const king = getKingRow(kingId);
  if (!king) return res.status(404).json({ error: "Король не найден" });

  const metrics = getMetrics(kingId);
  const ws = getWorldRow(kingId);

  res.json({
    id: king.id,
    name: king.name,
    age: king.age,
    description: king.description,
    createdAt: king.created_at,
    metrics: metrics || { army: 150, economy: 150, diplomacy: 150, loyalty: 150 },
    turn: ws?.turn ?? 0
  });
});

app.get("/kings/:kingId/history", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);
  const king = req.king;

  const lastEvents = db.prepare(`
    SELECT turn, card_json, chosen_index
    FROM events
    WHERE king_id=? AND chosen_index IS NOT NULL
    ORDER BY turn DESC
    LIMIT 12
  `).all(kingId).map(r => {
    const card = safeJsonParse(r.card_json, null);
    return {
      turn: r.turn,
      title: String(card?.title || ""),
      choiceIndex: r.chosen_index,
      choiceText: String(card?.choices?.[r.chosen_index]?.text || "")
    };
  });

  const arcOutcomes = db.prepare(`
    SELECT turn, text
    FROM knowledge
    WHERE king_id=? AND kind='arc_outcome'
    ORDER BY id DESC
    LIMIT 10
  `).all(kingId);

  res.json({
    king: { id: king.id, name: king.name, age: king.age, description: king.description, createdAt: king.created_at },
    lastEvents,
    arcOutcomes
  });
});

app.post("/kings/start", authRequired, async (req, res) => {
  try {

    const recentKings = getRecentKingsForUser(req.user.id, 5);
    const dynastyMemory = buildDynastyMemoryBlock(recentKings);

    const king_system_prompt = `
ROLE: You are a professional dark medieval narrative designer.

DESIGN RULES:
- Grounded medieval setting. No modern tech.
- Maintain internal world consistency.
- Avoid trivial flavor events
- Avoid repetition of previously used structures.
- The new king must feel historically distinct.
- Description 4 of 10
- Temperature 1
Return ONLY valid JSON.
    `.trim()

    const king_prompt = `
RECENT KINGS (recent rulers):
${dynastyMemory}

TASK:
Create a NEW king for the next reign.

REQUIREMENTS:
- The name must be structurally and phonetically distinct from previous kings.
- The path to power must NOT mirror previous reigns.
- Avoid repeating rebellions, church dominance, heirless death, or civil war if already used.
- The story must feel politically grounded and organic.

Return fields:
- name
- age (number)
- description (short origin story)
      `.trim()

    const data = await callLLMJson(
      {
        model: MODEL_ID,
        messages: [
          {
            role: "system",
            content: king_system_prompt
          },
          {
            role: "user",
            content: king_prompt
          }
        ]
      },
      KING_SCHEMA
    );

    console.log(king_prompt)

    const content = data.choices?.[0]?.message?.content;
    const king = parseStrictJson(content);

    if (!king) {
      return res.status(500).json({ error: "Failed to create king: Invalid JSON" });
    }

    const nk = {
      name: String(king.name || "").trim(),
      age: parseInt(king.age, 10),
      description: String(king.description || "").trim()
    };

    const v = validateKing(nk);
    if (!v.ok) {
      return res.status(500).json({ error: "King failed validation", details: v.errors });
    }

    const result = db.prepare(`
      INSERT INTO kings (user_id, name, age, description)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, nk.name, nk.age, nk.description);

    const kingId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO metrics (king_id, army, economy, diplomacy, loyalty)
      VALUES (?, 150, 150, 150, 150)
    `).run(kingId);

    const ws = createInitialWorldState(nk);
    ws.memory = ensureArcCadenceMemory(ws.memory || {});
    ws.memory.kingName = nk.name;
    ws.memory.finalePendingTurn = null;
    ws.memory.lastFinaleArcId = null;
    ws.memory.lastFinaleKey = null;
    if (ws.memory.pendingArcResolution === undefined)
      ws.memory.pendingArcResolution = null;

    saveWorldRow(kingId, {
      turn: ws.turn,
      memory: ws.memory,
      constraints: ws.constraints
    });

    insertKnowledge({
      kingId,
      kind: "fact",
      turn: 0,
      tags: ["king", "origin"],
      text: `King ${nk.name}: ${nk.description}`
    });

    res.json({
      id: kingId,
      ...nk,
      metrics: { army: 150, economy: 150, diplomacy: 150, loyalty: 150 }
    });

  } catch (err) {
    res.status(500).json({
      error: "Failed to create king",
      details: String(err?.message || err).slice(0, 1200)
    });
  }
});

app.post("/kings/:kingId/get-card", authRequired, requireKingAccess, async (req, res) => {
  try {
    const kingId = Number(req.params.kingId);

    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "No metrics found" });

    const kingRow = getKingRow(kingId);
    const kingName = kingRow?.name ? String(kingRow.name) : "";

    let worldRow = getWorldRow(kingId);

    const isGameOver = worldRow?.memory?.gameOver || false;

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
      return res.json({ ...existingCard, turn: nextTurn, planner: { reused: true } });
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

    const arcStartEligible = !activeArc && !isFinale &&
      isArcStartEligible({ memory: worldRow.memory, currentTurn: nextTurn });

    let recentSummaries = [];
    let recentBlock = "- (none)";
    if (!activeArc && !isFinale) {
      recentSummaries = getRecentEventSummaries(kingId, 4);
      recentBlock = recentSummaries.length ? recentSummaries.join("\n") : "- (none)";
    }

    let retrieved = [];
    if (isFinale) {
      const coreQuery = `tags:king OR tags:origin`;
      const titlePart = String(pending?.title || "").replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
      const situationalQuery = ["tags:arc", "tags:outcome", "tags:start", "tags:event", titlePart].filter(Boolean).join(" OR ");

      const core = retrieveKnowledgeFTS(db, { kingId, query: coreQuery, topK: 3 });
      const situational = retrieveKnowledgeFTS(db, { kingId, query: situationalQuery, topK: 16 });
      retrieved = mergeRetrieved(core, situational, 16);
    } else {
      const coreQuery = `tags:king OR tags:origin OR tags:arc OR tags:fact OR tags:decision`;
      const situationalQuery = buildRetrievalQuery({ kingName, metrics, planner, worldRow, activeArc });

      const core = retrieveKnowledgeFTS(db, { kingId, query: coreQuery, topK: 6 });
      const situational = retrieveKnowledgeFTS(db, { kingId, query: situationalQuery, topK: 14 });
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
      arcPacing = { totalTurns, progressTurns, remainingTurns, isLongArc: totalTurns >= 6 };
    }

    const directive = isFinale
      ? { mode: "arc_resolution", arc: pending, note: "EPILOGUE: Must explicitly close the arc. No new conflict. No new arc seed. Choices ceremonial (zero effects)." }
      : { mode: "normal", theme: planner.theme, intent: planner.intent, arcDirective: planner.arcDirective, arcStartEligible };

    const finaleChoiceA = "Accept the outcome and continue the reign.";
    const finaleChoiceB = "Secure the outcome and continue the reign.";

    const antiRepeatSection = (!activeArc && !isFinale)
      ? `Anti-repeat (DO NOT repeat these recent situations):\n${recentBlock}\n`
      : "";

    
    let gameOverSection = "";
    let prompt = "";

    if (isGameOver) {
      gameOverSection = `
GAME OVER STATE:
Game Over Reason: ${worldRow.memory?.gameOverReason || "Unknown"}
`
      prompt = `
GAME: The Fate of the King
${gameOverSection}

METRICS (0..300, higher is better):
${JSON.stringify(metrics)}

BACKGROUND KNOWLEDGE:
${anchors}

TASK:
- Generate final tragic epilogue narrative.
- No new conflicts.
- Close story emotionally and historically.
- Choices must be ceremonial only.

OUTPUT: 
- ONLY Valid JSON matching schema.
`.trim();

    }
    else{
      prompt = `
GAME: The Fate of the King
${gameOverSection}
METRICS (0..300, higher is better):
${JSON.stringify(metrics)}

DIRECTIVE:
${JSON.stringify(directive)}

ACTIVE ARC PACING:
${JSON.stringify(arcPacing)}

ANTI-REPETITION RULES:
${antiRepeatSection}

BACKGROUND KNOWLEDGE:
${anchors}



TASK:
Generate ONE event card with:
- title
- description
- 2 choices
- each choice has:
    - text
    - effects (integer changes -20..20)

MODE RULES:
- If ACTIVE arc exists: escalate or reveal new development.
- If NO active arc:
    - If arcStartEligible=false: generate standalone side quest.
    - If arcStartEligible=true: you MAY include "arc" seed.

LONG ARC RULE (totalTurns >= 6):
- Include investigation, mystery, hidden motive, suspect, or treasure trail progression.
`.trim();
    }
    const system_prompt = `
ROLE: You are a professional dark medieval narrative designer.

DESIGN RULES:
- Grounded medieval setting. No modern tech.
- Maintain internal world consistency.
- Create tension and meaningful trade-offs.
- Avoid trivial flavor events
- Avoid repetition of previously used structures.
- Ensure narrative forward motion.
- Escalate active arcs.
- Description 4 of 10
- Temperature 1

MULTI-STEP INTERNAL REASONING (do internally, do NOT reveal):
1. Identify current world pressure (political, economic, religious, military, personal).
2. Connect it to active arc or world state.
3. Create escalating development.
4. Design 2 asymmetric choices.

MODE RULES:
- Long arcs (>=6 turns): include investigation or clue progression.
- Effects: integers [-20..20].
- Tone: dark, medieval, politically and morally complex.
- Output: ONLY Valid JSON matching schema.
`.trim();  

    const label = `LLM generation king=${kingId} turn=${nextTurn} ${Date.now()}`;
    console.time(label);

    let data;
    try {
      data = await callLLMJson(
        {
          model: MODEL_ID,
          messages: [
            { role: "system", content: system_prompt },
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
    if (!content) return res.status(500).json({ error: "Empty LLM response" });

    let card = normalizeCard(parseStrictJson(content));

    if (isFinale) {
      const t = String(card.title || "").trim();
      if (!/^Epilogue:|^Finale:/i.test(t)) {
        card.title = `Epilogue: ${t || (pending?.title ? pending.title : "Finale of the arc")}`.slice(0, 120);
      }

      card.choices = [
        { text: finaleChoiceA, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
        { text: finaleChoiceB, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
      ];

      if (card.arc) delete card.arc;

      const d = String(card.description || "").trim();
      const has1 = d.includes("Arc concluded:");
      const has2 = d.includes("Price:");
      const has3 = d.includes("Now:");
      if (!(has1 && has2 && has3)) {
        const outcome = String(pending?.outcome || "").trim();
        const patch = [
          has1 ? null : `Arc concluded: ${outcome || "the crisis had a clear resolution."}`,
          has2 ? null : `Price: the decision left a mark on the people and treasury.`,
          has3 ? null : `Now: the king continues to rule in a new order of things.`
        ].filter(Boolean).join("\n");
        card.description = `${d}\n\n${patch}`.trim().slice(0, 800);
      }
    } else {
      if (!arcStartEligible && card.arc) delete card.arc;
    }

    const gameOverChoice = "Finish your reign and retire.";

    if (isGameOver) {
      card.choices = [
        { text: gameOverChoice, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } },
        { text: gameOverChoice, effects: { army: 0, economy: 0, loyalty: 0, diplomacy: 0 } }
      ];
    }

    const vv = validateCard(card);
    if (!vv.ok) return res.status(500).json({ error: "Card failed validation", details: vv.errors });

    try {
      card.image = await generateImage(`${card.title}. Medieval illustration, dark, dramatic, cinematic.`);
    } catch {
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
      planner: { theme: planner.theme, intent: planner.intent, mode: directive.mode, arcStartEligible }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate card", details: String(err?.message || err).slice(0, 1400) });
  }
});

app.post("/kings/:kingId/apply-choice", authRequired, requireKingAccess, (req, res) => {
  const kingId = Number(req.params.kingId);
  const { effects, choiceIndex, card, theme } = req.body || {};

  if (!effects) return res.status(400).json({ error: "Need effects" });

  try {
    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "No metrics found" });

    let worldRow = getWorldRow(kingId);
    if (!worldRow) return res.status(500).json({ error: "world_state not found" });

    worldRow.memory = ensureArcCadenceMemory(worldRow.memory || {});

    const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
    if (!(card && (ci === 0 || ci === 1))) return res.status(400).json({ error: "Need card and choiceIndex 0/1" });

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

    db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`)
      .run(updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId);

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
        `Turn ${mergedWorld.turn}. ${String(card.title || "").trim()} — ${String(card.description || "").trim().slice(0, 220)}. ` +
        `Choice: "${String(card.choices?.[ci]?.text || "").trim().slice(0, 200)}".`
    });

    if (!isFinaleChoice) {
      insertDecisionFactAlways({ kingId, turn: mergedWorld.turn, theme, card, choiceIndex: ci });
      insertImpactFacts({ kingId, turn: mergedWorld.turn, theme, effects: eff });
    }

    const gameOver = checkGameOver(updated);

    if (gameOver) {

      const finalTurn = mergedWorld.turn;

      db.prepare(`
        UPDATE kings
        SET reign_ended = 1
        WHERE id = ?
      `).run(kingId);

      const activeArc = getActiveArc(kingId);
      if (activeArc) {
        db.prepare(`
          UPDATE arcs
          SET status='failed',
              phase='end',
              ended_turn=?,
              outcome_text=?,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(finalTurn, gameOver.text, activeArc.id);
      }

      mergedWorld.memory.gameOver = true;
      mergedWorld.memory.gameOverReason = gameOver.text;
      mergedWorld.memory.gameOverTurn = finalTurn;

      saveWorldRow(kingId, {
        turn: finalTurn,
        memory: mergedWorld.memory,
        constraints: worldRow.constraints
      });

      insertKnowledge({
        kingId,
        kind: "fact",
        turn: finalTurn,
        tags: ["game_over"],
        text: `Game Over: ${gameOver.text}`
      });

      return res.json({
        ...updated,
        gameOver: true
      });
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

        w2.memory.arcLengthHistory = [...(w2.memory.arcLengthHistory || []), arcLen].slice(-10);

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
          text: `Resolved arc "${advanced.title}": ${advanced.outcome_text}`
        });
      }
    }

    activeArc = getActiveArc(kingId);
    const eligibleNow = !activeArc && !isFinaleChoice &&
      isArcStartEligible({ memory: mergedWorld.memory, currentTurn: mergedWorld.turn });

    if (!activeArc && !isFinaleChoice && eligibleNow) {
      const wNow = getWorldRow(kingId);
      wNow.memory = ensureArcCadenceMemory(wNow.memory || {});
      const lastArc = wNow?.memory?.lastArc || null;

      const rawSeed = normalizeArcSeed(card.arc) || defaultArcSeed(updated);
      const pickedLen = pickArcLengthFromHistory(wNow.memory.arcLengthHistory);
      const seed = enforceArcSeedTurns(rawSeed, pickedLen);

      if (pickedLen >= 6) seed.stakes = longArcStakesHint(seed.stakes);

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
          text: `Started arc "${newArc.title}" (${newArc.kind}, ${pickedLen} turns). Stakes: ${newArc.stakes}`
        });

        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      } else {
        mergedWorld.memory.nextArcStartTurn = (mergedWorld.turn ?? 0) + 3;
        saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to apply choice", details: String(err?.message || err).slice(0, 1400) });
  }
});


app.patch("/admin/kings/:kingId/metrics", authRequired, adminRequired, (req, res) => {
  console.log("Test")
  const kingId = Number(req.params.kingId);
  if (!Number.isFinite(kingId)) return res.status(400).json({ error: "Bad kingId" });

  const { army, economy, diplomacy, loyalty } = req.body || {};
  const current = getMetrics(kingId);
  if (!current) return res.status(404).json({ error: "No metrics found" });

  const updated = {
    army: clampMetric(army ?? current.army),
    economy: clampMetric(economy ?? current.economy),
    diplomacy: clampMetric(diplomacy ?? current.diplomacy),
    loyalty: clampMetric(loyalty ?? current.loyalty)
  };

  db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`)
    .run(updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId);

  res.json({ ok: true, kingId, metrics: updated });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));