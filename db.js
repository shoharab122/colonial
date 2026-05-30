const { Pool } = require('pg');
require('dotenv').config();

let pool;

if (process.env.DATABASE_URL) {
  // Production: Render, Neon, or any PostgreSQL with connection string
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,                         // max connections in the pool
    idleTimeoutMillis: 30000,        // close idle clients after 30 seconds
    connectionTimeoutMillis: 2000,   // fail fast if cannot connect
  });
} else {
  // Local development fallback
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'colonial_db',
    max: 5,                          // fewer connections for local dev
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

// Optional: log when the pool connects successfully
pool.on('connect', () => {
  console.log('✅ Database pool connected');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database pool error:', err);
});

module.exports = pool;