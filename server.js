// server.js — COLONIAL E-Commerce Backend (Optimised v2)
// PostgreSQL + Cloudinary + JWT Auth + SSE + Coupons + Order Tracking
'use strict';
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const passport     = require('passport');
const multer       = require('multer');
const compression  = require('compression');
const pool         = require('./db');
const cloudinary   = require('cloudinary').v2;

// ── ENV VALIDATION ─────────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'SESSION_SECRET'];
const missingEnv   = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.warn(`⚠️  Missing env vars: ${missingEnv.join(', ')} — using insecure defaults`);
}

// ── CLOUDINARY CONFIG ──────────────────────────────────────────
const CLOUDINARY_OK = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_OK) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('✅ Cloudinary configured');
} else {
  console.warn('⚠️  Cloudinary credentials missing — image uploads will fail.');
}
console.log('🔌 DB:', process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'local config');

// ── CONSTANTS ──────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colonial_super_secret_key_change_me';
const IS_PROD    = process.env.NODE_ENV === 'production';

const VALID_ORDER_STATUSES  = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);
const VALID_PAYMENT_STATUSES = new Set(['pending', 'awaiting_verification', 'paid', 'failed']);

// ── APP SETUP ──────────────────────────────────────────────────
const app = express();

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(compression());
app.use(cors({
  origin: IS_PROD ? process.env.ALLOWED_ORIGIN || true : true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Static files: long cache for hashed assets, short for HTML
app.use(express.static('public', {
  maxAge: '7d',
  etag:   true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.use(session({
  store:            new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret:           process.env.SESSION_SECRET || 'colonial_session_secret',
  resave:           false,
  saveUninitialized: false,
  cookie: { secure: IS_PROD, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());

// ── PASSPORT ───────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role FROM users WHERE id = $1', [id]
    );
    done(null, rows[0] || null);
  } catch (err) { done(err); }
});

// ═══════════════════════════════════════════════════════════════
// CACHE — TTL-based in-memory with prefix invalidation
// ═══════════════════════════════════════════════════════════════
class TtlCache {
  constructor(cleanupIntervalMs = 60_000) {
    this._store = new Map();
    this._timer = setInterval(() => this._purge(), cleanupIntervalMs);
    this._timer.unref(); // don't block process exit
  }
  set(key, value, ttlMs = 30_000) {
    this._store.set(key, { value, expires: Date.now() + ttlMs });
  }
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this._store.delete(key); return null; }
    return entry.value;
  }
  delete(key) { this._store.delete(key); }
  invalidate(...keys) { keys.forEach(k => this._store.delete(k)); }
  invalidatePrefix(prefix) {
    for (const k of this._store.keys()) if (k.startsWith(prefix)) this._store.delete(k);
  }
  _purge() {
    const now = Date.now();
    for (const [k, e] of this._store) if (now > e.expires) this._store.delete(k);
  }
}
const cache = new TtlCache();

// ── AUTH MIDDLEWARE ────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid token.';
    res.status(403).json({ error: msg });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── ASYNC ROUTE WRAPPER — eliminates try/catch boilerplate ─────
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── MULTER / IMAGE UPLOAD ──────────────────────────────────────
const ALLOWED_EXT  = /\.(jpeg|jpg|png|gif|webp)$/i;
const ALLOWED_MIME = /^image\/(jpeg|png|gif|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED_EXT.test(path.extname(file.originalname)) &&
               ALLOWED_MIME.test(file.mimetype);
    cb(ok ? null : new Error('Only images allowed (jpeg, jpg, png, gif, webp)'), ok);
  },
});

// Multer error handler middleware
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large. Max 10 MB.' });
    return res.status(400).json({ error: err.message });
  }
  if (err?.message?.startsWith('Only images')) return res.status(415).json({ error: err.message });
  next(err);
}

app.post(
  '/api/upload',
  authenticateToken, requireAdmin,
  upload.single('image'),
  handleMulterError,
  asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!CLOUDINARY_OK) return res.status(503).json({ error: 'Cloudinary not configured' });
    const b64    = req.file.buffer.toString('base64');
    const result = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${b64}`,
      { folder: 'colonial_products', use_filename: true, unique_filename: true, resource_type: 'image' }
    );
    res.json({ imageUrl: result.secure_url });
  })
);

// ── HELPERS ────────────────────────────────────────────────────
const imagesToJson = (images) =>
  Array.isArray(images) && images.length ? JSON.stringify(images) : null;

const safeParseImages = (product) => {
  if (product.images) {
    try {
      const parsed = typeof product.images === 'string' ? JSON.parse(product.images) : product.images;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return product.image_url ? [product.image_url] : [];
};

const serializeItems = (items) => {
  if (!items) return '[]';
  if (typeof items === 'string') return items;
  return JSON.stringify(items);
};

const mapProduct = (p) => ({
  ...p,
  materials: p.materials ? p.materials.split(',').map(s => s.trim()) : [],
  colors:    p.colors    ? p.colors.split(',').map(s => s.trim())    : [],
  images:    safeParseImages(p),
});

const parsePosInt = (val, fallback) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ═══════════════════════════════════════════════════════════════
// SSE MANAGER
// ═══════════════════════════════════════════════════════════════
class SSEBroadcaster {
  constructor() { this.clients = new Set(); }
  add(res) {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }
  broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }
  get size() { return this.clients.size; }
}

const orderBroadcaster = new SSEBroadcaster();

// Per-user customer SSE map
const customerSSE = new Map(); // userId -> Set<res>

function addCustomerClient(userId, res) {
  if (!customerSSE.has(userId)) customerSSE.set(userId, new Set());
  customerSSE.get(userId).add(res);
}
function removeCustomerClient(userId, res) {
  const set = customerSSE.get(userId);
  if (!set) return;
  set.delete(res);
  if (!set.size) customerSSE.delete(userId);
}
function broadcastToCustomer(userId, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const set = customerSSE.get(userId);
  if (!set) return;
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

// Per-order tracking SSE map (for public order tracking page)
const trackingSSE = new Map(); // orderNumber -> Set<res>

function addTrackingClient(orderNumber, res) {
  if (!trackingSSE.has(orderNumber)) trackingSSE.set(orderNumber, new Set());
  trackingSSE.get(orderNumber).add(res);
}
function removeTrackingClient(orderNumber, res) {
  const set = trackingSSE.get(orderNumber);
  if (!set) return;
  set.delete(res);
  if (!set.size) trackingSSE.delete(orderNumber);
}
function broadcastToTracking(orderNumber, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const set = trackingSSE.get(orderNumber);
  if (!set) return;
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

function initSSEResponse(res) {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 25_000);
  return hb;
}

// Admin SSE
app.get('/api/admin/order-events', authenticateToken, requireAdmin, (req, res) => {
  const hb     = initSSEResponse(res);
  const remove = orderBroadcaster.add(res);
  req.on('close', () => { clearInterval(hb); remove(); });
});

// Customer SSE (authenticated)
app.get('/api/customer/order-events', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const hb     = initSSEResponse(res);
  addCustomerClient(userId, res);
  req.on('close', () => { clearInterval(hb); removeCustomerClient(userId, res); });
});

// ═══════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════
const PRODUCT_SELECT = `
  SELECT *,
    (price - COALESCE(discount_amount, 0)) AS final_price,
    CASE WHEN price > 0
      THEN ROUND(((discount_amount / price) * 100), 0)
      ELSE 0
    END AS discount_percent
  FROM products
`;

// GET all active products (cached 30s)
app.get('/api/products', asyncRoute(async (req, res) => {
  const cached = cache.get('products:all');
  if (cached) return res.json(cached);
  const { rows } = await pool.query(
    PRODUCT_SELECT + ' WHERE is_active = true ORDER BY created_at DESC'
  );
  const result = rows.map(mapProduct);
  cache.set('products:all', result, 30_000);
  res.json(result);
}));

// GET products with search / filter / pagination
app.get('/api/products/search', asyncRoute(async (req, res) => {
  const { q = '', category = 'all', sort = 'newest', page = 1, limit = 8 } = req.query;
  const params = [];
  let where = ' WHERE is_active = true';

  if (q.trim())        { params.push(`%${q.trim()}%`); where += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`; }
  if (category !== 'all') { params.push(category); where += ` AND category = $${params.length}`; }

  const orderBy = sort === 'price_asc'  ? 'final_price ASC'
                : sort === 'price_desc' ? 'final_price DESC'
                : sort === 'rating'     ? 'avg_rating DESC NULLS LAST'
                : 'created_at DESC';

  const lim    = Math.min(parsePosInt(limit, 8), 100);
  const offset = (Math.max(parsePosInt(page, 1), 1) - 1) * lim;
  params.push(lim, offset);

  const dataSql  = PRODUCT_SELECT + where + ` ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const countSql = 'SELECT COUNT(*) AS total FROM products' + where;
  const countP   = params.slice(0, -2);

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(dataSql, params),
    pool.query(countSql, countP),
  ]);
  const total = parseInt(countRows[0].total, 10);
  res.json({
    products:   rows.map(mapProduct),
    total,
    page:       Math.max(parsePosInt(page, 1), 1),
    limit:      lim,
    totalPages: Math.ceil(total / lim),
  });
}));

// GET single product (cached 60s)
app.get('/api/products/:id', asyncRoute(async (req, res) => {
  const id       = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product ID' });
  const cacheKey = `product:${id}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);
  const { rows } = await pool.query(
    PRODUCT_SELECT + ' WHERE id = $1 AND is_active = true', [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Product not found' });
  const result = mapProduct(rows[0]);
  cache.set(cacheKey, result, 60_000);
  res.json(result);
}));

// POST create product (admin)
app.post('/api/products', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock } = req.body;
  if (!name?.trim() || !price || !category?.trim())
    return res.status(400).json({ error: 'name, price and category are required' });
  if (isNaN(parseFloat(price)) || parseFloat(price) < 0)
    return res.status(400).json({ error: 'price must be a non-negative number' });

  const { rows } = await pool.query(
    `INSERT INTO products
       (name, price, discount_amount, category, image_url, images,
        badge, description, materials, colors, care, stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      name.trim(), parseFloat(price), parseFloat(discount_amount) || 0,
      category.trim(),
      image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
      imagesToJson(images), badge || null, description || '',
      (materials || []).join(','), (colors || []).join(','),
      care || null, parseInt(stock, 10) || 0,
    ]
  );
  cache.invalidate('products:all', 'stats');
  res.status(201).json({ id: rows[0].id, ...req.body });
}));

// PUT update product (admin)
app.put('/api/products/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product ID' });
  const { name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock, is_active } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE products SET
       name=$1, price=$2, discount_amount=$3, category=$4,
       image_url=$5, images=$6, badge=$7, description=$8,
       materials=$9, colors=$10, care=$11, stock=$12, is_active=$13,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=$14`,
    [
      name, parseFloat(price), parseFloat(discount_amount) || 0, category,
      image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
      imagesToJson(images), badge || null, description || '',
      (materials || []).join(','), (colors || []).join(','),
      care || null, parseInt(stock, 10) || 0,
      is_active !== undefined ? is_active : true,
      id,
    ]
  );
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });
  cache.invalidate('products:all', `product:${id}`, 'stats');
  res.json({ id, ...req.body });
}));

// DELETE product (admin)
app.delete('/api/products/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid product ID' });
  const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Product not found' });
  cache.invalidate('products:all', `product:${id}`, 'stats');
  res.json({ success: true });
}));

// Product variants (stub)
app.get('/api/products/:id/variants', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM product_variants WHERE product_id = $1', [req.params.id]
  );
  res.json(rows);
}));

// ═══════════════════════════════════════════════════════════════
// COUPONS — PUBLIC VALIDATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/validate-coupon', asyncRoute(async (req, res) => {
  const { code, cartTotal } = req.body;
  if (!code || cartTotal === undefined)
    return res.status(400).json({ error: 'code and cartTotal are required' });

  const total = parseFloat(cartTotal);
  if (!Number.isFinite(total) || total < 0)
    return res.status(400).json({ error: 'cartTotal must be a valid number' });

  const { rows } = await pool.query(
    `SELECT * FROM coupons
     WHERE UPPER(code) = UPPER($1)
       AND is_active = true
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_to   IS NULL OR valid_to   >= CURRENT_DATE)
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
    [code.trim()]
  );
  if (!rows.length) return res.status(404).json({ error: 'Invalid or expired coupon' });

  const coupon = rows[0];
  const minAmt = parseFloat(coupon.min_order_amount) || 0;
  if (total < minAmt)
    return res.status(400).json({ error: `Minimum order amount BDT ${coupon.min_order_amount} required` });

  let discount = coupon.discount_type === 'percentage'
    ? (total * parseFloat(coupon.discount_value)) / 100
    : parseFloat(coupon.discount_value);
  discount = Math.min(parseFloat(discount.toFixed(2)), total);

  res.json({
    code:           coupon.code,
    discount,
    discount_type:  coupon.discount_type,
    discount_value: parseFloat(coupon.discount_value),
  });
}));

// ═══════════════════════════════════════════════════════════════
// ORDER TRACKING (PUBLIC) — missing from original server
// ═══════════════════════════════════════════════════════════════
app.get('/api/track/:orderNumber', asyncRoute(async (req, res) => {
  const { orderNumber } = req.params;
  const { rows } = await pool.query(
    `SELECT id, order_number, customer_name, order_status, payment_status,
            final_amount, total_amount, items, created_at, delivery_method
     FROM orders WHERE order_number = $1`,
    [orderNumber.trim()]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const o = rows[0];
  res.json({
    ...o,
    items:        serializeItems(o.items),
    final_amount: o.final_amount ?? o.total_amount ?? 0,
  });
}));

// Public SSE for order tracking page
app.get('/api/track/:orderNumber/events', (req, res) => {
  const orderNumber = req.params.orderNumber.trim();
  const hb = initSSEResponse(res);
  addTrackingClient(orderNumber, res);
  req.on('close', () => { clearInterval(hb); removeTrackingClient(orderNumber, res); });
});

// ═══════════════════════════════════════════════════════════════
// ORDERS — CREATE
// ═══════════════════════════════════════════════════════════════
app.post('/api/orders', asyncRoute(async (req, res) => {
  // Optional auth — resolves guest vs logged-in email
  let userEmail = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try { userEmail = jwt.verify(authHeader.split(' ')[1], JWT_SECRET).email; } catch { /* guest */ }
  }

  const {
    customer_name, customer_email, customer_phone, shipping_address,
    total_amount, discount_applied, final_amount, items,
    coupon_code, notes, payment_method, transaction_id,
    delivery_method, delivery_fee,
  } = req.body;

  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Cart is empty. Cannot place order.' });
  if (!customer_name?.trim())
    return res.status(400).json({ error: 'customer_name is required' });

  const finalEmail    = userEmail || customer_email;
  if (!finalEmail)    return res.status(400).json({ error: 'customer_email is required' });

  const order_number   = `COL-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const payment_status = (payment_method === 'bkash' || payment_method === 'nagad')
    ? 'awaiting_verification' : 'pending';

  const client = await pool.connect();
  let orderId;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO orders
         (order_number, customer_name, customer_email, customer_phone,
          shipping_address, total_amount, discount_applied, final_amount,
          items, coupon_code, notes,
          payment_method, transaction_id, payment_status,
          delivery_method, delivery_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        order_number, customer_name.trim(), finalEmail, customer_phone || null,
        shipping_address || null,
        parseFloat(total_amount)     || 0,
        parseFloat(discount_applied) || 0,
        parseFloat(final_amount)     || 0,
        JSON.stringify(items),
        coupon_code ? coupon_code.toUpperCase().trim() : null,
        notes || null,
        payment_method  || 'cash_on_delivery',
        transaction_id  || null,
        payment_status,
        delivery_method || null,
        parseFloat(delivery_fee) || 0,
      ]
    );
    orderId = rows[0].id;

    // Increment coupon usage
    if (coupon_code) {
      await client.query(
        'UPDATE coupons SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)',
        [coupon_code.trim()]
      );
    }

    // Upsert customer analytics
    await client.query(
      `INSERT INTO customers (email, name, phone, total_orders, total_spent, last_order_at)
       VALUES ($1,$2,$3,1,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO UPDATE SET
         name          = EXCLUDED.name,
         phone         = EXCLUDED.phone,
         total_orders  = customers.total_orders + 1,
         total_spent   = customers.total_spent + EXCLUDED.total_spent,
         last_order_at = CURRENT_TIMESTAMP`,
      [finalEmail, customer_name.trim(), customer_phone || null, parseFloat(final_amount) || 0]
    );

    // Batch stock decrement
    if (items.length) {
      const ids  = items.map(i => parseInt(i.id, 10));
      const qtys = items.map(i => parseInt(i.quantity, 10) || 1);
      await client.query(
        `UPDATE products SET stock = GREATEST(stock - v.qty, 0)
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS qty) v
         WHERE products.id = v.id`,
        [ids, qtys]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  cache.invalidate('products:all', 'stats');

  const broadcastPayload = {
    id: orderId, order_number, customer_name,
    customer_email: finalEmail, final_amount,
    payment_method, payment_status, delivery_method, delivery_fee,
    created_at: new Date().toISOString(),
  };
  orderBroadcaster.broadcast(broadcastPayload);

  res.status(201).json({ id: orderId, order_number, payment_status });
}));

// ── ADMIN: ALL ORDERS ──────────────────────────────────────────
app.get('/api/admin/orders', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(rows.map(o => ({
    ...o,
    items:        serializeItems(o.items),
    final_amount: o.final_amount ?? o.total_amount ?? 0,
  })));
}));

// ── ADMIN: UPDATE ORDER STATUS ─────────────────────────────────
app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!VALID_ORDER_STATUSES.has(status))
    return res.status(400).json({ error: `Invalid status. Valid: ${[...VALID_ORDER_STATUSES].join(', ')}` });

  const { rows } = await pool.query(
    'UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING customer_email, order_number',
    [status, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });

  const { customer_email, order_number } = rows[0];

  // Broadcast to public tracking SSE
  broadcastToTracking(order_number, {
    type: 'order_status_update', orderNumber: order_number, newStatus: status,
  });

  // Fire-and-forget: broadcast to authenticated customer SSE
  pool.query('SELECT id FROM users WHERE email = $1', [customer_email])
    .then(({ rows: u }) => {
      if (u.length) broadcastToCustomer(u[0].id, {
        type: 'order_status_update', orderId: parseInt(req.params.id, 10), newStatus: status,
      });
    }).catch(() => {});

  cache.invalidate('stats');
  res.json({ success: true });
}));

// ── ADMIN: UPDATE PAYMENT STATUS ───────────────────────────────
app.put('/api/admin/orders/:id/payment-status', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { payment_status } = req.body;
  if (!VALID_PAYMENT_STATUSES.has(payment_status))
    return res.status(400).json({ error: `Invalid payment status. Valid: ${[...VALID_PAYMENT_STATUSES].join(', ')}` });

  const { rows } = await pool.query(
    'UPDATE orders SET payment_status = $1 WHERE id = $2 RETURNING customer_email, order_number',
    [payment_status, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });

  const { customer_email, order_number } = rows[0];

  // Broadcast to public tracking SSE
  broadcastToTracking(order_number, {
    type: 'payment_status_update', orderNumber: order_number, paymentStatus: payment_status,
  });

  pool.query('SELECT id FROM users WHERE email = $1', [customer_email])
    .then(({ rows: u }) => {
      if (u.length) broadcastToCustomer(u[0].id, {
        type: 'payment_status_update', orderId: parseInt(req.params.id, 10), paymentStatus: payment_status,
      });
    }).catch(() => {});

  res.json({ success: true });
}));

// ── ADMIN: DELETE ORDER ────────────────────────────────────────
app.delete('/api/admin/orders/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Order not found' });
  cache.invalidate('stats');
  res.json({ success: true });
}));

// ── ADMIN: STATS (cached 30s, parallel queries) ────────────────
app.get('/api/admin/stats', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const cached = cache.get('stats');
  if (cached) return res.json(cached);
  const [products, orders, lowStock] = await Promise.all([
    pool.query('SELECT COUNT(*) AS n FROM products WHERE is_active = true'),
    pool.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(COALESCE(final_amount, total_amount, 0)), 0) AS revenue
       FROM orders WHERE order_status != 'cancelled'`
    ),
    pool.query('SELECT COUNT(*) AS n FROM products WHERE stock < 5 AND is_active = true'),
  ]);
  const result = {
    totalProducts: parseInt(products.rows[0].n, 10),
    totalOrders:   parseInt(orders.rows[0].n, 10),
    revenue:       Number(orders.rows[0].revenue).toFixed(2),
    lowStock:      parseInt(lowStock.rows[0].n, 10),
  };
  cache.set('stats', result, 30_000);
  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════
// ADMIN COUPONS CRUD
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/coupons', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
  res.json(rows);
}));

app.post('/api/admin/coupons', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount,
          usage_limit, valid_from, valid_to, is_active } = req.body;
  if (!code || !discount_type || discount_value === undefined)
    return res.status(400).json({ error: 'code, discount_type and discount_value are required' });
  if (!['percentage', 'fixed'].includes(discount_type))
    return res.status(400).json({ error: 'discount_type must be "percentage" or "fixed"' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons
         (code, discount_type, discount_value, min_order_amount,
          usage_limit, valid_from, valid_to, is_active, used_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0) RETURNING *`,
      [
        code.toUpperCase().trim(), discount_type,
        parseFloat(discount_value), parseFloat(min_order_amount) || 0,
        usage_limit && parseInt(usage_limit, 10) > 0 ? parseInt(usage_limit, 10) : null,
        valid_from || null, valid_to || null, is_active !== false,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    throw err;
  }
}));

app.put('/api/admin/coupons/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount,
          usage_limit, valid_from, valid_to, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE coupons SET
         code=$1, discount_type=$2, discount_value=$3,
         min_order_amount=$4, usage_limit=$5,
         valid_from=$6, valid_to=$7, is_active=$8
       WHERE id=$9 RETURNING *`,
      [
        code.toUpperCase().trim(), discount_type,
        parseFloat(discount_value), parseFloat(min_order_amount) || 0,
        usage_limit && parseInt(usage_limit, 10) > 0 ? parseInt(usage_limit, 10) : null,
        valid_from || null, valid_to || null, is_active !== false, req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    throw err;
  }
}));

app.delete('/api/admin/coupons/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Coupon not found' });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// WISHLIST
// ═══════════════════════════════════════════════════════════════
app.get('/api/wishlist', authenticateToken, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*,
            (p.price - COALESCE(p.discount_amount,0)) AS final_price,
            CASE WHEN p.price > 0
              THEN ROUND(((p.discount_amount / p.price) * 100),0)
              ELSE 0 END AS discount_percent
     FROM wishlist w
     JOIN products p ON w.product_id = p.id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC`,
    [req.user.id]
  );
  res.json(rows.map(mapProduct));
}));

app.post('/api/wishlist', authenticateToken, asyncRoute(async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Product ID required' });
  await pool.query(
    'INSERT INTO wishlist (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.user.id, product_id]
  );
  res.json({ success: true });
}));

app.delete('/api/wishlist/:product_id', authenticateToken, asyncRoute(async (req, res) => {
  await pool.query(
    'DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2',
    [req.user.id, req.params.product_id]
  );
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════
app.get('/api/products/:id/reviews', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS reviewer_name
     FROM reviews r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.product_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/api/products/:id/reviews', authenticateToken, asyncRoute(async (req, res) => {
  const { rating, comment } = req.body;
  const productId = parseInt(req.params.id, 10);
  if (!Number.isFinite(productId)) return res.status(400).json({ error: 'Invalid product ID' });
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating must be 1–5' });

  const { rows: ex } = await pool.query(
    'SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2',
    [productId, req.user.id]
  );
  if (ex.length) return res.status(409).json({ error: 'You already reviewed this product' });

  await pool.query(
    'INSERT INTO reviews (product_id, user_id, user_name, rating, comment) VALUES ($1,$2,$3,$4,$5)',
    [productId, req.user.id, req.user.name || 'Anonymous', rating, comment || '']
  );
  // Recalculate avg & count in a single query
  await pool.query(
    `UPDATE products SET
       avg_rating   = (SELECT AVG(rating)  FROM reviews WHERE product_id = $1),
       review_count = (SELECT COUNT(*)      FROM reviews WHERE product_id = $1)
     WHERE id = $1`,
    [productId]
  );
  cache.invalidate(`product:${productId}`, 'products:all');
  res.status(201).json({ success: true });
}));

// Admin: list all reviews
app.get('/api/admin/reviews', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, p.name AS product_name,
            u.email AS user_email, u.name AS user_name
     FROM reviews r
     LEFT JOIN products p ON r.product_id = p.id
     LEFT JOIN users    u ON r.user_id    = u.id
     ORDER BY r.created_at DESC`
  );
  res.json(rows);
}));

// Admin: delete review + recalculate rating
app.delete('/api/admin/reviews/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM reviews WHERE id = $1 RETURNING product_id', [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Review not found' });
  const pid = rows[0].product_id;
  await pool.query(
    `UPDATE products SET
       avg_rating   = COALESCE((SELECT AVG(rating) FROM reviews WHERE product_id = $1), 0),
       review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1)
     WHERE id = $1`,
    [pid]
  );
  cache.invalidate(`product:${pid}`, 'products:all');
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// WISHLISTS — Admin view
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/wishlists', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT w.id, w.user_id, w.product_id, w.created_at,
            p.name AS product_name, p.price AS product_price, p.image_url,
            u.email AS user_email, u.name AS user_name
     FROM wishlist w
     LEFT JOIN products p ON w.product_id = p.id
     LEFT JOIN users    u ON w.user_id    = u.id
     ORDER BY w.created_at DESC`
  );
  res.json(rows);
}));

app.delete('/api/admin/wishlist/:id', authenticateToken, requireAdmin, asyncRoute(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM wishlist WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Wishlist item not found' });
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });
  if (!EMAIL_REGEX.test(email))
    return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { rows: ex } = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (ex.length) return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO users (email, password, name, role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
    [email.toLowerCase(), hashed, name?.trim() || null, 'customer']
  );
  const user  = rows[0];
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  // Use constant-time comparison even when user doesn't exist to prevent timing attacks
  const user = rows[0];
  const dummyHash = '$2b$12$invalidhashfortimingattackprevention000000000000000000';
  const match = await bcrypt.compare(password, user?.password || dummyHash);
  if (!user || !match)
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));

app.get('/api/auth/me', authenticateToken, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

// ═══════════════════════════════════════════════════════════════
// CUSTOMER ORDERS
// ═══════════════════════════════════════════════════════════════
app.get('/api/customer/orders', authenticateToken, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC',
    [req.user.email]
  );
  res.json(rows.map(o => ({
    ...o,
    items:        serializeItems(o.items),
    final_amount: o.final_amount ?? o.total_amount ?? 0,
  })));
}));

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({
    status:     'ok',
    uptime:     process.uptime(),
    sseClients: { admin: orderBroadcaster.size, tracking: trackingSSE.size },
    timestamp:  new Date().toISOString(),
  });
}));

// ── GLOBAL ERROR HANDLER ───────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Log with request context for easier debugging
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} —`, err.message || err);
  if (IS_PROD) {
    // Don't leak internal errors in production
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  } else {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', stack: err.stack });
  }
});

// ── CATCH-ALL (SPA) ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 COLONIAL running on http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🩺 Health: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`);
  server.close(async () => {
    try { await pool.end(); console.log('✅ DB pool closed'); } catch {}
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => { console.error('⚠️  Force exit after timeout'); process.exit(1); }, 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException',  (err)    => { console.error('Uncaught exception:', err); process.exit(1); });
