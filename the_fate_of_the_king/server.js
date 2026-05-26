require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');

const { CARD_SCHEMA } = require('./schema/card_schema.js');
const { KING_SCHEMA } = require('./schema/king_schema.js');

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY;

const MODEL_ID = 'google/gemma-3-27b-it:free';

const db = new Database('./game.db');

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
`);

async function callOpenRouter(body) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function generateImage(prompt) {
  const url = `https://ai-image-api.xeven.workers.dev/img?prompt=${encodeURIComponent(prompt)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to generate image: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer(); 
  const base64 = Buffer.from(arrayBuffer).toString('base64'); 
  return `data:image/png;base64,${base64}`;
}


app.post('/start-game', async (req, res) => {
  try {
    const data = await callOpenRouter({
      model: MODEL_ID,
      messages: [
        {
          role: "system",
          content: "You are a king card generator for the game 'The Fate of the King'. Return JSON exactly as per the schema."
        },
        {
          role: "user",
          content: "Create a king: fields name, age (number), description (short story of coming to power)."
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: KING_SCHEMA
      }
    });

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.warn("Пустой ответ OpenRouter:", data);
      return res.status(500).json({ error: "Не удалось создать короля: пустой ответ API" });
    }

    let king;
    try {
      king = JSON.parse(content);
    } catch (err) {
      console.warn("Ошибка парсинга JSON:", content);
      return res.status(500).json({ error: "Не удалось создать короля: неверный JSON" });
    }

    const insertKing = db.prepare(
      `INSERT INTO kings (name, age, description) VALUES (?, ?, ?)`
    );
    const result = insertKing.run(king.name, king.age, king.description);

    const kingId = result.lastInsertRowid;


    const insertMetrics = db.prepare(
      `INSERT INTO metrics (king_id, army, economy, diplomacy, loyalty) VALUES (?, 150, 150, 150, 150)`
    );
    insertMetrics.run(kingId);

    res.json({
      id: kingId,
      ...king,
      metrics: {
        army: 150,
        economy: 150,
        diplomacy: 150,
        loyalty: 150
      }
    });

  } catch (err) {
    console.warn('Ошибка генерации короля:', err.message);
    res.status(500).json({ error: 'Не удалось создать короля' });
  }
});

app.post('/apply-choice', (req, res) => {
  const { kingId, effects } = req.body;

  if (!kingId || !effects) {
    return res.status(400).json({ error: 'Нужны kingId и effects' });
  }

  try {
    const getMetrics = db.prepare(`SELECT * FROM metrics WHERE king_id = ?`);
    const metrics = getMetrics.get(kingId);
    if (!metrics) return res.status(404).json({ error: 'Метрики не найдены' });

    const updated = {
      army: metrics.army + (effects.army || 0),
      economy: metrics.economy + (effects.economy || 0),
      diplomacy: metrics.diplomacy + (effects.diplomacy || 0),
      loyalty: metrics.loyalty + (effects.loyalty || 0),
    };

    const updateMetrics = db.prepare(
      `UPDATE metrics SET army=?, economy=?, diplomacy=?, loyalty=? WHERE king_id=?`
    );
    updateMetrics.run(updated.army, updated.economy, updated.diplomacy, updated.loyalty, kingId);

    res.json(updated);
  } catch (err) {
    console.error('Ошибка обновления метрик:', err.message);
    res.status(500).json({ error: 'Не удалось обновить метрики' });
  }
});

app.post('/get-card', async (req, res) => {
  try {
    console.time("LLM generation");
    const data = await callOpenRouter({
      model: MODEL_ID,
      messages: [
        {
          role: "system",
          content: "You are an event card generator for the game 'The Fate of the King'. Return JSON strictly according to the schema."
        },
        {
          role: "user",
          content: "Generate an event card. Fields: title, description, choices[2] with text and effects for army, economy, loyalty, diplomacy (−20..20)."
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: CARD_SCHEMA
      }
    });
    console.timeEnd("LLM generation");

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.warn("Пустой/неожиданный ответ OpenRouter:", JSON.stringify(data, null, 2));
      return res.status(500).json({ error: "Не удалось сгенерировать карточку: пустой ответ API" });
    }

    let card;
    try {
      card = JSON.parse(content);
    } catch (err) {
      console.warn("Ошибка парсинга JSON:", content);
      return res.status(500).json({ error: "Не удалось сгенерировать карточку: неверный JSON" });
    }
    console.log("Fine generated card:");
    console.time("Image generation");
    const imageBuffer = await generateImage(card.title + " Medieval style.");
    console.timeEnd("Image generation");

    card.image = imageBuffer

    res.json(card);

  } catch (err) {
    console.warn('Ошибка генерации карточки:', err.message);
    res.status(500).json({ error: 'Не удалось сгенерировать карточку' });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));