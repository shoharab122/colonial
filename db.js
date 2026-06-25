// db.js — PostgreSQL connection pool
'use strict';
const { Pool } = require('pg');
require('dotenv').config();

const IS_PROD = process.env.NODE_ENV === 'production';

let poolConfig;

if (process.env.DATABASE_URL) {
  let connectionString = process.env.DATABASE_URL;

  // Strip ?sslmode= from URL — we control SSL via the `ssl` option below
  try {
    const url = new URL(connectionString);
    if (url.searchParams.has('sslmode')) {
      url.searchParams.delete('sslmode');
      connectionString = url.toString();
    }
  } catch {
    console.warn('⚠️  Could not parse DATABASE_URL as a URL — using raw string.');
  }

  poolConfig = {
    connectionString,
    ssl: {
      // In production, enforce certificate validation.
      // Set DATABASE_CA_CERT env var to your CA cert string, or flip to true
      // once you have a valid cert from your cloud provider.
      rejectUnauthorized: IS_PROD,
      ...(IS_PROD && process.env.DATABASE_CA_CERT
        ? { ca: process.env.DATABASE_CA_CERT }
        : {}),
    },
  };
} else {
  // Local development — no SSL
  poolConfig = {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'colonial_db',
  };
}

const pool = new Pool({
  ...poolConfig,
  // Connection pool tuning
  max:              parseInt(process.env.DB_POOL_MAX, 10)  || 10,  // max simultaneous connections
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_MS, 10)  || 30_000, // close idle connections after 30s
  connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT_MS, 10) || 5_000, // fail fast if DB is unreachable
  allowExitOnIdle:  true, // let the process exit cleanly when pool is idle
});

// Surface connection errors immediately instead of failing silently on first query
pool.on('error', (err) => {
  console.error('❌ Unexpected DB pool error:', err.message);
  // Don't exit — pg will try to reconnect on the next query
});

// Verify connectivity on startup (non-fatal — server can still start)
pool.query('SELECT 1')
  .then(() => console.log('✅ PostgreSQL connected'))
  .catch((err) => console.error('⚠️  PostgreSQL connection check failed:', err.message));

module.exports = pool;
