// db.js
const { Pool } = require('pg');
require('dotenv').config();

let pool;

if (process.env.DATABASE_URL) {
  // Remove sslmode from the URL to avoid the pg-connection-string warning,
  // because we set SSL explicitly via the `ssl` option.
  let connectionString = process.env.DATABASE_URL;
  try {
    const url = new URL(connectionString);
    if (url.searchParams.has('sslmode')) {
      url.searchParams.delete('sslmode');
      connectionString = url.toString();
    }
  } catch (e) {
    // If the URL is malformed, fall back to using it as-is.
    console.warn('Could not parse DATABASE_URL, using raw string.');
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false } // Set to `true` for production with a valid certificate
  });
} else {
  // Local development fallback (no SSL)
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'colonial_db',
  });
}

module.exports = pool;
