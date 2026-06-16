const { Pool } = require('pg');
require('dotenv').config();

let pool;

if (process.env.DATABASE_URL) {
  // Add sslmode=verify-full to silence pg SSL warning
  const dbUrl = process.env.DATABASE_URL.includes('?')
    ? `${process.env.DATABASE_URL}&sslmode=verify-full`
    : `${process.env.DATABASE_URL}?sslmode=verify-full`;
  
  pool = new Pool({
    connectionString: dbUrl,
  });
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
