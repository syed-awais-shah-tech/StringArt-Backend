/**
 * admin.js — Protected Admin API Route (Powered by Supabase)
 *
 * Routes:
 *   POST   /api/admin/login             — Authenticate admin (Rate-limited, timing-safe)
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
import { adminLoginLimiter, adminEndpointsLimiter } from '../middleware/security.js';

const router = Router();

// Admin credentials MUST come from environment variables — no hardcoded fallback
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.warn(
    '[admin] ⚠️ ADMIN_EMAIL or ADMIN_PASSWORD is not set in environment variables.\n' +
    'Admin login will be disabled until configured.'
  );
}

// In-memory session store (token -> session)
const activeSessions = new Map();

/**
 * Constant-time string comparison to prevent timing-attack side channels.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Constant time check against itself to avoid leaking length difference timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
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
router.post('/login', adminLoginLimiter, (req, res) => {
  const { email, password } = req.body || {};

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('[admin] Admin login attempted but ADMIN_EMAIL/ADMIN_PASSWORD is not configured.');
    return res.status(500).json({ error: 'Admin service authentication is not configured.' });
  }

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const emailMatches = safeCompare(email.trim().toLowerCase(), ADMIN_EMAIL.trim().toLowerCase());
  const passwordMatches = safeCompare(password, ADMIN_PASSWORD);

  if (emailMatches && passwordMatches) {
    const token = 'sat_' + crypto.randomBytes(32).toString('hex');
    const sessionData = {
      email: ADMIN_EMAIL,
      name: 'Store Administrator',
      loginTime: new Date().toISOString(),
    };

    activeSessions.set(token, sessionData);

    console.log(`[admin] Admin successfully authenticated: ${ADMIN_EMAIL}`);
    return res.json({
      success: true,
      token,
      admin: sessionData, // Never returns password
    });
  }

  // Failed login: Never log the attempted password
  console.warn(`[admin] Failed login attempt for email: ${String(email).slice(0, 50)}`);
  return res.status(401).json({
    error: 'Invalid admin email or password',
  });
});

// ── Apply general admin rate limiter & auth to all following routes ───────────
router.use(adminEndpointsLimiter);

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
      console.error('[admin] Error fetching stats:', error.message);
      return res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
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
    console.error('[admin] Stats exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to fetch dashboard statistics' : err.message });
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
      query = query.eq('order_status', String(status).slice(0, 32));
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('[admin] Error querying orders:', error.message);
      return res.status(500).json({ error: 'Failed to retrieve orders' });
    }

    let orders = (rows || []).map((r) => mapOrderRowToModel(r));

    // Search filter across orderNumber, customer name, city, phone
    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase().slice(0, 64);
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
    console.error('[admin] Orders listing exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to retrieve orders' : err.message });
  }
});

// ── GET /api/admin/orders/:id ────────────────────────────────────────────────
router.get('/orders/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = String(id).trim().slice(0, 32);

    const { data: row, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('order_number', sanitizedId)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: `Order ${sanitizedId} not found` });
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
    console.error('[admin] Order detail exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to retrieve order details' : err.message });
  }
});

// ── PATCH /api/admin/orders/:id ──────────────────────────────────────────────
router.patch('/orders/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = String(id).trim().slice(0, 32);
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
      .ilike('order_number', sanitizedId)
      .select()
      .single();

    if (error || !updatedRow) {
      return res.status(404).json({ error: `Order ${sanitizedId} not found or update failed` });
    }

    const order = mapOrderRowToModel(updatedRow);

    console.log(`[admin] Updated order ${order.orderNumber}: status=${order.orderStatus}, payment=${order.paymentStatus}`);

    res.json({
      success: true,
      order,
    });
  } catch (err) {
    console.error('[admin] Update order exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to update order' : err.message });
  }
});

// ── GET /api/admin/orders/:id/sequence ───────────────────────────────────────
router.get('/orders/:id/sequence', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sanitizedId = String(id).trim().slice(0, 32);

    const { data: row, error } = await supabase
      .from('orders')
      .select('order_number, sequence_file_path')
      .ilike('order_number', sanitizedId)
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
    console.error('[admin] Sequence download exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to download sequence file' : err.message });
  }
});

export default router;
