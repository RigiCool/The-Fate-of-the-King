// ------------------------------ //
// ---------- Database ---------- //
// ------------------------------ //
const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH || "./game.db";
const db = new Database(DB_PATH);



// Initialize database tables if they don't exist
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
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
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
  kind TEXT NOT NULL,
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
  const columns = db.prepare(`PRAGMA table_info(kings)`).all().map(r => r.name);
  if (!columns.includes("user_id")) {
    db.exec(`ALTER TABLE kings ADD COLUMN user_id INTEGER`);
  }
}
ensureKingsUserIdColumn();



function ensureEventsColumns() {
  const columns = db.prepare(`PRAGMA table_info(events)`).all().map(r => r.name);
  const need = [
    { name: "chosen_index", sql: `ALTER TABLE events ADD COLUMN chosen_index INTEGER` },
    { name: "effects_json", sql: `ALTER TABLE events ADD COLUMN effects_json TEXT` },
    { name: "summary", sql: `ALTER TABLE events ADD COLUMN summary TEXT` }
  ];
  for (const column of need) if (!columns.includes(column.name)) db.exec(column.sql);
}
ensureEventsColumns();




function safeJsonParse(string, fallback) {
  try { return JSON.parse(string); } catch { return fallback; }
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
  for (const row of rows) {
    const card = safeJsonParse(row.card_json, null);
    const title = String(card?.title || "").trim();
    const desc = String(card?.description || "").trim();
    const short = desc.length > 140 ? desc.slice(0, 137) + "..." : desc;
    const line = `- (turn ${row.turn}) ${title}${short ? ` — ${short}` : ""}`.trim();
    if (title) out.push(line);
  }
  return out;
}



function getRecentEventCards(kingId, limit = 5) {
  const rows = db.prepare(`
    SELECT card_json
    FROM events
    WHERE king_id=? AND chosen_index IS NOT NULL
    ORDER BY turn DESC
    LIMIT ?
  `).all(kingId, limit);

  return rows
    .map((row) => safeJsonParse(row.card_json, null))
    .filter(Boolean);
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



function getRecentKingsForUser(userId, limit = 5) {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.description, ws.turn
    FROM kings k
    LEFT JOIN world_state ws ON ws.king_id = k.id
    WHERE k.user_id = ?
    ORDER BY k.id DESC
    LIMIT ?
  `).all(userId, limit);

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: String(row.description || "").slice(0, 180),
    turn: row.turn ?? 0
  }));
}



// Admin user initialization with default credentials
async function initializeAdminUser(hashPassword) {
  const ADMIN_EMAIL = "admin@localhost";
  const ADMIN_PASSWORD = "admin123";
  
  const existing = db.prepare(`SELECT id FROM users WHERE email=?`).get(ADMIN_EMAIL);
  if (existing) {
    console.log("Admin user already exists");
    return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
  }

  try {
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const info = db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')`).run(ADMIN_EMAIL, passwordHash);
    console.log(`Admin user created with email: ${ADMIN_EMAIL} and password: ${ADMIN_PASSWORD}`);
    return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, id: info.lastInsertRowid };
  } catch (err) {
    console.error("Failed to initialize admin user:", err);
    throw err;
  }
}



module.exports = {
  db,
  safeJsonParse,
  getKingRow,
  getMetrics,
  getWorldRow,
  saveWorldRow,
  getActiveArc,
  getRecentKingsForUser,
  getEventIdByTurn,
  getEventCardByTurn,
  getRecentEventSummaries,
  getRecentEventCards,
  insertEvent,
  updateEventChoice,
  initializeAdminUser
};
