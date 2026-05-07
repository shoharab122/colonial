// server.js - PostgreSQL version with Cloudinary image hosting
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');
const pool = require('./db');
const cloudinary = require('cloudinary').v2;

// ------------------- Cloudinary Configuration -------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Debug: confirm which database config is used
console.log('🔌 DB connection using:', process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'local config');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colonial_super_secret_key_change_me';

// ------------------- PRODUCTION SESSION STORE (PostgreSQL) -------------------
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
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

// ------------------- PASSPORT SERIALIZATION -------------------
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
    done(null, rows[0]);
  } catch (err) { done(err); }
});

// ------------------- AUTH MIDDLEWARE -------------------
function authenticateToken(req, res, next) {
  let token = req.headers['authorization']?.split(' ')[1];
  if (!token && req.query.token) token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ------------------- IMAGE UPLOAD (Cloudinary) -------------------
// Use memory storage so we can pass buffer to Cloudinary
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  const mime = allowed.test(file.mimetype);
  if (ext && mime) cb(null, true);
  else cb(new Error('Only images allowed'));
};
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter });

app.post('/api/upload', authenticateToken, requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Convert buffer to base64 data URI
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'colonial_products',
      use_filename: true,
      unique_filename: true
    });

    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// ------------------- HELPER: images array to JSON -------------------
function imagesToJson(images) {
  if (images && Array.isArray(images) && images.length) return JSON.stringify(images);
  return null;
}

// ------------------- REAL-TIME ORDER EVENTS (SSE) -------------------
const orderClients = [];
app.get('/api/admin/order-events', authenticateToken, requireAdmin, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const clientId = Date.now();
  orderClients.push({ id: clientId, res });
  console.log(`SSE admin client connected: ${clientId}`);
  req.on('close', () => {
    const index = orderClients.findIndex(c => c.id === clientId);
    if (index !== -1) orderClients.splice(index, 1);
    console.log(`SSE admin client disconnected: ${clientId}`);
  });
});
function broadcastNewOrder(order) {
  console.log('Broadcasting new order:', order.order_number);
  orderClients.forEach(client => client.res.write(`data: ${JSON.stringify(order)}\n\n`));
}

// ------------------- CUSTOMER ORDER STATUS EVENTS (SSE) -------------------
const customerClients = new Map();
app.get('/api/customer/order-events', authenticateToken, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();
  const userId = req.user.id;
  if (!customerClients.has(userId)) customerClients.set(userId, []);
  customerClients.get(userId).push(res);
  console.log(`Customer SSE connected: user ${userId}`);
  req.on('close', () => {
    const clients = customerClients.get(userId);
    if (clients) {
      const index = clients.indexOf(res);
      if (index !== -1) clients.splice(index, 1);
      if (clients.length === 0) customerClients.delete(userId);
    }
    console.log(`Customer SSE disconnected: user ${userId}`);
  });
});
function broadcastToCustomer(userId, eventData) {
  const clients = customerClients.get(userId);
  if (!clients) return;
  clients.forEach(client => client.write(`data: ${JSON.stringify(eventData)}\n\n`));
}

// ------------------- HELPER: safe parse images -------------------
function safeParseImages(product) {
  if (product.images) {
    try {
      return JSON.parse(product.images);
    } catch(e) {
      console.error(`Invalid JSON in images for product ${product.id}:`, product.images);
      return [];
    }
  } else if (product.image_url) {
    return [product.image_url];
  }
  return [];
}

// ------------------- PRODUCTS (public) -------------------
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *, 
             (price - COALESCE(discount_amount, 0)) as final_price,
             ROUND(((discount_amount / price) * 100), 0) as discount_percent
      FROM products 
      WHERE is_active = true 
      ORDER BY created_at DESC
    `);
    const products = rows.map(p => ({
      ...p,
      materials: p.materials ? p.materials.split(',') : [],
      colors: p.colors ? p.colors.split(',') : [],
      images: safeParseImages(p)
    }));
    res.json(products);
  } catch (err) {
    console.error('Products fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/search', async (req, res) => {
  const { q = '', category = 'all', sort = 'newest', page = 1, limit = 8 } = req.query;
  let sql = `
    SELECT *, 
           (price - COALESCE(discount_amount, 0)) as final_price,
           ROUND(((discount_amount / price) * 100), 0) as discount_percent
    FROM products 
    WHERE is_active = true
  `;
  const params = [];
  let paramIndex = 1;
  if (q) { sql += ` AND name LIKE $${paramIndex}`; params.push(`%${q}%`); paramIndex++; }
  if (category && category !== 'all') { sql += ` AND category = $${paramIndex}`; params.push(category); paramIndex++; }
  if (sort === 'price_asc') sql += ' ORDER BY final_price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY final_price DESC';
  else sql += ' ORDER BY created_at DESC';
  const offset = (parseInt(page) - 1) * parseInt(limit);
  sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex+1}`;
  params.push(parseInt(limit), offset);
  try {
    const { rows } = await pool.query(sql, params);
    const products = rows.map(p => ({
      ...p,
      materials: p.materials ? p.materials.split(',') : [],
      colors: p.colors ? p.colors.split(',') : [],
      images: safeParseImages(p)
    }));
    let countSql = 'SELECT COUNT(*) as total FROM products WHERE is_active = true';
    const countParams = [];
    let countIndex = 1;
    if (q) { countSql += ` AND name LIKE $${countIndex}`; countParams.push(`%${q}%`); countIndex++; }
    if (category && category !== 'all') { countSql += ` AND category = $${countIndex}`; countParams.push(category); }
    const { rows: countRows } = await pool.query(countSql, countParams);
    const total = parseInt(countRows[0].total);
    res.json({ products, total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *, 
             (price - COALESCE(discount_amount, 0)) as final_price,
             ROUND(((discount_amount / price) * 100), 0) as discount_percent,
             COALESCE(avg_rating, 0) as avg_rating,
             COALESCE(review_count, 0) as review_count
      FROM products 
      WHERE id = $1 AND is_active = true
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const p = rows[0];
    p.materials = p.materials ? p.materials.split(',') : [];
    p.colors = p.colors ? p.colors.split(',') : [];
    p.images = safeParseImages(p);
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- ADMIN PRODUCT MANAGEMENT -------------------
app.post('/api/products', authenticateToken, requireAdmin, async (req, res) => {
  const { name, price, discount_amount, category, image_url, images, badge, description, materials, colors, care, stock } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO products 
       (name, price, discount_amount, category, image_url, images, badge, description, materials, colors, care, stock) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [name, price, discount_amount || 0, category, image_url || '/placeholder.jpg', 
       imagesToJson(images), badge || null, description || '',
       (materials || []).join(','), (colors || []).join(','), care || null, stock || 0]
    );
    res.status(201).json({ id: result.rows[0].id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, price, discount_amount, category, image_url, images, badge, description, materials, colors, care, stock, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE products SET 
        name = $1, price = $2, discount_amount = $3, category = $4, image_url = $5, images = $6,
        badge = $7, description = $8, materials = $9, colors = $10, care = $11, stock = $12, is_active = $13
       WHERE id = $14`,
      [name, price, discount_amount || 0, category, image_url || '/placeholder.jpg', 
       imagesToJson(images), badge || null, description || '',
       (materials || []).join(','), (colors || []).join(','), care || null, stock || 0,
       is_active !== undefined ? is_active : true, req.params.id]
    );
    res.json({ id: req.params.id, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id/variants', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM product_variants WHERE product_id = $1', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- COUPONS -------------------
app.post('/api/validate-coupon', async (req, res) => {
  const { code, cartTotal } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coupons 
       WHERE code = $1 AND is_active = true 
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
      [code]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Invalid or expired coupon' });
    const coupon = rows[0];
    if (cartTotal < coupon.min_order_amount) return res.status(400).json({ error: `Minimum order amount BDT ${coupon.min_order_amount} required` });
    let discount = coupon.discount_type === 'percentage' ? (cartTotal * coupon.discount_value) / 100 : coupon.discount_value;
    discount = Math.min(discount, cartTotal);
    res.json({ code: coupon.code, discount, discount_type: coupon.discount_type, discount_value: coupon.discount_value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- ORDERS (with payment) -------------------
app.post('/api/orders', async (req, res) => {
  let userEmail = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userEmail = decoded.email;
    } catch (err) { /* ignore */ }
  }

  const { 
    customer_name, customer_email, customer_phone, shipping_address, 
    total_amount, discount_applied, final_amount, items, 
    coupon_code, notes, 
    payment_method, transaction_id 
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    console.error('❌ Order rejected: items is missing or empty', { items });
    return res.status(400).json({ error: 'Cart is empty. Cannot place order.' });
  }

  console.log(`📦 Received order with ${items.length} item(s):`, JSON.stringify(items, null, 2));

  const finalEmail = userEmail || customer_email;
  const order_number = 'COL-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  
  let payment_status = 'pending';
  if (payment_method === 'cash_on_delivery') {
    payment_status = 'pending';
  } else if (payment_method === 'bkash' || payment_method === 'nagad') {
    payment_status = 'awaiting_verification';
  }

  try {
    const result = await pool.query(
      `INSERT INTO orders 
       (order_number, customer_name, customer_email, customer_phone, shipping_address, 
        total_amount, discount_applied, final_amount, items, notes, 
        payment_method, transaction_id, payment_status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [order_number, customer_name, finalEmail, customer_phone || null, shipping_address || null, 
       total_amount, discount_applied || 0, final_amount, JSON.stringify(items), notes || null,
       payment_method || 'cash_on_delivery', transaction_id || null, payment_status]
    );

    if (coupon_code) {
      await pool.query('UPDATE coupons SET used_count = used_count + 1 WHERE code = $1', [coupon_code]);
    }

    await pool.query(
      `INSERT INTO customers (email, name, phone, total_orders, total_spent, last_order_at) 
       VALUES ($1, $2, $3, 1, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO UPDATE SET 
         total_orders = customers.total_orders + 1, 
         total_spent = customers.total_spent + $4,
         last_order_at = CURRENT_TIMESTAMP`,
      [finalEmail, customer_name, customer_phone, final_amount]
    );

    for (const item of items) {
      await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.id]);
    }

    broadcastNewOrder({
      id: result.rows[0].id, order_number, customer_name, customer_email: finalEmail, 
      final_amount, payment_status, created_at: new Date().toISOString()
    });

    res.status(201).json({ id: result.rows[0].id, order_number, payment_status });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------- ADMIN ORDERS & STATS -------------------
app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    const sanitized = rows.map(order => {
      let itemsStr;
      if (order.items === null || order.items === undefined) {
        itemsStr = '[]';
      } else if (typeof order.items === 'string') {
        itemsStr = order.items;
      } else {
        itemsStr = JSON.stringify(order.items);
      }
      return {
        ...order,
        items: itemsStr,
        final_amount: order.final_amount !== null && order.final_amount !== undefined ? order.final_amount : (order.total_amount || 0)
      };
    });
    res.json(sanitized);
  } catch (err) {
    console.error('Orders fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    const { rows: orderRows } = await pool.query('SELECT customer_email FROM orders WHERE id = $1', [req.params.id]);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    await pool.query('UPDATE orders SET order_status = $1 WHERE id = $2', [status, req.params.id]);
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email = $1', [orderRows[0].customer_email]);
    if (userRows.length > 0) {
      broadcastToCustomer(userRows[0].id, { type: 'order_status_update', orderId: parseInt(req.params.id), newStatus: status });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/orders/:id/payment-status', authenticateToken, requireAdmin, async (req, res) => {
  const { payment_status } = req.body;
  const validStatuses = ['pending', 'awaiting_verification', 'paid', 'failed'];
  if (!validStatuses.includes(payment_status)) {
    return res.status(400).json({ error: 'Invalid payment status' });
  }
  try {
    const result = await pool.query('UPDATE orders SET payment_status = $1 WHERE id = $2', [payment_status, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    const { rows: orderRows } = await pool.query('SELECT customer_email FROM orders WHERE id = $1', [req.params.id]);
    if (orderRows.length) {
      const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email = $1', [orderRows[0].customer_email]);
      if (userRows.length) {
        broadcastToCustomer(userRows[0].id, { 
          type: 'payment_status_update', 
          orderId: parseInt(req.params.id), 
          paymentStatus: payment_status 
        });
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- STATS -------------------
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows: productRows } = await pool.query('SELECT COUNT(*) as totalProducts FROM products WHERE is_active = true');
    const { rows: orderRows } = await pool.query(`
      SELECT COUNT(*) as totalOrders,
             COALESCE(SUM(COALESCE(final_amount, total_amount, 0)), 0) as revenue
      FROM orders
      WHERE order_status != 'cancelled'
    `);
    const { rows: lowStockRows } = await pool.query('SELECT COUNT(*) as lowStock FROM products WHERE stock < 5 AND is_active = true');
    res.json({
      totalProducts: parseInt(productRows[0].totalproducts),
      totalOrders: parseInt(orderRows[0].totalorders),
      revenue: Number(orderRows[0].revenue).toFixed(2),
      lowStock: parseInt(lowStockRows[0].lowstock)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- WISHLIST -------------------
app.get('/api/wishlist', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, 
              (p.price - COALESCE(p.discount_amount, 0)) as final_price,
              ROUND(((p.discount_amount / p.price) * 100), 0) as discount_percent
       FROM wishlist w
       JOIN products p ON w.product_id = p.id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    const products = rows.map(p => ({
      ...p,
      images: safeParseImages(p)
    }));
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wishlist', authenticateToken, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'Product ID required' });
  try {
    await pool.query('INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, product_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wishlist/:product_id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2', [req.user.id, req.params.product_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- REVIEWS -------------------
app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, u.name as reviewer_name 
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
  const userId = req.user.id;
  const userName = req.user.name || 'Anonymous';
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  try {
    const { rows: existing } = await pool.query('SELECT id FROM reviews WHERE product_id = $1 AND user_id = $2', [productId, userId]);
    if (existing.length) return res.status(409).json({ error: 'You already reviewed this product' });
    await pool.query(
      'INSERT INTO reviews (product_id, user_id, user_name, rating, comment) VALUES ($1, $2, $3, $4, $5)',
      [productId, userId, userName, rating, comment || '']
    );
    await pool.query(`
      UPDATE products p
      SET avg_rating = (SELECT AVG(rating) FROM reviews WHERE product_id = p.id),
          review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id)
      WHERE p.id = $1
    `, [productId]);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- ADMIN REVIEWS & WISHLISTS -------------------
app.get('/api/admin/reviews', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, 
             p.name as product_name, 
             u.email as user_email, 
             u.name as user_name
      FROM reviews r
      LEFT JOIN products p ON r.product_id = p.id
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Admin reviews fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/reviews/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows: review } = await pool.query('SELECT product_id FROM reviews WHERE id = $1', [req.params.id]);
    if (review.length === 0) return res.status(404).json({ error: 'Review not found' });
    const productId = review[0].product_id;
    await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    await pool.query(`
      UPDATE products p
      SET avg_rating = (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE product_id = p.id),
          review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = p.id)
      WHERE p.id = $1
    `, [productId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wishlists', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT w.id, w.user_id, w.product_id, w.created_at,
             p.name as product_name, 
             p.price as product_price,
             p.image_url,
             u.email as user_email,
             u.name as user_name
      FROM wishlist w
      LEFT JOIN products p ON w.product_id = p.id
      LEFT JOIN users u ON w.user_id = u.id
      ORDER BY w.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Admin wishlists fetch error:', err);
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

// ------------------- AUTHENTICATION -------------------
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.length > 0) return res.status(409).json({ error: 'Email already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role',
      [email, hashedPassword, name || null, 'customer']
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- CUSTOMER ORDERS -------------------
app.get('/api/customer/orders', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC', [req.user.email]);
    const sanitized = rows.map(order => {
      let itemsStr;
      if (order.items === null || order.items === undefined) {
        itemsStr = '[]';
      } else if (typeof order.items === 'string') {
        itemsStr = order.items;
      } else {
        itemsStr = JSON.stringify(order.items);
      }
      return {
        ...order,
        items: itemsStr,
        final_amount: order.final_amount !== null && order.final_amount !== undefined ? order.final_amount : (order.total_amount || 0)
      };
    });
    res.json(sanitized);
  } catch (err) {
    console.error('Customer orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------- CATCH-ALL -------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------- START SERVER -------------------
app.listen(PORT, () => {
  console.log(`🚀 COLONIAL server running on http://localhost:${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin.html`);
});