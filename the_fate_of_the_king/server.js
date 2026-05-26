require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");

const { CARD_SCHEMA } = require("./schema/card_schema.js");
const { KING_SCHEMA } = require("./schema/king_schema.js");

const { makeValidator, parseStrictJson, normalizeCard } = require("./validator/index.js");
const { buildPlannerPacket } = require("./planner/index.js");
const { createInitialWorldState, applyChoiceToWorld, compressWorldForPrompt } = require("./world/world_state.js");

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

CREATE TABLE IF NOT EXISTS world_state (
  king_id INTEGER PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (king_id) REFERENCES kings(id)
);

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

function nowISO() {
  return new Date().toISOString();
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


function getMetrics(kingId) {
  return db.prepare(`SELECT army, economy, diplomacy, loyalty FROM metrics WHERE king_id = ?`).get(kingId);
}

function getWorldState(kingId) {
  const row = db.prepare(`SELECT state_json FROM world_state WHERE king_id = ?`).get(kingId);
  if (!row) return null;
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

function saveWorldState(kingId, stateObj) {
  const json = JSON.stringify(stateObj);
  db.prepare(`
    INSERT INTO world_state (king_id, state_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(king_id) DO UPDATE SET state_json=excluded.state_json, updated_at=CURRENT_TIMESTAMP
  `).run(kingId, json);
}

function getLastTurn(kingId) {
  const row = db.prepare(`SELECT MAX(turn) as t FROM events WHERE king_id = ?`).get(kingId);
  return row?.t ?? 0;
}

function insertEvent({ kingId, turn, card, chosenIndex = null, effects = null, summary = "" }) {
  db.prepare(`
    INSERT INTO events (king_id, turn, card_json, chosen_index, effects_json, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    kingId,
    turn,
    JSON.stringify(card),
    chosenIndex,
    effects ? JSON.stringify(effects) : null,
    summary
  );
}

function clampMetric(x) {

  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(300, Math.round(n)));
}

async function repairJsonViaLLM({ badJsonText, schema, model }) {
  const data = await callOpenRouter({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a strict JSON repair tool. Fix the user's JSON so it matches the provided JSON Schema. Return ONLY valid JSON. No commentary."
      },
      {
        role: "user",
        content: `JSON Schema:\n${JSON.stringify(schema, null, 2)}\n\nBroken/invalid JSON:\n${String(badJsonText)}`
      }
    ]
  });
  return data.choices?.[0]?.message?.content || null;
}


app.post("/start-game", async (req, res) => {
  try {
    const data = await callOpenRouter({
      model: MODEL_ID,
      messages: [
        {
          role: "system",
          content:
            "You are a king generator for the game 'The Fate of the King'. Medieval setting. No modern references. Return ONLY JSON matching the schema."
        },
        { role: "user", content: "Create a king: fields name, age (number), description (short story of coming to power)." }
      ],
      response_format: { type: "json_schema", json_schema: KING_SCHEMA }
    });

    const content = data.choices?.[0]?.message?.content;
    const king = parseStrictJson(content);

    if (!king) return res.status(500).json({ error: "Не удалось создать короля: неверный JSON" });

    const nk = {
      name: String(king.name || "").trim(),
      age: parseInt(king.age, 10),
      description: String(king.description || "").trim()
    };

    const v = validateKing(nk);
    if (!v.ok) {
      return res.status(500).json({ error: "Король не прошёл валидацию", details: v.errors });
    }

    const insertKing = db.prepare(`INSERT INTO kings (name, age, description) VALUES (?, ?, ?)`);
    const result = insertKing.run(nk.name, nk.age, nk.description);
    const kingId = result.lastInsertRowid;

    db.prepare(`INSERT INTO metrics (king_id, army, economy, diplomacy, loyalty) VALUES (?, 150, 150, 150, 150)`).run(
      kingId
    );

    const world = createInitialWorldState(nk);
    saveWorldState(kingId, world);

    res.json({
      id: kingId,
      ...nk,
      metrics: { army: 150, economy: 150, diplomacy: 150, loyalty: 150 },
      world: compressWorldForPrompt(world)
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

    let world = getWorldState(kingId);
    if (!world) {

      world = createInitialWorldState({ name: "Unknown", age: 30 });
      saveWorldState(kingId, world);
    }

    const planner = buildPlannerPacket(metrics, world);

    const worldForPrompt = compressWorldForPrompt(world);

    const prompt = `
Game: The Fate of the King (medieval, grounded, dark tone).
Hard constraints:
- NO modern tech, NO guns, NO electricity, NO internet, NO cars.
- Keep names and places consistent with medieval vibe.
- Avoid repeating the exact same scenario.
- The event MUST fit the current situation and planner intent.

Current metrics (0..300, higher is better):
${JSON.stringify(metrics, null, 2)}

Planner packet:
${JSON.stringify(planner, null, 2)}

World state (compressed):
${JSON.stringify(worldForPrompt, null, 2)}

Task:
Generate ONE event card with 2 choices.
Each choice should feel meaningful and trade-off-ish.
Effects must be integers in range [-20..20].
Return ONLY JSON matching the schema.
`.trim();

    console.time("LLM generation");
    const data = await callOpenRouter({
      model: MODEL_ID,
      messages: [
        {
          role: "system",
          content:
            "You are an event card generator for the game 'The Fate of the King'. Return ONLY JSON strictly matching the schema."
        },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_schema", json_schema: CARD_SCHEMA }
    });
    console.timeEnd("LLM generation");

    const content = data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: "Не удалось сгенерировать карточку: пустой ответ API" });

    let card = normalizeCard(parseStrictJson(content));


    let v = validateCard(card);
    if (!v.ok) {
      const repairedText = await repairJsonViaLLM({
        badJsonText: content,
        schema: CARD_SCHEMA.schema,
        model: MODEL_ID
      });

      const repaired = normalizeCard(parseStrictJson(repairedText));
      const v2 = validateCard(repaired);

      if (!v2.ok) {
        return res.status(500).json({
          error: "Карточка не прошла валидацию даже после repair",
          details: v2.errors
        });
      }
      card = repaired;
      v = v2;
    }


    console.time("Image generation");
    const image = await generateImage(`${card.title}. Medieval illustration, dark, dramatic, cinematic.`);
    console.timeEnd("Image generation");
    card.image = image;

    const lastTurn = getLastTurn(kingId);
    const turn = Math.max(lastTurn + 1, (world.turn || 0) + 1);


    insertEvent({
      kingId,
      turn,
      card,
      chosenIndex: null,
      effects: null,
      summary: ""
    });

    res.json({ ...card, turn, planner });
  } catch (err) {
    console.warn("Ошибка генерации карточки:", err.message);
    res.status(500).json({ error: "Не удалось сгенерировать карточку" });
  }
});


app.post("/apply-choice", (req, res) => {
  const { kingId, effects, choiceIndex, card, theme } = req.body || {};

  if (!kingId || !effects) {
    return res.status(400).json({ error: "Нужны kingId и effects" });
  }

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
      updated.army,
      updated.economy,
      updated.diplomacy,
      updated.loyalty,
      kingId
    );


    let world = getWorldState(kingId);
    if (!world) world = createInitialWorldState({ name: "Unknown", age: 30 });

    const ci = Number.isInteger(choiceIndex) ? choiceIndex : null;
    const canUpdateWorld = card && ci !== null && (ci === 0 || ci === 1);

    if (canUpdateWorld) {
      const newWorld = applyChoiceToWorld(world, card, ci, effects, theme);
      saveWorldState(kingId, newWorld);

      
      const turn = getLastTurn(kingId); 
      db.prepare(
        `UPDATE events SET chosen_index=?, effects_json=?, summary=? WHERE king_id=? AND turn=?`
      ).run(
        ci,
        JSON.stringify(effects),
        `Choice: ${card.choices?.[ci]?.text || ""}`.slice(0, 200),
        kingId,
        turn
      );
    }

    res.json(updated);
  } catch (err) {
    console.error("Ошибка обновления метрик:", err.message);
    res.status(500).json({ error: "Не удалось обновить метрики" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));