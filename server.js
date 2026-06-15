// server.js — COLONIAL E-Commerce Backend (Optimised)
// PostgreSQL + Cloudinary + JWT Auth + SSE + Coupons
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

// ── NODEMAILER CONFIG ──────────────────────────────────────────
const nodemailer = require('nodemailer');
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendOrderConfirmation({ order_number, customer_name, customer_email, items, final_amount, payment_method, delivery_method, delivery_fee }) {
  if (!customer_email) return;
  const payLabel = payment_method === 'bkash' ? 'bKash' : payment_method === 'nagad' ? 'Nagad' : 'Cash on Delivery';
  const deliveryLabel = delivery_method === 'inside_dhaka' ? 'Inside Dhaka' : delivery_method === 'outside_dhaka' ? 'Outside Dhaka' : delivery_method || 'Standard';

  const itemRows = (Array.isArray(items) ? items : JSON.parse(items)).map(i => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e8e2d9;font-size:13px;">${i.name}${i.size ? ` <span style="color:#8a7d6e;font-size:11px;">(${i.size})</span>` : ''}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e8e2d9;text-align:center;font-size:13px;">${i.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e8e2d9;text-align:right;font-size:13px;">BDT ${(parseFloat(i.price) * parseInt(i.quantity)).toLocaleString()}</td>
    </tr>`).join('');

  await mailer.sendMail({
    from: `"Colonial" <${process.env.EMAIL_USER}>`,
    to: customer_email,
    subject: `Order Confirmed — ${order_number}`,
    html: `
    <div style="max-width:580px;margin:0 auto;background:#faf7f2;font-family:'Georgia',serif;color:#3e362e;padding:48px 40px;">
      <div style="text-align:center;margin-bottom:32px;">
        <h1 style="font-size:26px;font-weight:400;letter-spacing:.18em;margin:0 0 4px;">COLONIAL</h1>
        <p style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8a7d6e;margin:0;">Chittagong, Bangladesh</p>
      </div>

      <hr style="border:none;border-top:1px solid #d9c4a8;margin:0 0 32px;">

      <p style="font-size:15px;font-weight:400;margin:0 0 6px;">Thank you, ${customer_name}.</p>
      <p style="font-size:13px;color:#6b5e52;margin:0 0 24px;line-height:1.6;">Your order has been received and is now being processed. We'll notify you once it ships.</p>

      <div style="background:#f2ece3;border:1px solid #e0d5c5;border-radius:3px;padding:14px 18px;margin-bottom:28px;">
        <p style="margin:0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8a7d6e;">Order Number</p>
        <p style="margin:4px 0 0;font-size:17px;letter-spacing:.06em;color:#3e362e;">${order_number}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead>
          <tr style="border-bottom:2px solid #d9c4a8;">
            <th style="text-align:left;padding-bottom:10px;font-weight:400;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a7d6e;">Item</th>
            <th style="text-align:center;padding-bottom:10px;font-weight:400;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a7d6e;">Qty</th>
            <th style="text-align:right;padding-bottom:10px;font-weight:400;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a7d6e;">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding-top:14px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a7d6e;">Delivery (${deliveryLabel})</td>
            <td style="padding-top:14px;text-align:right;font-size:13px;">BDT ${parseFloat(delivery_fee || 0).toLocaleString()}</td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:10px;font-size:13px;letter-spacing:.06em;">Total</td>
            <td style="padding-top:10px;text-align:right;font-size:18px;font-weight:600;letter-spacing:.04em;">BDT ${parseFloat(final_amount).toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>

      <hr style="border:none;border-top:1px solid #d9c4a8;margin:28px 0;">

      <p style="font-size:12px;color:#8a7d6e;margin:0 0 6px;">Payment method: <strong style="color:#3e362e;">${payLabel}</strong></p>
      ${payment_method === 'bkash' || payment_method === 'nagad'
        ? `<p style="font-size:12px;color:#8a7d6e;margin:0 0 20px;">Your payment is awaiting verification. We'll confirm once checked.</p>`
        : `<p style="font-size:12px;color:#8a7d6e;margin:0 0 20px;">Payment will be collected upon delivery.</p>`}

      <hr style="border:none;border-top:1px solid #d9c4a8;margin:0 0 24px;">
      <p style="font-size:11px;color:#a09080;text-align:center;letter-spacing:.06em;margin:0;">Questions? Reply to this email or message us on Facebook.<br>© Colonial, Chittagong</p>
    </div>`
  });
}

// ── CLOUDINARY CONFIG ──────────────────────────────────────────
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('⚠️  Cloudinary credentials missing — image uploads will fail.');
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('✅ Cloudinary configured');
}
console.log('🔌 DB:', process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'local config');

// ── APP SETUP ──────────────────────────────────────────────────
const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colonial_super_secret_key_change_me';

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(compression()); // gzip all responses
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Static files with aggressive caching for immutable assets
app.use(express.static('public', {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'colonial_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' },
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

// ── SIMPLE IN-MEMORY CACHE (for stats & product lists) ─────────
const cache = new Map();
function setCache(key, value, ttlMs = 30_000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}
function invalidateCache(...keys) {
  keys.forEach(k => cache.delete(k));
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── MULTER / IMAGE UPLOAD ──────────────────────────────────────
const ALLOWED_EXT  = /\.(jpeg|jpg|png|gif|webp)$/i;
const ALLOWED_MIME = /^image\/(jpeg|png|gif|webp)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extOk  = ALLOWED_EXT.test(path.extname(file.originalname));
    const mimeOk = ALLOWED_MIME.test(file.mimetype);
    cb(extOk && mimeOk ? null : new Error('Only images allowed (jpeg, jpg, png, gif, webp)'), extOk && mimeOk);
  },
});

app.post('/api/upload', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!process.env.CLOUDINARY_CLOUD_NAME) return res.status(500).json({ error: 'Cloudinary not configured' });
  try {
    const b64    = req.file.buffer.toString('base64');
    const result = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${b64}`,
      { folder: 'colonial_products', use_filename: true, unique_filename: true, resource_type: 'image' }
    );
    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'Image upload failed: ' + err.message });
  }
});

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

// ── SSE MANAGER ────────────────────────────────────────────────
// Uses a Set instead of array for O(1) removal
class SSEBroadcaster {
  constructor() { this.clients = new Set(); }
  add(res, cleanup) {
    const client = { res, cleanup };
    this.clients.add(client);
    return () => { client.cleanup?.(); this.clients.delete(client); };
  }
  broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const { res } of this.clients) {
      try { res.write(payload); } catch { /* client disconnected */ }
    }
  }
}

const orderBroadcaster = new SSEBroadcaster();
// Per-user customer SSE
const customerSSE = new Map(); // userId -> Set<res>

function addCustomerClient(userId, res) {
  if (!customerSSE.has(userId)) customerSSE.set(userId, new Set());
  customerSSE.get(userId).add(res);
}
function removeCustomerClient(userId, res) {
  const set = customerSSE.get(userId);
  if (set) { set.delete(res); if (!set.size) customerSSE.delete(userId); }
}
function broadcastToCustomer(userId, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const set = customerSSE.get(userId);
  if (set) for (const res of set) { try { res.write(payload); } catch {} }
}

function initSSEResponse(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx: disable buffering
  });
  res.flushHeaders();
  // Heartbeat every 25s to prevent proxy timeouts
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  return hb;
}

// Admin SSE
app.get('/api/admin/order-events', authenticateToken, requireAdmin, (req, res) => {
  const hb    = initSSEResponse(res);
  const remove = orderBroadcaster.add(res);
  req.on('close', () => { clearInterval(hb); remove(); });
});

// Customer SSE
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
app.get('/api/products', async (req, res) => {
  const cached = getCache('products:all');
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(
      PRODUCT_SELECT + ' WHERE is_active = true ORDER BY created_at DESC'
    );
    const result = rows.map(mapProduct);
    setCache('products:all', result, 30_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET products with search / filter / pagination
app.get('/api/products/search', async (req, res) => {
  const { q = '', category = 'all', sort = 'newest', page = 1, limit = 8 } = req.query;
  const params = [];
  let where = ' WHERE is_active = true';

  if (q)              { params.push(`%${q}%`); where += ` AND name ILIKE $${params.length}`; }
  if (category !== 'all') { params.push(category); where += ` AND category = $${params.length}`; }

  const orderBy = sort === 'price_asc' ? 'final_price ASC'
                : sort === 'price_desc' ? 'final_price DESC'
                : 'created_at DESC';
  const lim    = Math.min(parseInt(limit) || 8, 100);
  const offset = (Math.max(parseInt(page), 1) - 1) * lim;
  params.push(lim, offset);

  const dataSql  = PRODUCT_SELECT + where + ` ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const countSql = `SELECT COUNT(*) AS total FROM products` + where;
  const countP   = params.slice(0, -2);

  try {
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(dataSql, params),
      pool.query(countSql, countP),
    ]);
    const total = parseInt(countRows[0].total);
    res.json({
      products:   rows.map(mapProduct),
      total,
      page:       parseInt(page),
      limit:      lim,
      totalPages: Math.ceil(total / lim),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single product
app.get('/api/products/:id', async (req, res) => {
  const cacheKey = `product:${req.params.id}`;
  const cached   = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const { rows } = await pool.query(
      PRODUCT_SELECT + ' WHERE id = $1 AND is_active = true', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    const result = mapProduct(rows[0]);
    setCache(cacheKey, result, 60_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create product (admin)
app.post('/api/products', authenticateToken, requireAdmin, async (req, res) => {
  const { name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock } = req.body;
  if (!name || !price || !category)
    return res.status(400).json({ error: 'name, price and category are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO products
         (name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        name, price, discount_amount || 0, category,
        image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
        imagesToJson(images), badge || null, description || '',
        (materials || []).join(','), (colors || []).join(','),
        care || null, stock || 0,
      ]
    );
    invalidateCache('products:all', 'stats');
    res.status(201).json({ id: rows[0].id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update product (admin)
app.put('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock, is_active } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE products SET
         name=$1, price=$2, discount_amount=$3, category=$4,
         image_url=$5, images=$6, badge=$7, description=$8,
         materials=$9, colors=$10, care=$11, stock=$12, is_active=$13
       WHERE id=$14`,
      [
        name, price, discount_amount || 0, category,
        image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
        imagesToJson(images), badge || null, description || '',
        (materials || []).join(','), (colors || []).join(','),
        care || null, stock || 0,
        is_active !== undefined ? is_active : true,
        req.params.id,
      ]
    );
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    invalidateCache('products:all', `product:${req.params.id}`, 'stats');
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE product (admin)
app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    invalidateCache('products:all', `product:${req.params.id}`, 'stats');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Product variants (stub — kept for compatibility)
app.get('/api/products/:id/variants', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = $1', [req.params.id]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ═══════════════════════════════════════════════════════════════
// COUPONS — PUBLIC VALIDATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/validate-coupon', async (req, res) => {
  const { code, cartTotal } = req.body;
  if (!code || cartTotal === undefined)
    return res.status(400).json({ error: 'code and cartTotal are required' });
  try {
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
    const total  = parseFloat(cartTotal);
    const minAmt = parseFloat(coupon.min_order_amount);

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════
app.post('/api/orders', async (req, res) => {
  let userEmail = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try { userEmail = jwt.verify(authHeader.split(' ')[1], JWT_SECRET).email; } catch { /* guest */ }
  }

  const {
    customer_name, customer_email, customer_phone, shipping_address,
    total_amount, discount_applied, final_amount, items,
    coupon_code, notes,
    payment_method, transaction_id,
    delivery_method, delivery_fee,
  } = req.body;

  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Cart is empty. Cannot place order.' });

  const finalEmail    = userEmail || customer_email;
  const order_number  = `COL-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const payment_status = (payment_method === 'bkash' || payment_method === 'nagad')
    ? 'awaiting_verification' : 'pending';

  try {
    // All DB work in a transaction for consistency
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
          order_number, customer_name, finalEmail, customer_phone || null,
          shipping_address || null,
          parseFloat(total_amount)     || 0,
          parseFloat(discount_applied) || 0,
          parseFloat(final_amount)     || 0,
          JSON.stringify(items),
          coupon_code ? coupon_code.toUpperCase().trim() : null,
          notes || null,
          payment_method   || 'cash_on_delivery',
          transaction_id   || null,
          payment_status,
          delivery_method  || null,
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
        [finalEmail, customer_name, customer_phone || null, parseFloat(final_amount) || 0]
      );

      // Decrement stock — batch with unnest for efficiency
      if (items.length) {
        const ids  = items.map(i => i.id);
        const qtys = items.map(i => i.quantity);
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

    invalidateCache('products:all', 'stats');
    orderBroadcaster.broadcast({
      id: orderId, order_number, customer_name,
      customer_email: finalEmail, final_amount,
      payment_status, delivery_method, delivery_fee,
      created_at: new Date().toISOString(),
    });

    // ── SEND CONFIRMATION EMAIL (non-blocking) ─────────────────
    if (finalEmail) {
      sendOrderConfirmation({
        order_number, customer_name,
        customer_email: finalEmail,
        items, final_amount,
        payment_method, delivery_method, delivery_fee,
      }).catch(err => console.error('Confirmation email error:', err));
    }

    res.status(201).json({ id: orderId, order_number, payment_status });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET admin all orders
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    res.json(rows.map(o => ({
      ...o,
      items:        serializeItems(o.items),
      final_amount: o.final_amount ?? o.total_amount ?? 0,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT order status (admin) + broadcast to customer
app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const VALID_STATUSES = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);
  const { status } = req.body;
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await pool.query(
      'UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING customer_email',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    // Fire-and-forget customer lookup + SSE broadcast
    pool.query('SELECT id FROM users WHERE email = $1', [rows[0].customer_email])
      .then(({ rows: u }) => {
        if (u.length) broadcastToCustomer(u[0].id, {
          type: 'order_status_update', orderId: parseInt(req.params.id), newStatus: status,
        });
      }).catch(() => {});

    invalidateCache('stats');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT payment status (admin)
app.put('/api/admin/orders/:id/payment-status', authenticateToken, requireAdmin, async (req, res) => {
  const VALID_PAY = new Set(['pending', 'awaiting_verification', 'paid', 'failed']);
  const { payment_status } = req.body;
  if (!VALID_PAY.has(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
  try {
    const { rows } = await pool.query(
      'UPDATE orders SET payment_status = $1 WHERE id = $2 RETURNING customer_email',
      [payment_status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    pool.query('SELECT id FROM users WHERE email = $1', [rows[0].customer_email])
      .then(({ rows: u }) => {
        if (u.length) broadcastToCustomer(u[0].id, {
          type: 'payment_status_update', orderId: parseInt(req.params.id), paymentStatus: payment_status,
        });
      }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE order (admin)
app.delete('/api/admin/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Order not found' });
    invalidateCache('stats');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET admin stats (cached 30s, parallel queries)
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  const cached = getCache('stats');
  if (cached) return res.json(cached);
  try {
    const [products, orders, lowStock] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM products WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) AS n,
                         COALESCE(SUM(COALESCE(final_amount, total_amount, 0)), 0) AS revenue
                  FROM orders WHERE order_status != 'cancelled'`),
      pool.query('SELECT COUNT(*) AS n FROM products WHERE stock < 5 AND is_active = true'),
    ]);
    const result = {
      totalProducts: parseInt(products.rows[0].n),
      totalOrders:   parseInt(orders.rows[0].n),
      revenue:       Number(orders.rows[0].revenue).toFixed(2),
      lowStock:      parseInt(lowStock.rows[0].n),
    };
    setCache('stats', result, 30_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN COUPONS CRUD
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/coupons', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/coupons', authenticateToken, requireAdmin, async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount,
          usage_limit, valid_from, valid_to, is_active } = req.body;
  if (!code || !discount_type || discount_value === undefined)
    return res.status(400).json({ error: 'code, discount_type and discount_value are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons
         (code, discount_type, discount_value, min_order_amount,
          usage_limit, valid_from, valid_to, is_active, used_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0) RETURNING *`,
      [
        code.toUpperCase().trim(), discount_type,
        parseFloat(discount_value), parseFloat(min_order_amount) || 0,
        usage_limit && parseInt(usage_limit) > 0 ? parseInt(usage_limit) : null,
        valid_from || null, valid_to || null, is_active !== false,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        usage_limit && parseInt(usage_limit) > 0 ? parseInt(usage_limit) : null,
        valid_from || null, valid_to || null, is_active !== false, req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/coupons/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Coupon not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// WISHLIST
// ═══════════════════════════════════════════════════════════════
app.get('/api/wishlist', authenticateToken, async (req, res) => {
  try {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wishlist', authenticateToken, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Product ID required' });
  try {
    await pool.query(
      'INSERT INTO wishlist (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.user.id, product_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/wishlist/:product_id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.product_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name AS reviewer_name
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products/:id/reviews', authenticateToken, async (req, res) => {
  const { rating, comment } = req.body;
  const productId = req.params.id;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating must be 1–5' });
  try {
    const { rows: ex } = await pool.query(
      'SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2',
      [productId, req.user.id]
    );
    if (ex.length) return res.status(409).json({ error: 'You already reviewed this product' });
    await pool.query(
      'INSERT INTO reviews (product_id, user_id, user_name, rating, comment) VALUES ($1,$2,$3,$4,$5)',
      [productId, req.user.id, req.user.name || 'Anonymous', rating, comment || '']
    );
    // Single query: update avg & count together
    await pool.query(
      `UPDATE products SET
         avg_rating   = (SELECT AVG(rating)  FROM reviews WHERE product_id = $1),
         review_count = (SELECT COUNT(*)      FROM reviews WHERE product_id = $1)
       WHERE id = $1`,
      [productId]
    );
    invalidateCache(`product:${productId}`, 'products:all');
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: list all reviews
app.get('/api/admin/reviews', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.name AS product_name,
              u.email AS user_email, u.name AS user_name
       FROM reviews r
       LEFT JOIN products p ON r.product_id = p.id
       LEFT JOIN users    u ON r.user_id    = u.id
       ORDER BY r.created_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete review + recalculate rating
app.delete('/api/admin/reviews/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
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
    invalidateCache(`product:${pid}`, 'products:all');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// WISHLISTS (Admin view)
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/wishlists', authenticateToken, requireAdmin, async (req, res) => {
  try {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/wishlist/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM wishlist WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Wishlist item not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows: ex } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (ex.length) return res.status(409).json({ error: 'Email already exists' });
    const hashed = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
      [email, hashed, name || null, 'customer']
    );
    const user  = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    if (!await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMER ORDERS
// ═══════════════════════════════════════════════════════════════
app.get('/api/customer/orders', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC',
      [req.user.email]
    );
    res.json(rows.map(o => ({
      ...o,
      items:        serializeItems(o.items),
      final_amount: o.final_amount ?? o.total_amount ?? 0,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GLOBAL ERROR HANDLER ───────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 COLONIAL running on http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin.html`);
});
