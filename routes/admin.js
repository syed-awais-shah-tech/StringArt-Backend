/**
 * admin.js — Protected Admin API Route (Powered by Supabase)
 *
 * Routes:
 *   POST   /api/admin/login             — Authenticate admin
 *   GET    /api/admin/me                — Verify current admin session
 *   POST   /api/admin/logout            — Invalidate session
 *   GET    /api/admin/stats             — Dashboard metrics from Supabase
 *   GET    /api/admin/orders            — List orders with search/filter
 *   GET    /api/admin/orders/:id        — Get single order details with signed URLs
 *   PATCH  /api/admin/orders/:id        — Update order/payment status
 *   GET    /api/admin/orders/:id/sequence — Stream sequence file
 */

import { Router } from 'express';
import crypto from 'crypto';
import {
  supabase,
  getSignedFileUrl,
  downloadStorageText,
  downloadStorageBuffer,
  mapOrderRowToModel,
} from '../supabase.js';

const router = Router();

// Default admin credentials (configurable via environment)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@stringart.io';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory session store (token -> session)
const activeSessions = new Map();

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
router.get('/stats', requireAdminAuth, async (_req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('orders')
      .select('order_status, price');

    if (error) {
      console.error('[admin] Error fetching stats from Supabase:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const orders = rows || [];
    const totalOrders = orders.length;
    const newOrders = orders.filter((o) => o.order_status === 'new').length;
    const inProductionOrders = orders.filter((o) => o.order_status === 'in_production').length;
    const shippedOrders = orders.filter((o) => o.order_status === 'shipped').length;
    const deliveredOrders = orders.filter((o) => o.order_status === 'delivered').length;
    const cancelledOrders = orders.filter((o) => o.order_status === 'cancelled').length;

    const totalRevenue = orders
      .filter((o) => o.order_status !== 'cancelled')
      .reduce((sum, o) => sum + (Number(o.price) || 0), 0);

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
  } catch (err) {
    console.error('[admin] Stats exception:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch dashboard stats' });
  }
});

// ── GET /api/admin/orders ────────────────────────────────────────────────────
router.get('/orders', requireAdminAuth, async (req, res) => {
  try {
    const { search, status } = req.query;

    let query = supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    // Status filter
    if (status && status !== 'all') {
      query = query.eq('order_status', status);
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('[admin] Error querying orders from Supabase:', error.message);
      return res.status(500).json({ error: error.message });
    }

    let orders = (rows || []).map((r) => mapOrderRowToModel(r));

    // Search filter across orderNumber, customer name, city, phone
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
  } catch (err) {
    console.error('[admin] Orders listing exception:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve orders' });
  }
});

// ── GET /api/admin/orders/:id ────────────────────────────────────────────────
router.get('/orders/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: row, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('order_number', id.trim())
      .single();

    if (error || !row) {
      return res.status(404).json({ error: `Order ${id} not found` });
    }

    // Generate signed URLs for private files in Supabase Storage
    const [originalImageUrl, previewImageUrl, sequenceFileUrl, sequenceFileContent] = await Promise.all([
      row.original_file_path ? getSignedFileUrl(row.original_file_path, 7200) : null,
      row.preview_file_path ? getSignedFileUrl(row.preview_file_path, 7200) : null,
      row.sequence_file_path ? getSignedFileUrl(row.sequence_file_path, 7200) : null,
      row.sequence_file_path ? downloadStorageText(row.sequence_file_path).catch(() => null) : null,
    ]);

    const order = mapOrderRowToModel(row, {
      originalImageUrl,
      previewImageUrl,
      sequenceFileUrl,
    });

    res.json({
      order: {
        ...order,
        sequenceFileContent,
      },
    });
  } catch (err) {
    console.error('[admin] Order detail exception:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve order details' });
  }
});

// ── PATCH /api/admin/orders/:id ──────────────────────────────────────────────
router.patch('/orders/:id', requireAdminAuth, async (req, res) => {
  try {
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

    const updates = {
      updated_at: new Date().toISOString(),
    };
    if (orderStatus) updates.order_status = orderStatus;
    if (paymentStatus) updates.payment_status = paymentStatus;

    const { data: updatedRow, error } = await supabase
      .from('orders')
      .update(updates)
      .ilike('order_number', id.trim())
      .select()
      .single();

    if (error || !updatedRow) {
      return res.status(404).json({ error: `Order ${id} not found or update failed: ${error?.message}` });
    }

    const order = mapOrderRowToModel(updatedRow);

    console.log(`[admin] Updated order ${order.orderNumber} in Supabase: status=${order.orderStatus}, payment=${order.paymentStatus}`);

    res.json({
      success: true,
      order,
    });
  } catch (err) {
    console.error('[admin] Update order exception:', err);
    res.status(500).json({ error: err.message || 'Failed to update order' });
  }
});

// ── GET /api/admin/orders/:id/sequence ───────────────────────────────────────
router.get('/orders/:id/sequence', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: row, error } = await supabase
      .from('orders')
      .select('order_number, sequence_file_path')
      .ilike('order_number', id.trim())
      .single();

    if (error || !row || !row.sequence_file_path) {
      return res.status(404).json({ error: 'Sequence file not found for this order' });
    }

    const buffer = await downloadStorageBuffer(row.sequence_file_path);
    if (!buffer) {
      return res.status(404).json({ error: 'Sequence file missing in Supabase storage' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${row.order_number}-sequence.txt"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(buffer);
  } catch (err) {
    console.error('[admin] Sequence download exception:', err);
    res.status(500).json({ error: err.message || 'Failed to download sequence file' });
  }
});

export default router;
