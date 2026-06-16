// server.js — COLONIAL E-Commerce Backend
// PostgreSQL + Cloudinary + JWT Auth + SSE + Coupons + Brevo Email
require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const crypto       = require('crypto');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const passport     = require('passport');
const multer       = require('multer');
const compression  = require('compression');
const nodemailer   = require('nodemailer');
const pool         = require('./db');
const cloudinary   = require('cloudinary').v2;

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

// ── BREVO EMAIL (via nodemailer SMTP) ──────────────────────────
const mailerReady = !!(process.env.BREVO_SMTP_KEY);
if (!mailerReady) {
  console.warn('⚠️  BREVO_SMTP_KEY not set — emails will be skipped.');
} else {
  console.log('✅ Brevo mailer configured');
}

const transporter = nodemailer.createTransport({
  host:   'smtp-relay.brevo.com',
  port:   587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_LOGIN || 'aee85c001@smtp-brevo.com',
    pass: process.env.BREVO_SMTP_KEY,
  },
});

const EMAIL_FROM      = process.env.EMAIL_FROM      || 'noreply@colonial.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'COLONIAL';
const APP_URL         = process.env.APP_URL         || 'http://localhost:3000';

async function sendEmail({ to, subject, html }) {
  if (!mailerReady) return;
  try {
    await transporter.sendMail({
      from:    `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to:      Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
    });
  } catch (err) {
    console.error('Brevo send error:', err.message);
  }
}

// ── EMAIL TEMPLATES ────────────────────────────────────────────
function emailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Georgia,serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0eb;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:4px;overflow:hidden;max-width:600px">
        <!-- Header -->
        <tr>
          <td style="background:#1a1a1a;padding:32px 40px;text-align:center">
            <h1 style="margin:0;color:#c9a96e;font-size:28px;letter-spacing:6px;font-weight:400">COLONIAL</h1>
            <p style="margin:8px 0 0;color:#999;font-size:11px;letter-spacing:3px;text-transform:uppercase">Timeless Elegance</p>
          </td>
        </tr>
        ${bodyHtml}
        <!-- Footer -->
        <tr>
          <td style="background:#f5f0eb;padding:24px 40px;text-align:center;border-top:1px solid #e8e0d5">
            <p style="margin:0;color:#999;font-size:12px;letter-spacing:1px">
              © ${new Date().getFullYear()} COLONIAL. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function goldBtn(link, label) {
  return `<table cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td>
    <a href="${link}"
       style="display:inline-block;background:#1a1a1a;color:#c9a96e;text-decoration:none;
              padding:14px 36px;font-size:13px;letter-spacing:2px;text-transform:uppercase;border-radius:2px">
      ${label}
    </a>
  </td></tr></table>`;
}

async function sendVerificationEmail(user, token) {
  const link = `${APP_URL}/api/auth/verify-email?token=${token}`;
  await sendEmail({
    to:      user.email,
    subject: 'Verify your COLONIAL account',
    html: emailShell(`
      <tr><td style="padding:48px 40px 32px">
        <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:22px;font-weight:400">
          Welcome${user.name ? ', ' + user.name : ''}
        </h2>
        <p style="margin:0 0 8px;color:#555;font-size:15px;line-height:1.7">
          Thank you for creating your COLONIAL account. Please verify your email address
          to complete registration.
        </p>
        ${goldBtn(link, 'Verify Email Address')}
        <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6">
          This link expires in <strong>24 hours</strong>.
          If you didn't create an account, you can safely ignore this email.
        </p>
        <p style="margin:12px 0 0;color:#bbb;font-size:11px;word-break:break-all">
          Or copy: <a href="${link}" style="color:#c9a96e">${link}</a>
        </p>
      </td></tr>`),
  });
}

async function sendOrderConfirmationEmail(order) {
  const {
    customer_name, customer_email, order_number,
    items, final_amount, payment_method,
    shipping_address, delivery_method, delivery_fee,
  } = order;

  const parsedItems = typeof items === 'string' ? JSON.parse(items) : (items || []);
  const payLabel = { cash_on_delivery: 'Cash on Delivery', bkash: 'bKash', nagad: 'Nagad' }[payment_method]
    || payment_method || 'N/A';

  const itemRows = parsedItems.map(item => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0ebe5;color:#333;font-size:14px">
        ${item.name}${item.color ? ` <span style="color:#999">(${item.color})</span>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #f0ebe5;color:#333;font-size:14px;text-align:center">
        ${item.quantity}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #f0ebe5;color:#333;font-size:14px;text-align:right">
        BDT ${(item.price * item.quantity).toLocaleString()}
      </td>
    </tr>`).join('');

  const deliveryRow = parseFloat(delivery_fee) > 0
    ? `<tr>
         <td style="color:#888;font-size:13px;padding:6px 0">Delivery Fee</td>
         <td style="color:#555;font-size:13px;text-align:right;padding:6px 0">
           BDT ${parseFloat(delivery_fee).toLocaleString()}
         </td>
       </tr>` : '';

  await sendEmail({
    to:      customer_email,
    subject: `Order Confirmed — ${order_number}`,
    html: emailShell(`
      <!-- Green banner -->
      <tr>
        <td style="background:#2d5a27;padding:18px 40px;text-align:center">
          <p style="margin:0;color:#fff;font-size:15px;letter-spacing:1px">✓ &nbsp;Your order has been confirmed</p>
        </td>
      </tr>
      <tr><td style="padding:40px 40px 32px">
        <p style="margin:0 0 8px;color:#555;font-size:15px">Dear ${customer_name},</p>
        <p style="margin:0 0 28px;color:#555;font-size:15px;line-height:1.7">
          Thank you for your order. We've received it and will begin processing shortly.
        </p>

        <!-- Order meta -->
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#f9f6f2;border-radius:4px;padding:20px;margin-bottom:28px">
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-bottom:4px">Order Number</td>
            <td style="color:#1a1a1a;font-size:15px;text-align:right;font-weight:bold">${order_number}</td>
          </tr>
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-top:12px">Payment</td>
            <td style="color:#555;font-size:14px;text-align:right;padding-top:12px">${payLabel}</td>
          </tr>
          ${delivery_method ? `
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-top:12px">Delivery</td>
            <td style="color:#555;font-size:14px;text-align:right;padding-top:12px">${delivery_method}</td>
          </tr>` : ''}
          ${shipping_address ? `
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-top:12px">Ship To</td>
            <td style="color:#555;font-size:14px;text-align:right;padding-top:12px">${shipping_address}</td>
          </tr>` : ''}
        </table>

        <!-- Items table -->
        <h3 style="margin:0 0 16px;color:#1a1a1a;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:400">
          Order Summary
        </h3>
        <table width="100%" cellpadding="0" cellspacing="0">
          <thead>
            <tr>
              <th style="color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:400;
                         padding-bottom:10px;border-bottom:2px solid #e8e0d5;text-align:left">Item</th>
              <th style="color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:400;
                         padding-bottom:10px;border-bottom:2px solid #e8e0d5;text-align:center">Qty</th>
              <th style="color:#888;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:400;
                         padding-bottom:10px;border-bottom:2px solid #e8e0d5;text-align:right">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <!-- Totals -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
          ${deliveryRow}
          <tr>
            <td style="color:#1a1a1a;font-size:16px;font-weight:bold;padding:14px 0 0;border-top:2px solid #1a1a1a">
              Total
            </td>
            <td style="color:#c9a96e;font-size:18px;font-weight:bold;text-align:right;padding:14px 0 0;border-top:2px solid #1a1a1a">
              BDT ${parseFloat(final_amount).toLocaleString()}
            </td>
          </tr>
        </table>

        <p style="margin:32px 0 0;color:#888;font-size:13px;line-height:1.7">
          Questions? Reply to this email and we'll be happy to help.
        </p>
      </td></tr>`),
  });
}

async function sendOrderStatusEmail(order, newStatus) {
  const cfg = {
    confirmed: { label: 'Confirmed', color: '#2d5a27', msg: 'Your order has been confirmed and is being prepared.' },
    shipped:   { label: 'Shipped',   color: '#1a4a7a', msg: 'Great news — your order is on its way!' },
    delivered: { label: 'Delivered', color: '#1a1a1a', msg: 'Your order has been delivered. We hope you love it!' },
    cancelled: { label: 'Cancelled', color: '#8b2020', msg: 'Your order has been cancelled. Contact us if you have questions.' },
  }[newStatus];
  if (!cfg) return;

  await sendEmail({
    to:      order.customer_email,
    subject: `Order ${cfg.label} — ${order.order_number}`,
    html: emailShell(`
      <tr>
        <td style="background:${cfg.color};padding:18px 40px;text-align:center">
          <p style="margin:0;color:#fff;font-size:15px;letter-spacing:1px">Order ${cfg.label}</p>
        </td>
      </tr>
      <tr><td style="padding:40px">
        <p style="margin:0 0 16px;color:#555;font-size:15px">Dear ${order.customer_name},</p>
        <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.7">${cfg.msg}</p>
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#f9f6f2;border-radius:4px;padding:20px">
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase">Order Number</td>
            <td style="color:#1a1a1a;font-size:15px;text-align:right;font-weight:bold">${order.order_number}</td>
          </tr>
          <tr>
            <td style="color:#888;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding-top:12px">Status</td>
            <td style="color:${cfg.color};font-size:14px;text-align:right;padding-top:12px;font-weight:bold">
              ${cfg.label}
            </td>
          </tr>
        </table>
      </td></tr>`),
  });
}

async function sendPasswordResetEmail(user, token) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  await sendEmail({
    to:      user.email,
    subject: 'Reset your COLONIAL password',
    html: emailShell(`
      <tr><td style="padding:48px 40px 32px">
        <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:22px;font-weight:400">Password Reset</h2>
        <p style="margin:0 0 8px;color:#555;font-size:15px;line-height:1.7">
          We received a request to reset the password for your COLONIAL account.
          Click below to choose a new password.
        </p>
        ${goldBtn(link, 'Reset Password')}
        <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6">
          This link expires in <strong>1 hour</strong>.
          If you didn't request this, you can safely ignore this email.
        </p>
      </td></tr>`),
  });
}

// ── APP SETUP ──────────────────────────────────────────────────
const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colonial_super_secret_key_change_me';

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

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

// ── SIMPLE IN-MEMORY CACHE ─────────────────────────────────────
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
const customerSSE = new Map();

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
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  return hb;
}

// Admin SSE
app.get('/api/admin/order-events', authenticateToken, requireAdmin, (req, res) => {
  const hb     = initSSEResponse(res);
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/search', async (req, res) => {
  const { q = '', category = 'all', sort = 'newest', page = 1, limit = 8 } = req.query;
  const params = [];
  let where = ' WHERE is_active = true';

  if (q)               { params.push(`%${q}%`); where += ` AND name ILIKE $${params.length}`; }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    invalidateCache('products:all', `product:${req.params.id}`, 'stats');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

  const finalEmail     = userEmail || customer_email;
  const order_number   = `COL-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const payment_status = (payment_method === 'bkash' || payment_method === 'nagad')
    ? 'awaiting_verification' : 'pending';

  try {
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
          payment_method  || 'cash_on_delivery',
          transaction_id  || null,
          payment_status,
          delivery_method || null,
          parseFloat(delivery_fee) || 0,
        ]
      );
      orderId = rows[0].id;

      if (coupon_code) {
        await client.query(
          'UPDATE coupons SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)',
          [coupon_code.trim()]
        );
      }

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

    // ✉️ Order confirmation email (fire-and-forget)
    sendOrderConfirmationEmail({
      customer_name, customer_email: finalEmail, order_number,
      items, final_amount, payment_method,
      shipping_address, delivery_method, delivery_fee,
    }).catch(console.error);

    res.status(201).json({ id: orderId, order_number, payment_status });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET admin all orders
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(rows.map(o => ({
      ...o,
      items:        serializeItems(o.items),
      final_amount: o.final_amount ?? o.total_amount ?? 0,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT order status (admin) + SSE broadcast + status email
app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const VALID_STATUSES = new Set(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']);
  const { status } = req.body;
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await pool.query(
      'UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    const updatedOrder = rows[0];

    // SSE broadcast to customer
    pool.query('SELECT id FROM users WHERE email = $1', [updatedOrder.customer_email])
      .then(({ rows: u }) => {
        if (u.length) broadcastToCustomer(u[0].id, {
          type: 'order_status_update', orderId: parseInt(req.params.id), newStatus: status,
        });
      }).catch(() => {});

    // ✉️ Status update email (fire-and-forget)
    sendOrderStatusEmail(updatedOrder, status).catch(console.error);

    invalidateCache('stats');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE order (admin)
app.delete('/api/admin/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Order not found' });
    invalidateCache('stats');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET admin stats
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// REGISTER — creates account + sends verification email
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows: ex } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (ex.length) return res.status(409).json({ error: 'Email already exists' });

    const hashed    = await bcrypt.hash(password, 12);
    const verifyTok = crypto.randomBytes(32).toString('hex');
    const verifyExp = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    const { rows } = await pool.query(
      `INSERT INTO users (email, password, name, role, verify_token, verify_token_exp)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, email, name, role`,
      [email, hashed, name || null, 'customer', verifyTok, verifyExp]
    );
    const user = rows[0];

    // ✉️ Verification email (fire-and-forget)
    sendVerificationEmail(user, verifyTok).catch(console.error);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({
      token, user,
      message: 'Account created. Please check your email to verify your address.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// VERIFY EMAIL — clicked from email link
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token required');
  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET email_verified = TRUE, verify_token = NULL, verify_token_exp = NULL
       WHERE verify_token = $1
         AND verify_token_exp > NOW()
         AND email_verified = FALSE
       RETURNING id`,
      [token]
    );
    if (!rows.length) return res.redirect(`${APP_URL}/?verified=invalid`);
    res.redirect(`${APP_URL}/?verified=success`);
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).send('Server error');
  }
});

// RESEND VERIFICATION
app.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, email_verified FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows.length)           return res.status(404).json({ error: 'User not found' });
    if (rows[0].email_verified) return res.status(400).json({ error: 'Email already verified' });

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'UPDATE users SET verify_token = $1, verify_token_exp = $2 WHERE id = $3',
      [token, expiry, req.user.id]
    );
    sendVerificationEmail(rows[0], token).catch(console.error);
    res.json({ message: 'Verification email resent.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FORGOT PASSWORD
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1', [email]
    );
    // Always 200 — prevents email enumeration
    if (!rows.length) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 h
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_exp = $2 WHERE id = $3',
      [token, expiry, rows[0].id]
    );
    sendPasswordResetEmail(rows[0], token).catch(console.error);
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RESET PASSWORD
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hashed = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `UPDATE users
       SET password = $1, reset_token = NULL, reset_token_exp = NULL
       WHERE reset_token = $2 AND reset_token_exp > NOW()
       RETURNING id`,
      [hashed, token]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link' });
    res.json({ message: 'Password updated successfully.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// LOGIN
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

// ME
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, email_verified FROM users WHERE id = $1', [req.user.id]
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
