require('dotenv').config();
if (!process.env.DB_PATH || process.env.DB_PATH === './game.db') {
  process.env.DB_PATH = ':memory:';
}

