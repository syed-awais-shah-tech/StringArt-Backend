/**
 * admin.js — Protected Admin API Route with Supabase Database & JWT Cookie Authentication
 *
 * Authentication:
 *   - Admin credentials stored as bcrypt hashes in Supabase `admins` table.
 *   - JWT issued upon successful authentication.
 *   - JWT stored ONLY in an HttpOnly, Secure, SameSite cookie.
 *   - No tokens in response bodies, localStorage, or headers.
 *
 * Routes:
 *   POST   /api/admin/login             — Authenticate admin & issue HttpOnly JWT cookie
 *   POST   /api/admin/logout            — Clear authentication cookie
 *   GET    /api/admin/me                — Verify current admin session from cookie
 *   GET    /api/admin/stats             — Dashboard metrics from Supabase
 *   GET    /api/admin/orders            — List orders with search/filter
 *   GET    /api/admin/orders/:id        — Get single order details with signed URLs
 *   PATCH  /api/admin/orders/:id        — Update order/payment status
 *   GET    /api/admin/orders/:id/sequence — Stream sequence file
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  supabase,
  getSignedFileUrl,
  downloadStorageText,
  downloadStorageBuffer,
  mapOrderRowToModel,
} from '../supabase.js';
import { adminLoginLimiter, adminEndpointsLimiter } from '../middleware/security.js';

const router = Router();

// Cookie and JWT Configuration
export const ADMIN_COOKIE_NAME = 'admin_jwt';
export const JWT_SECRET = process.env.JWT_SECRET || 'stringart_default_jwt_secret_dev_only';
const isProduction = process.env.NODE_ENV === 'production';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'none' : 'lax',
  maxAge: 8 * 60 * 60 * 1000, // 8 hours
  path: '/',
};

// ── Auth Middleware ──────────────────────────────────────────────────────────
export function requireAdminAuth(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized: Admin access required',
      code: 'AUTH_REQUIRED',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name || 'Store Administrator',
    };
    next();
  } catch (err) {
    return res.status(401).json({
      error: 'Unauthorized: Session expired or invalid',
      code: 'INVALID_TOKEN',
    });
  }
}

// ── POST /api/admin/login ────────────────────────────────────────────────────
router.post('/login', adminLoginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Query admin in Supabase
    const { data: admin, error: queryError } = await supabase
      .from('admins')
      .select('id, email, password_hash, name')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (queryError) {
      console.error('[admin] Database error during login query:', queryError.message);
      return res.status(500).json({ error: 'Authentication service temporarily unavailable' });
    }

    if (!admin || !admin.password_hash) {
      return res.status(401).json({ error: 'Invalid admin email or password' });
    }

    // Verify password with bcrypt
    const passwordValid = await bcrypt.compare(password, admin.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid admin email or password' });
    }

    // Issue JWT with 8-hour expiry
    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        name: admin.name || 'Store Administrator',
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Set HttpOnly Secure SameSite cookie
    res.cookie(ADMIN_COOKIE_NAME, token, COOKIE_OPTIONS);

    console.log(`[admin] Admin successfully authenticated: ${admin.email}`);

    // Return admin details ONLY — NEVER return JWT token in the response JSON
    return res.json({
      success: true,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name || 'Store Administrator',
      },
    });
  } catch (err) {
    console.error('[admin] Login error:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred during login' });
  }
});

// ── POST /api/admin/logout ───────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
  res.clearCookie(ADMIN_COOKIE_NAME, clearOptions);
  res.json({ success: true, message: 'Logged out successfully' });
});

// ── Apply general admin rate limiter & auth to all following routes ───────────
router.use(adminEndpointsLimiter);
router.use(requireAdminAuth);

// ── GET /api/admin/me ────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  res.json({
    authenticated: true,
    admin: req.admin,
  });
});

// ── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get('/stats', async (_req, res) => {
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
router.get('/orders', async (req, res) => {
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
router.get('/orders/:id', async (req, res) => {
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
router.patch('/orders/:id', async (req, res) => {
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
router.get('/orders/:id/sequence', async (req, res) => {
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
