 // server.js - COLONIAL E-Commerce Backend
// PostgreSQL + Cloudinary + JWT Auth + SSE + Coupons
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const passport   = require('passport');
const multer     = require('multer');
const pool       = require('./db');
const cloudinary = require('cloudinary').v2;

// ── CLOUDINARY CONFIG ──────────────────────────────────────────
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.warn('⚠️  Cloudinary credentials missing — image uploads will fail.');
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  console.log('✅ Cloudinary configured');
}

console.log('🔌 DB:', process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'local config');

// ── APP SETUP ──────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colonial_super_secret_key_change_me';

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'colonial_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));

// ── PASSPORT ───────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
    done(null, rows[0] || null);
  } catch (err) { done(err); }
});

// ── AUTH MIDDLEWARE ────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const token = (req.headers['authorization']?.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── MULTER / IMAGE UPLOAD ──────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    /jpeg|jpg|png|gif|webp/.test(path.extname(file.originalname).toLowerCase()) &&
    /jpeg|jpg|png|gif|webp/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only images allowed (jpeg, jpg, png, gif, webp)'));
  }
});

app.post('/api/upload', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!process.env.CLOUDINARY_CLOUD_NAME)
    return res.status(500).json({ error: 'Cloudinary not configured' });
  try {
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const result = await cloudinary.uploader.upload(
      `data:${req.file.mimetype};base64,${b64}`,
      { folder: 'colonial_products', use_filename: true, unique_filename: true }
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
      const parsed = typeof product.images === 'string'
        ? JSON.parse(product.images) : product.images;
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

// ── SSE: ADMIN ORDER EVENTS ───────────────────────────────────
const orderClients = [];
app.get('/api/admin/order-events', authenticateToken, requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':   'keep-alive'
  });
  res.flushHeaders();
  const client = { id: Date.now(), res };
  orderClients.push(client);
  req.on('close', () => {
    const i = orderClients.findIndex(c => c.id === client.id);
    if (i !== -1) orderClients.splice(i, 1);
  });
});
function broadcastNewOrder(order) {
  orderClients.forEach(c => c.res.write(`data: ${JSON.stringify(order)}\n\n`));
}

// ── SSE: CUSTOMER ORDER STATUS ────────────────────────────────
const customerClients = new Map();
app.get('/api/customer/order-events', authenticateToken, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':   'keep-alive'
  });
  res.flushHeaders();
  const userId = req.user.id;
  if (!customerClients.has(userId)) customerClients.set(userId, []);
  customerClients.get(userId).push(res);
  req.on('close', () => {
    const list = customerClients.get(userId) || [];
    const i = list.indexOf(res);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) customerClients.delete(userId);
  });
});
function broadcastToCustomer(userId, data) {
  (customerClients.get(userId) || [])
    .forEach(c => c.write(`data: ${JSON.stringify(data)}\n\n`));
}

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
const mapProduct = (p) => ({
  ...p,
  materials: p.materials ? p.materials.split(',').map(s => s.trim()) : [],
  colors:    p.colors    ? p.colors.split(',').map(s => s.trim())    : [],
  images:    safeParseImages(p)
});

// GET all active products
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      PRODUCT_SELECT + ' WHERE is_active = true ORDER BY created_at DESC'
    );
    res.json(rows.map(mapProduct));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET products with search / filter / pagination
app.get('/api/products/search', async (req, res) => {
  const { q = '', category = 'all', sort = 'newest', page = 1, limit = 8 } = req.query;
  const params = [];
  let where = ' WHERE is_active = true';
  if (q)                     { params.push(`%${q}%`);    where += ` AND name ILIKE $${params.length}`; }
  if (category !== 'all')    { params.push(category);     where += ` AND category = $${params.length}`; }
  const orderBy = sort === 'price_asc'  ? 'final_price ASC'
               : sort === 'price_desc' ? 'final_price DESC'
               : 'created_at DESC';
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.push(parseInt(limit), offset);
  const sql = PRODUCT_SELECT + where + ` ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  try {
    const { rows }            = await pool.query(sql, params);
    const countParams         = params.slice(0, -2);
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM products` + where, countParams
    );
    const total = parseInt(countRows[0].total);
    res.json({
      products:   rows.map(mapProduct),
      total, page: parseInt(page), limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      PRODUCT_SELECT + ` , COALESCE(avg_rating,0) AS avg_r, COALESCE(review_count,0) AS rev_c
       WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(mapProduct(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create product (admin)
app.post('/api/products', authenticateToken, requireAdmin, async (req, res) => {
  const { name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO products
         (name, price, discount_amount, category, image_url, images,
          badge, description, materials, colors, care, stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [name, price, discount_amount || 0, category,
       image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
       imagesToJson(images), badge || null, description || '',
       (materials || []).join(','), (colors || []).join(','),
       care || null, stock || 0]
    );
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
    await pool.query(
      `UPDATE products SET
         name=$1, price=$2, discount_amount=$3, category=$4,
         image_url=$5, images=$6, badge=$7, description=$8,
         materials=$9, colors=$10, care=$11, stock=$12, is_active=$13
       WHERE id=$14`,
      [name, price, discount_amount || 0, category,
       image_url || (Array.isArray(images) && images[0]) || '/placeholder.jpg',
       imagesToJson(images), badge || null, description || '',
       (materials || []).join(','), (colors || []).join(','),
       care || null, stock || 0,
       is_active !== undefined ? is_active : true,
       req.params.id]
    );
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE product (admin)
app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
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
    if (!rows.length)
      return res.status(404).json({ error: 'Invalid or expired coupon' });
    const coupon = rows[0];
    const total  = parseFloat(cartTotal);
    if (total < parseFloat(coupon.min_order_amount))
      return res.status(400).json({
        error: `Minimum order amount BDT ${coupon.min_order_amount} required`
      });
    let discount = coupon.discount_type === 'percentage'
      ? (total * parseFloat(coupon.discount_value)) / 100
      : parseFloat(coupon.discount_value);
    discount = Math.min(parseFloat(discount.toFixed(2)), total);
    res.json({
      code:           coupon.code,
      discount,
      discount_type:  coupon.discount_type,
      discount_value: parseFloat(coupon.discount_value)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════
app.post('/api/orders', async (req, res) => {
  // Optional: extract email from JWT if logged in
  let userEmail = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try { userEmail = jwt.verify(authHeader.split(' ')[1], JWT_SECRET).email; }
    catch { /* guest order */ }
  }

  const {
    customer_name, customer_email, customer_phone, shipping_address,
    total_amount, discount_applied, final_amount, items,
    coupon_code, notes,
    payment_method, transaction_id,
    delivery_method, delivery_fee
  } = req.body;

  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Cart is empty. Cannot place order.' });

  const finalEmail   = userEmail || customer_email;
  const order_number = `COL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const payment_status =
    payment_method === 'bkash' || payment_method === 'nagad'
      ? 'awaiting_verification'
      : 'pending';

  try {
    // ── INSERT ORDER (coupon_code included) ────────────────────
    const { rows } = await pool.query(
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
        parseFloat(total_amount)          || 0,
        parseFloat(discount_applied)      || 0,
        parseFloat(final_amount)          || 0,
        JSON.stringify(items),
        coupon_code ? coupon_code.toUpperCase().trim() : null,
        notes || null,
        payment_method || 'cash_on_delivery',
        transaction_id || null,
        payment_status,
        delivery_method || null,
        parseFloat(delivery_fee)          || 0
      ]
    );
    const orderId = rows[0].id;

    // ── INCREMENT COUPON USAGE ─────────────────────────────────
    if (coupon_code) {
      await pool.query(
        'UPDATE coupons SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)',
        [coupon_code.trim()]
      );
    }

    // ── UPSERT CUSTOMER ANALYTICS ──────────────────────────────
    await pool.query(
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

    // ── DECREMENT STOCK ────────────────────────────────────────
    await Promise.all(
      items.map(item =>
        pool.query(
          'UPDATE products SET stock = GREATEST(stock - $1, 0) WHERE id = $2',
          [item.quantity, item.id]
        )
      )
    );

    // ── BROADCAST TO ADMIN SSE ─────────────────────────────────
    broadcastNewOrder({
      id: orderId, order_number, customer_name,
      customer_email: finalEmail, final_amount,
      payment_status, delivery_method, delivery_fee,
      created_at: new Date().toISOString()
    });

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
      final_amount: o.final_amount ?? o.total_amount ?? 0
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT order status (admin) + broadcast to customer
app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const valid = ['pending','confirmed','shipped','delivered','cancelled'];
  if (!valid.includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows: orderRows } = await pool.query(
      'UPDATE orders SET order_status = $1 WHERE id = $2 RETURNING customer_email',
      [status, req.params.id]
    );
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found' });
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1', [orderRows[0].customer_email]
    );
    if (userRows.length)
      broadcastToCustomer(userRows[0].id, {
        type: 'order_status_update',
        orderId: parseInt(req.params.id),
        newStatus: status
      });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT payment status (admin)
app.put('/api/admin/orders/:id/payment-status', authenticateToken, requireAdmin, async (req, res) => {
  const { payment_status } = req.body;
  const valid = ['pending','awaiting_verification','paid','failed'];
  if (!valid.includes(payment_status))
    return res.status(400).json({ error: 'Invalid payment status' });
  try {
    const { rows } = await pool.query(
      'UPDATE orders SET payment_status = $1 WHERE id = $2 RETURNING customer_email',
      [payment_status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1', [rows[0].customer_email]
    );
    if (userRows.length)
      broadcastToCustomer(userRows[0].id, {
        type: 'payment_status_update',
        orderId: parseInt(req.params.id),
        paymentStatus: payment_status
      });
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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET admin stats
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [products, orders, lowStock] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM products WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) AS n,
                         COALESCE(SUM(COALESCE(final_amount, total_amount, 0)),0) AS revenue
                  FROM orders WHERE order_status != 'cancelled'`),
      pool.query('SELECT COUNT(*) AS n FROM products WHERE stock < 5 AND is_active = true')
    ]);
    res.json({
      totalProducts: parseInt(products.rows[0].n),
      totalOrders:   parseInt(orders.rows[0].n),
      revenue:       Number(orders.rows[0].revenue).toFixed(2),
      lowStock:      parseInt(lowStock.rows[0].n)
    });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        code.toUpperCase().trim(),
        discount_type,
        parseFloat(discount_value),
        parseFloat(min_order_amount) || 0,
        usage_limit && parseInt(usage_limit) > 0 ? parseInt(usage_limit) : null,
        valid_from || null,
        valid_to   || null,
        is_active !== false
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
        code.toUpperCase().trim(),
        discount_type,
        parseFloat(discount_value),
        parseFloat(min_order_amount) || 0,
        usage_limit && parseInt(usage_limit) > 0 ? parseInt(usage_limit) : null,
        valid_from || null,
        valid_to   || null,
        is_active !== false,
        req.params.id
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wishlist/:product_id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [req.user.id, req.params.product_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
         avg_rating   = (SELECT AVG(rating)   FROM reviews WHERE product_id = $1),
         review_count = (SELECT COUNT(*)       FROM reviews WHERE product_id = $1)
       WHERE id = $1`,
      [productId]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: list all reviews
app.get('/api/admin/reviews', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.name AS product_name,
              u.email AS user_email, u.name AS user_name
       FROM reviews r
       LEFT JOIN products p ON r.product_id = p.id
       LEFT JOIN users u    ON r.user_id    = u.id
       ORDER BY r.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: delete review + recalculate rating
app.delete('/api/admin/reviews/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM reviews WHERE id = $1 RETURNING product_id', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Review not found' });
    await pool.query(
      `UPDATE products SET
         avg_rating   = COALESCE((SELECT AVG(rating) FROM reviews WHERE product_id = $1),0),
         review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = $1)
       WHERE id = $1`,
      [rows[0].product_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/wishlist/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM wishlist WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
      [email, hashed, name || null, 'customer']
    );
    const user  = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      final_amount: o.final_amount ?? o.total_amount ?? 0
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CATCH-ALL & START
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 COLONIAL running on http://localhost:${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin.html`);
});
