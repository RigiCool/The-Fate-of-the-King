require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");

const { CARD_SCHEMA } = require("./schema/card_schema.js");
const { KING_SCHEMA } = require("./schema/king_schema.js");

const { makeValidator, parseStrictJson, normalizeCard } = require("./validator/index.js");
const { buildPlannerPacket } = require("./planner/index.js");
const { createInitialWorldState, applyChoiceToMemory, compressWorldForPrompt } = require("./world/world_state.js");
const { normalizeArcSeed, defaultArcSeed, createActiveArcFromSeed, advanceArcRow } = require("./world/arc_manager.js");

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_ID = process.env.MODEL_ID || "google/gemma-3-27b-it:free";

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

-- world state: small, no facts/arcs inside
CREATE TABLE IF NOT EXISTS world_state (
  king_id INTEGER PRIMARY KEY,
  turn INTEGER NOT NULL DEFAULT 0,
  memory_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

-- facts normalized
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  king_id INTEGER NOT NULL,
  created_turn INTEGER NOT NULL,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.75,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

-- arcs normalized (we keep history; at most one active)
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

-- only one active arc per king (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_arcs_one_active
ON arcs(king_id) WHERE status = 'active';

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
`);

function ensureEventsColumns() {
  const cols = db.prepare(`PRAGMA table_info(events)`).all().map(r => r.name);
  const need = [
    { name: "chosen_index", sql: `ALTER TABLE events ADD COLUMN chosen_index INTEGER` },
    { name: "effects_json", sql: `ALTER TABLE events ADD COLUMN effects_json TEXT` },
    { name: "summary", sql: `ALTER TABLE events ADD COLUMN summary TEXT` }
  ];
  for (const c of need) {
    if (!cols.includes(c.name)) db.exec(c.sql);
  }
}
ensureEventsColumns();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isRetryable(err) {
  const msg = String(err?.message || "");
  return msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("429") || msg.includes("Provider returned error");
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
      { role: "user", content: `Return ONLY valid JSON. No markdown. Must match schema:\n${JSON.stringify(schemaObj.schema, null, 2)}` }
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
    ON CONFLICT(king_id) DO UPDATE SET turn=excluded.turn, memory_json=excluded.memory_json, constraints_json=excluded.constraints_json, updated_at=CURRENT_TIMESTAMP
  `).run(
    kingId,
    worldObj.turn ?? 0,
    JSON.stringify(worldObj.memory || {}),
    JSON.stringify(worldObj.constraints || {})
  );
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function getActiveArc(kingId) {
  return db.prepare(`SELECT * FROM arcs WHERE king_id=? AND status='active' LIMIT 1`).get(kingId) || null;
}

function getRecentFacts(kingId, limit = 12) {
  return db.prepare(`SELECT * FROM facts WHERE king_id=? ORDER BY created_turn ASC, id ASC LIMIT ?`).all(kingId, limit);
}

function insertEvent({ kingId, turn, card }) {
  db.prepare(`
    INSERT INTO events (king_id, turn, card_json, chosen_index, effects_json, summary, created_at)
    VALUES (?, ?, ?, NULL, NULL, '', CURRENT_TIMESTAMP)
  `).run(kingId, turn, JSON.stringify(card));
}

function updateEventChoice({ kingId, turn, choiceIndex, effects, summary }) {
  db.prepare(`
    UPDATE events SET chosen_index=?, effects_json=?, summary=?
    WHERE king_id=? AND turn=?
  `).run(choiceIndex, JSON.stringify(effects), summary || "", kingId, turn);
}

function maybeInsertFact({ kingId, turn, text, tags = [], confidence = 0.75 }) {
  const t = String(text || "").trim();
  if (!t) return;

  db.prepare(`
    INSERT INTO facts (king_id, created_turn, text, tags_json, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(kingId, turn, t, JSON.stringify(tags), confidence);


  db.prepare(`
    DELETE FROM facts
    WHERE id IN (
      SELECT id FROM facts WHERE king_id=? ORDER BY created_turn ASC, id ASC LIMIT
      (SELECT MAX(COUNT(*) - 60, 0) FROM facts WHERE king_id=?)
    )
  `).run(kingId, kingId);
}

function finalizeArcIfEnded(kingId, worldRow) {

  return worldRow;
}



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
    saveWorldRow(kingId, { turn: ws.turn, memory: ws.memory, constraints: ws.constraints });

    res.json({
      id: kingId,
      ...nk,
      metrics: { army: 150, economy: 150, diplomacy: 150, loyalty: 150 }
    });
  } catch (err) {
    console.warn("Ошибка генерации короля:", err.message);
    res.status(500).json({ error: "Не удалось создать короля" });
  }
});

app.post("/get-card", async (req, res) => {
  try {
    const { kingId } = req.body || {};
    if (!kingId) return res.status(400).json({ error: "Нужен kingId" });

    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "Метрики не найдены" });

    let worldRow = getWorldRow(kingId);
    if (!worldRow) {

      saveWorldRow(kingId, { turn: 0, memory: { recentThemes: [] }, constraints: { tone: "dark medieval", noModern: true } });
      worldRow = getWorldRow(kingId);
    }

    const activeArc = getActiveArc(kingId);
    const facts = getRecentFacts(kingId, 16);

    const planner = buildPlannerPacket(metrics, worldRow, activeArc, facts);
    const worldForPrompt = compressWorldForPrompt(worldRow, activeArc, facts);

    const prompt = `
Game: The Fate of the King (medieval, grounded, dark tone).
Hard constraints:
- NO modern tech, NO guns, NO electricity, NO internet, NO cars.
- Avoid repeating the exact same scenario.

Current metrics (0..300):
${JSON.stringify(metrics, null, 2)}

Planner packet:
${JSON.stringify(planner, null, 2)}

World (compressed):
${JSON.stringify(worldForPrompt, null, 2)}

Task:
Generate ONE event card with 2 choices, each meaningful with trade-offs.
Effects must be integers in range [-20..20].

Arc seed rule:
- If there is NO active arc (world.arc is null), you MAY include an "arc" object in the card to propose a new arc seed.
- If there IS an active arc, you may omit "arc" or keep it minimal.

Return ONLY JSON matching the schema.
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

    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: "Пустой ответ LLM" });

    let card = normalizeCard(parseStrictJson(content));
    const v = validateCard(card);
    if (!v.ok) return res.status(500).json({ error: "Карточка не прошла валидацию", details: v.errors });

    const imgLabel = `Image generation ${kingId} ${Date.now()}`;
    console.time(imgLabel);
    try {
      card.image = await generateImage(`${card.title}. Medieval illustration, dark, dramatic, cinematic.`);
    } finally {
      console.timeEnd(imgLabel);
    }


    const nextTurn = (worldRow.turn ?? 0) + 1;
    insertEvent({ kingId, turn: nextTurn, card });

    res.json({ ...card, turn: nextTurn, planner });
    } catch (err) {
      console.error("Ошибка генерации карточки:", err?.message);
      console.error(err?.stack);

      res.status(500).json({
        error: "Не удалось сгенерировать карточку",
        details: String(err?.message || err).slice(0, 1500)
      });
    }

});

app.post("/apply-choice", (req, res) => {
  const { kingId, effects, choiceIndex, card, theme } = req.body || {};
  if (!kingId || !effects) return res.status(400).json({ error: "Нужны kingId и effects" });

  try {
    const metrics = getMetrics(kingId);
    if (!metrics) return res.status(404).json({ error: "Метрики не найдены" });

    const updated = {
      army: clampMetric(metrics.army + (effects.army || 0)),
      economy: clampMetric(metrics.economy + (effects.economy || 0)),
      diplomacy: clampMetric(metrics.diplomacy + (effects.diplomacy || 0)),
      loyalty: clampMetric(metrics.loyalty + (effects.loyalty || 0))
    };

    db.prepare(`UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`).run(
      updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId
    );

    let worldRow = getWorldRow(kingId);
    if (!worldRow) return res.status(500).json({ error: "world_state не найден" });

    const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
    if (!(card && (ci === 0 || ci === 1))) return res.status(400).json({ error: "Нужны card и choiceIndex 0/1" });


    const mergedWorld = applyChoiceToMemory(worldRow, card, ci, theme);
    saveWorldRow(kingId, { turn: mergedWorld.turn, memory: mergedWorld.memory, constraints: worldRow.constraints });


    const impact =
      Math.abs(effects.army || 0) +
      Math.abs(effects.economy || 0) +
      Math.abs(effects.diplomacy || 0) +
      Math.abs(effects.loyalty || 0);

    if (impact >= 25) {
      maybeInsertFact({
        kingId,
        turn: mergedWorld.turn,
        text: `Решение: "${card.choices?.[ci]?.text || ""}"`,
        tags: [theme || "event"],
        confidence: 0.75
      });
    }


    let activeArc = getActiveArc(kingId);
    if (activeArc) {
      const advanced = advanceArcRow(activeArc, effects, updated, mergedWorld.turn);

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
        const newWorld = getWorldRow(kingId);
        newWorld.memory = newWorld.memory || {};
        newWorld.memory.lastArc = {
          title: advanced.title,
          kind: advanced.kind,
          status: advanced.status,
          endedTurn: advanced.ended_turn,
          outcome: advanced.outcome_text
        };
        saveWorldRow(kingId, { turn: newWorld.turn, memory: newWorld.memory, constraints: newWorld.constraints });
      }
    }


    activeArc = getActiveArc(kingId);
    if (!activeArc) {
      const seed = normalizeArcSeed(card.arc) || defaultArcSeed(updated);
      const newArc = createActiveArcFromSeed(seed, mergedWorld.turn);

   
      const currentWorld = getWorldRow(kingId);
      const lastArc = currentWorld?.memory?.lastArc;
      const sameKey = lastArc &&
        String(lastArc.title).toLowerCase().trim() === String(newArc.title).toLowerCase().trim() &&
        String(lastArc.kind).toLowerCase().trim() === String(newArc.kind).toLowerCase().trim();

      const cooldownOk = !lastArc || !Number.isInteger(lastArc.endedTurn) || (mergedWorld.turn - lastArc.endedTurn) >= 2;

      if (!sameKey && cooldownOk) {
        db.prepare(`
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
      }
    }

    updateEventChoice({
      kingId,
      turn: mergedWorld.turn,
      choiceIndex: ci,
      effects,
      summary: `Choice: ${String(card.choices?.[ci]?.text || "").slice(0, 200)}`
    });

    res.json({ ...updated });
  } catch (err) {
    console.error("Ошибка apply-choice:", err.message);
    res.status(500).json({
      error: "Не удалось применить выбор",
      details: String(err?.message || err).slice(0, 1500)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
