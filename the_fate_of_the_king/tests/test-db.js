process.env.DB_PATH = './test.db';

const dbModule = require('../db');
const testDb = dbModule.db;

function ensureTestEventsColumns() {
  const columns = testDb.prepare(`PRAGMA table_info(events)`).all().map(row => row.name);
  const requiredColumns = [
    { name: "background_knowledge", sql: `ALTER TABLE events ADD COLUMN background_knowledge TEXT` },
    { name: "anti_repeat", sql: `ALTER TABLE events ADD COLUMN anti_repeat TEXT` },
    { name: "arc_pacing", sql: `ALTER TABLE events ADD COLUMN arc_pacing TEXT` }
  ];
  for (const column of requiredColumns) if (!columns.includes(column.name)) testDb.exec(column.sql);
}
ensureTestEventsColumns();

module.exports = dbModule;
