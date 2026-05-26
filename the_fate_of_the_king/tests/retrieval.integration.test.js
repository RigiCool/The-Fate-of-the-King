const { retrieveKnowledgeFTS } = require("../planner/planner.js");
const dbModule = require("../db");
const { db } = dbModule;

describe("retrieval/BM25 integration", () => {
  let kingId;
  beforeEach(() => {
    kingId = Date.now() + Math.floor(Math.random() * 1000000);
    const tables = [
      'knowledge_fts', 'knowledge', 'events', 'arcs', 'world_state', 'metrics', 'kings', 'users'
    ];
    for (const table of tables) {
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
    }
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(kingId, 'test@test', 'h');
    db.prepare('INSERT INTO kings (id,user_id,name,age,description) VALUES (?,?,?,?,?)').run(kingId, kingId, 'TestKing', 40, 'desc');
  });

  it("retrieve relevant facts for a query", () => {
    db.prepare('INSERT INTO knowledge (id, king_id, text, turn, kind) VALUES (?,?,?,?,?)').run(kingId, kingId, 'A rebellion is brewing in the north.', 1, 'fact');
    db.prepare('INSERT INTO knowledge_fts (rowid, tags) VALUES (?, ?)').run(kingId, 'rebellion north');
    const results = retrieveKnowledgeFTS(db, { kingId, query: "rebellion" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toMatch(/rebellion/i);
  });
});
