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
 *   POST   /api/admin/forgot-password   — Request password reset link (dispatches email)
 *   POST   /api/admin/reset-password    — Set new password using single-use reset token
 *   POST   /api/admin/logout            — Clear authentication cookie
 *   GET    /api/admin/me                — Verify current admin session from cookie
 *   POST   /api/admin/change-password   — Change password for authenticated admin
 *   GET    /api/admin/stats             — Dashboard metrics from Supabase
 *   GET    /api/admin/orders            — List orders with search/filter
 *   GET    /api/admin/orders/:id        — Get single order details with signed URLs
 *   PATCH  /api/admin/orders/:id        — Update order/payment status
 *   GET    /api/admin/orders/:id/sequence — Stream sequence file
 */

import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  supabase,
  getSignedFileUrl,
  downloadStorageText,
  downloadStorageBuffer,
  mapOrderRowToModel,
} from '../supabase.js';
import {
  adminLoginLimiter,
  adminForgotPasswordLimiter,
  adminResetPasswordLimiter,
  adminEndpointsLimiter,
} from '../middleware/security.js';
import { sendPasswordResetEmail } from '../services/email.js';
import { getStoreSettings, updateStoreSettings } from '../services/settingsService.js';

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

// ── POST /api/admin/forgot-password ──────────────────────────────────────────
router.post('/forgot-password', adminForgotPasswordLimiter, async (req, res) => {
  const genericSuccessMsg = 'If this email is registered as an administrator, a password reset link has been sent.';

  try {
    const { email } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Look up admin in Supabase
    const { data: admin, error: queryError } = await supabase
      .from('admins')
      .select('id, email')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (queryError) {
      console.error('[admin] Database error looking up admin for password reset:', queryError.message);
      // Return 200 with generic message to prevent oracle/timing disclosure
      return res.json({ success: true, message: genericSuccessMsg });
    }

    // Do NOT reveal whether the email exists
    if (!admin) {
      return res.json({ success: true, message: genericSuccessMsg });
    }

    // Generate cryptographically secure random reset token
    const rawToken = crypto.randomBytes(32).toString('hex');

    // Store ONLY the SHA-256 hash of the token in Supabase
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Token expires after 30 minutes
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('admins')
      .update({
        reset_token_hash: tokenHash,
        reset_token_expires: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', admin.id);

    if (updateError) {
      console.error('[admin] Failed to save reset token hash:', updateError.message);
      return res.json({ success: true, message: genericSuccessMsg });
    }

    // Send reset email with reset link
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
    const resetUrl = `${clientOrigin.replace(/\/$/, '')}/admin/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({
      to: admin.email,
      resetUrl,
    });

    console.log(`[admin] Password reset link dispatched for administrator account`);

    // Never return the reset token in the API response
    return res.json({
      success: true,
      message: genericSuccessMsg,
    });
  } catch (err) {
    console.error('[admin] Forgot password error:', err.message);
    return res.status(500).json({ error: 'Unable to process password reset request at this time.' });
  }
});

// ── POST /api/admin/reset-password ───────────────────────────────────────────
router.post('/reset-password', adminResetPasswordLimiter, async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body || {};

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    // Hash incoming token to match stored hash
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    // Find admin by token hash
    const { data: admin, error: queryError } = await supabase
      .from('admins')
      .select('id, email, reset_token_hash, reset_token_expires')
      .eq('reset_token_hash', tokenHash)
      .maybeSingle();

    if (queryError) {
      console.error('[admin] Database error during password reset verification:', queryError.message);
      return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    if (!admin || !admin.reset_token_expires) {
      return res.status(400).json({ error: 'Invalid or expired password reset link' });
    }

    // Verify token has not expired
    const isExpired = new Date(admin.reset_token_expires) < new Date();
    if (isExpired) {
      // Invalidate the expired token immediately
      await supabase
        .from('admins')
        .update({
          reset_token_hash: null,
          reset_token_expires: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', admin.id);

      return res.status(400).json({ error: 'Password reset link has expired. Please request a new one.' });
    }

    // Hash the new password with bcrypt (salt rounds 12)
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update admins table: new password_hash, delete reset_token_hash and reset_token_expires (single-use!)
    const { error: updateError } = await supabase
      .from('admins')
      .update({
        password_hash: passwordHash,
        reset_token_hash: null,
        reset_token_expires: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', admin.id);

    if (updateError) {
      console.error('[admin] Database error updating password hash:', updateError.message);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    console.log(`[admin] Password successfully reset for admin: ${admin.email}`);

    return res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (err) {
    console.error('[admin] Reset password error:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while resetting password' });
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

// ── GET /api/admin/settings ──────────────────────────────────────────────────
router.get('/settings', async (_req, res) => {
  try {
    const settings = await getStoreSettings();
    res.json({
      success: true,
      settings,
      eight_color_enabled: settings.eight_color_enabled,
      eightColorEnabled: settings.eightColorEnabled,
    });
  } catch (err) {
    console.error('[admin] Error fetching store settings:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to retrieve settings' : err.message });
  }
});

// ── PATCH /api/admin/settings ────────────────────────────────────────────────
// Allows admin to change: eight_color_enabled
router.patch('/settings', async (req, res) => {
  try {
    const { eight_color_enabled, eightColorEnabled } = req.body || {};

    const targetValue = eight_color_enabled !== undefined ? eight_color_enabled : eightColorEnabled;

    if (targetValue === undefined) {
      return res.status(400).json({
        error: 'eight_color_enabled is required and must be a boolean.',
      });
    }

    if (
      typeof targetValue !== 'boolean' &&
      targetValue !== 'true' &&
      targetValue !== 'false'
    ) {
      return res.status(400).json({
        error: 'eight_color_enabled must be a boolean (true or false).',
      });
    }

    const updated = await updateStoreSettings({ eight_color_enabled: targetValue });
    console.log(`[admin] Updated 8-color generation setting to: ${updated.eight_color_enabled} by ${req.admin?.email}`);

    res.json({
      success: true,
      message: 'Store settings updated successfully',
      settings: updated,
      eight_color_enabled: updated.eight_color_enabled,
      eightColorEnabled: updated.eightColorEnabled,
    });
  } catch (err) {
    console.error('[admin] Error updating store settings:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Failed to update settings' : err.message });
  }
});

// ── POST /api/admin/change-password ──────────────────────────────────────────
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Current password is required' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    // Fetch current admin password hash from Supabase
    const { data: admin, error: queryError } = await supabase
      .from('admins')
      .select('id, email, password_hash')
      .eq('id', req.admin.id)
      .maybeSingle();

    if (queryError || !admin) {
      console.error('[admin] Failed to fetch admin record for change password:', queryError?.message);
      return res.status(500).json({ error: 'Service temporarily unavailable' });
    }

    // Verify current password with bcrypt
    const isCurrentValid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!isCurrentValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password with bcrypt (salt rounds 12)
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update in Supabase
    const { error: updateError } = await supabase
      .from('admins')
      .update({
        password_hash: passwordHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', admin.id);

    if (updateError) {
      console.error('[admin] Database error saving changed password:', updateError.message);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    console.log(`[admin] Password changed successfully for admin: ${admin.email}`);

    return res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (err) {
    console.error('[admin] Change password error:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while changing password' });
  }
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
