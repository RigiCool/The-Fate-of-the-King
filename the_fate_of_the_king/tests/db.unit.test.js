process.env.DB_PATH = ':memory:';
const dbModule = require('../db');
const { db } = dbModule;

function clearAll() {
  const tables = [
    'knowledge_fts',
    'knowledge',
    'events',
    'arcs',
    'world_state',
    'metrics',
    'kings',
    'users'
  ];
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { };
  }
}

describe('db utilities', () => {
  beforeEach(() => {
    clearAll();
  });

  test('safeJsonParse return fallback for invalid input', () => {
    expect(dbModule.safeJsonParse('not json', { x: 1 })).toEqual({ x: 1 });
    expect(dbModule.safeJsonParse('{"a":2}', null)).toEqual({ a: 2 });
  });

  test('event helper testing', () => {
    const kId = 1;
    const turn = 5;
    const card = { title: 'Foo', description: 'Bar' };
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(2, 'u@u', 'h');
    db.prepare('INSERT INTO kings (id,user_id,name,age,description) VALUES (?,?,?,?,?)').run(kId, 2, 'Test', 40, 'desc');

    expect(dbModule.getEventIdByTurn(kId, turn)).toBeNull();
    const id = dbModule.insertEvent({ kingId: kId, turn, card });
    expect(typeof id).toBe('number');
    expect(dbModule.getEventIdByTurn(kId, turn)).toBe(id);

    expect(dbModule.insertEvent({ kingId: kId, turn, card })).toBe(id);

    const fetched = dbModule.getEventCardByTurn(kId, turn);
    expect(fetched).toEqual(card);

    dbModule.updateEventChoice({ kingId: kId, turn, choiceIndex: 1, effects: { army: 3 }, summary: 'ok' });
    const row = db.prepare('SELECT chosen_index,effects_json,summary FROM events WHERE id=?').get(id);
    expect(row.chosen_index).toBe(1);
    expect(JSON.parse(row.effects_json)).toEqual({ army: 3 });
    expect(row.summary).toBe('ok');

    const summaries = dbModule.getRecentEventSummaries(kId, 10);
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries[0]).toContain('(turn 5)');

    dbModule.insertEvent({ kingId: kId, turn: 6, card: { description: 'only desc' } });
    dbModule.updateEventChoice({ kingId: kId, turn: 6, choiceIndex: 0, effects: {}, summary: '' });
    const sums2 = dbModule.getRecentEventSummaries(kId, 10);
    expect(sums2.length).toBeGreaterThanOrEqual(1);
  });

  test('database insert and get testing', () => {
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(2, 'bob@b', 'h');
    db.prepare('INSERT INTO kings (id, user_id, name, age, description) VALUES (?,?,?,?,?)')
      .run(10, 2, 'Bob', 50, 'desc');
    db.prepare('INSERT INTO metrics (king_id, army,economy,diplomacy,loyalty) VALUES (?,?,?,?,?)')
      .run(10, 100, 110, 120, 130);
    db.prepare('INSERT INTO world_state (king_id, turn, memory_json, constraints_json) VALUES (?,?,?,?)')
      .run(10, 7, JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 }));

    expect(dbModule.getKingRow(10)).toMatchObject({ id: 10, name: 'Bob' });
    expect(dbModule.getMetrics(10)).toMatchObject({ army: 100, economy: 110 });
    expect(dbModule.getWorldRow(10)).toEqual({ turn: 7, memory: { a: 1 }, constraints: { b: 2 } });

    dbModule.saveWorldRow(10, { turn: 8, memory: { x: 2 }, constraints: { y: 3 } });
    expect(dbModule.getWorldRow(10).turn).toBe(8);

    expect(dbModule.getActiveArc(10)).toBeNull();

    db.prepare(
      'INSERT INTO arcs (king_id,title,kind,trigger_metric,status,phase,created_turn,expires_turn) VALUES (?,?,?,?,?,?,?,?)'
    ).run(10, 'A', 'war', 'army', 'active', 'start', 1, 5);
    expect(dbModule.getActiveArc(10).status).toBe('active');

    db.prepare('INSERT INTO kings (user_id,name) VALUES (?,?)').run(2, 'Alice');
    const rec = dbModule.getRecentKingsForUser(2, 5);
    expect(rec.some(r => r.name === 'Alice')).toBe(true);
  });
});

describe('database event full branch coverage testing', () => {
  const dbModule = require('../db');
  const { db } = dbModule;

  test('getEventCardByTurn return null in case of no row match', () => {
    expect(dbModule.getEventCardByTurn(999, 1)).toBeNull();
  });

  test('getRecentEventSummaries handle empty, missed title and long desc', () => {
    expect(dbModule.getRecentEventSummaries(999, 5)).toEqual([]);
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(3, 'x@x', 'h');
    db.prepare('INSERT INTO kings (id,user_id,name,age,description) VALUES (?,?,?,?,?)').run(20, 3, 'Test', 40, 'desc');
    db.prepare('INSERT INTO events (king_id, turn, card_json, chosen_index) VALUES (?,?,?,?)')
      .run(20, 1, JSON.stringify({ description: 'd'.repeat(200) }), 0);
    const out = dbModule.getRecentEventSummaries(20, 5);
    expect(out).toEqual([]);
  });

  test('getWorldRow return null in case of no row match', () => {
    expect(dbModule.getWorldRow(999)).toBeNull();
  });

  test('getActiveArc returns null in case of no active arcs', () => {
    expect(dbModule.getActiveArc(999)).toBeNull();
  });
});

describe('database getRecentEventSummaries branch coverage', () => {
  const dbModule = require('../db');
  const { db } = dbModule;

  test('getRecentEventSummaries include short and long descriptions', () => {
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(4, 'y@y', 'h');
    db.prepare('INSERT INTO kings (id,user_id,name,age,description) VALUES (?,?,?,?,?)').run(30, 4, 'Test', 40, 'desc');
    db.prepare('INSERT INTO events (king_id, turn, card_json, chosen_index) VALUES (?,?,?,?)')
      .run(30, 1, JSON.stringify({ title: 'T', description: 'short' }), 0);
    db.prepare('INSERT INTO events (king_id, turn, card_json, chosen_index) VALUES (?,?,?,?)')
      .run(30, 2, JSON.stringify({ title: 'L', description: 'd'.repeat(200) }), 0);
    db.prepare('INSERT INTO events (king_id, turn, card_json, chosen_index) VALUES (?,?,?,?)')
      .run(30, 3, JSON.stringify({ description: 'no title' }), 0);
    const out = dbModule.getRecentEventSummaries(30, 10);
    expect(out.length).toBe(2);
    expect(out[0]).toContain('...');
    expect(out[1]).toContain('short');
    expect(out.some(line => line.includes('no title'))).toBe(false);
  });
});

describe('database king full branch coverage testing', () => {
  const dbModule = require('../db');
  const { db } = dbModule;

  test('getKingRow return null if king does not exist', () => {
    expect(dbModule.getKingRow(9999)).toBeNull();
  });

  test('getRecentKingsForUser return empty array if user has no kings', () => {
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(100, 'empty@user', 'h');
    expect(dbModule.getRecentKingsForUser(100, 5)).toEqual([]);
  });

  test('getRecentKingsForUser handle null description and missed world state', () => {
    db.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(101, 'null@desc', 'h');
    db.prepare('INSERT INTO kings (id,user_id,name) VALUES (?,?,?)').run(200, 101, 'NullDesc');
    const result = dbModule.getRecentKingsForUser(101, 5);
    expect(result.length).toBe(1);
    expect(result[0].description).toBe('');
    expect(result[0].turn).toBe(0);
  });
});
