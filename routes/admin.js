/**
 * admin.js — Protected Admin API Route
 *
 * Routes:
 *   POST   /api/admin/login             — Authenticate admin
 *   GET    /api/admin/me                — Verify current admin session
 *   POST   /api/admin/logout            — Invalidate session
 *   GET    /api/admin/stats             — Dashboard metrics
 *   GET    /api/admin/orders            — List orders with search/filter
 *   GET    /api/admin/orders/:id        — Get single order details
 *   PATCH  /api/admin/orders/:id        — Update order/payment status
 *   GET    /api/admin/orders/:id/sequence — Download sequence file
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ORDERS_UPLOADS_DIR = path.join(DATA_DIR, 'orders');

// Default admin credentials (configurable via environment)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@stringart.io';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory session store (token -> session)
const activeSessions = new Map();

// Helper to read orders safely
function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[admin] Error reading orders.json:', err);
    return [];
  }
}

// Helper to write orders atomically
function writeOrders(orders) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
  } catch (err) {
    console.error('[admin] Error writing orders.json:', err);
  }
}

// ── Auth Middleware ──────────────────────────────────────────────────────────
export function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.headers['x-admin-token'] || req.query.token;

  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({
      error: 'Unauthorized: Admin access required',
      code: 'AUTH_REQUIRED',
    });
  }

  req.admin = activeSessions.get(token);
  next();
}

// ── POST /api/admin/login ────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (
    email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
    password === ADMIN_PASSWORD
  ) {
    const token = 'sat_' + crypto.randomBytes(32).toString('hex');
    const sessionData = {
      email: ADMIN_EMAIL,
      name: 'Store Administrator',
      loginTime: new Date().toISOString(),
    };

    activeSessions.set(token, sessionData);

    console.log(`[admin] Admin successfully logged in: ${ADMIN_EMAIL}`);
    return res.json({
      success: true,
      token,
      admin: sessionData,
    });
  }

  return res.status(401).json({
    error: 'Invalid admin email or password',
  });
});

// ── GET /api/admin/me ────────────────────────────────────────────────────────
router.get('/me', requireAdminAuth, (req, res) => {
  res.json({
    authenticated: true,
    admin: req.admin,
  });
});

// ── POST /api/admin/logout ───────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-admin-token'];
  if (token) {
    activeSessions.delete(token);
  }
  res.json({ success: true, message: 'Logged out successfully' });
});

// ── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get('/stats', requireAdminAuth, (_req, res) => {
  const orders = readOrders();

  const totalOrders = orders.length;
  const newOrders = orders.filter((o) => o.orderStatus === 'new').length;
  const inProductionOrders = orders.filter((o) => o.orderStatus === 'in_production').length;
  const shippedOrders = orders.filter((o) => o.orderStatus === 'shipped').length;
  const deliveredOrders = orders.filter((o) => o.orderStatus === 'delivered').length;
  const cancelledOrders = orders.filter((o) => o.orderStatus === 'cancelled').length;

  const totalRevenue = orders
    .filter((o) => o.orderStatus !== 'cancelled')
    .reduce((sum, o) => sum + (Number(o.product?.price) || 0), 0);

  res.json({
    stats: {
      totalOrders,
      newOrders,
      inProductionOrders,
      shippedOrders,
      deliveredOrders,
      cancelledOrders,
      totalRevenue,
    },
  });
});

// ── GET /api/admin/orders ────────────────────────────────────────────────────
router.get('/orders', requireAdminAuth, (req, res) => {
  const { search, status } = req.query;
  let orders = readOrders();

  // Sort descending by creation date (newest first)
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Filter by status if provided
  if (status && status !== 'all') {
    orders = orders.filter((o) => o.orderStatus === status);
  }

  // Filter by search query (orderNumber or customer name)
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    orders = orders.filter((o) => {
      const numMatch = o.orderNumber?.toLowerCase().includes(q);
      const nameMatch = o.customer?.fullName?.toLowerCase().includes(q);
      const cityMatch = o.customer?.city?.toLowerCase().includes(q);
      const phoneMatch = o.customer?.phone?.toLowerCase().includes(q);
      return numMatch || nameMatch || cityMatch || phoneMatch;
    });
  }

  res.json({
    total: orders.length,
    orders,
  });
});

// ── GET /api/admin/orders/:id ────────────────────────────────────────────────
router.get('/orders/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const orders = readOrders();
  const order = orders.find(
    (o) => o.orderNumber?.toLowerCase() === id.toLowerCase()
  );

  if (!order) {
    return res.status(404).json({ error: `Order ${id} not found` });
  }

  // Check if sequence file exists and read content preview if needed
  let sequenceFileContent = null;
  if (order.files?.sequenceFile) {
    const seqPath = path.join(DATA_DIR, order.files.sequenceFile);
    if (fs.existsSync(seqPath)) {
      sequenceFileContent = fs.readFileSync(seqPath, 'utf-8');
    }
  }

  res.json({
    order: {
      ...order,
      sequenceFileContent,
    },
  });
});

// ── PATCH /api/admin/orders/:id ──────────────────────────────────────────────
router.patch('/orders/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { orderStatus, paymentStatus } = req.body || {};

  const validOrderStatuses = ['new', 'confirmed', 'in_production', 'shipped', 'delivered', 'cancelled'];
  const validPaymentStatuses = ['pending', 'paid', 'refunded', 'cancelled'];

  if (orderStatus && !validOrderStatuses.includes(orderStatus)) {
    return res.status(400).json({
      error: `Invalid orderStatus. Must be one of: ${validOrderStatuses.join(', ')}`,
    });
  }

  if (paymentStatus && !validPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({
      error: `Invalid paymentStatus. Must be one of: ${validPaymentStatuses.join(', ')}`,
    });
  }

  const orders = readOrders();
  const orderIndex = orders.findIndex(
    (o) => o.orderNumber?.toLowerCase() === id.toLowerCase()
  );

  if (orderIndex === -1) {
    return res.status(404).json({ error: `Order ${id} not found` });
  }

  const order = orders[orderIndex];

  if (orderStatus) {
    order.orderStatus = orderStatus;
  }
  if (paymentStatus) {
    order.paymentStatus = paymentStatus;
  }
  order.updatedAt = new Date().toISOString();

  orders[orderIndex] = order;
  writeOrders(orders);

  console.log(`[admin] Updated order ${order.orderNumber}: status=${order.orderStatus}, payment=${order.paymentStatus}`);

  res.json({
    success: true,
    order,
  });
});

// ── GET /api/admin/orders/:id/sequence ───────────────────────────────────────
router.get('/orders/:id/sequence', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const orders = readOrders();
  const order = orders.find(
    (o) => o.orderNumber?.toLowerCase() === id.toLowerCase()
  );

  if (!order || !order.files?.sequenceFile) {
    return res.status(404).json({ error: 'Sequence file not found for this order' });
  }

  const seqPath = path.join(DATA_DIR, order.files.sequenceFile);
  if (!fs.existsSync(seqPath)) {
    return res.status(404).json({ error: 'Sequence file missing on disk' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${order.orderNumber}-sequence.txt"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fs.createReadStream(seqPath).pipe(res);
});

export default router;
