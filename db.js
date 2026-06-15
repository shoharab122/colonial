const { Pool } = require('pg');
require('dotenv').config();

let pool;

if (process.env.DATABASE_URL) {
  // For Render's PostgreSQL — append sslmode=no-verify to silence SSL warning
  const connectionString = process.env.DATABASE_URL.includes('sslmode=')
    ? process.env.DATABASE_URL
    : `${process.env.DATABASE_URL}?sslmode=no-verify`;

  pool = new Pool({ connectionString });
} else {
  // Local development fallback
  pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 5432,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'colonial_db',
  });
}

module.exports = pool;
