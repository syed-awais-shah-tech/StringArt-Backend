/**
 * orders.js — Customer Order System (Cash on Delivery with Supabase)
 *
 * Routes:
 *   POST /api/orders      — Create a new customer order (Database + Storage)
 *   GET  /api/orders/:id  — Retrieve order details by order number
 *   GET  /api/orders      — List all orders (internal/admin)
 */

import { Router } from 'express';
import {
  supabase,
  ensureStorageBucket,
  uploadBase64ToStorage,
  uploadTextToStorage,
  mapOrderRowToModel,
} from '../supabase.js';

const router = Router();

/**
 * Generate sequential order number e.g. SA-1001, SA-1002 from Supabase orders table
 */
async function generateNextOrderNumber() {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('order_number')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.warn('[orders] Could not query latest order numbers from Supabase:', error.message);
      return `SA-${1001 + Math.floor(Math.random() * 8000)}`;
    }

    const existingNums = (data || [])
      .map((o) => {
        const match = typeof o.order_number === 'string' && o.order_number.match(/^SA-(\d+)$/i);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((n) => n !== null && !isNaN(n));

    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1001;
    return `SA-${nextNum}`;
  } catch (err) {
    console.error('[orders] Error generating order number:', err.message);
    return `SA-${Date.now().toString().slice(-4)}`;
  }
}

/**
 * POST /api/orders
 * Submit a customer order with Cash on Delivery (COD)
 * Saves metadata to Supabase DB and files to Supabase Storage
 */
router.post('/orders', async (req, res) => {
  try {
    const {
      customer = {},
      product = {},
      originalImageData,
      previewImageData,
      sequenceText,
      previewMetadata,
    } = req.body;

    // ── Field Validation ────────────────────────────────────────────────────
    const errors = {};
    if (!customer.fullName || !customer.fullName.trim()) {
      errors.fullName = 'Full Name is required.';
    }
    if (!customer.phone || !customer.phone.trim()) {
      errors.phone = 'Phone Number is required.';
    }
    if (!customer.address || !customer.address.trim()) {
      errors.address = 'Delivery Address is required.';
    }
    if (!customer.city || !customer.city.trim()) {
      errors.city = 'City is required.';
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors,
      });
    }

    // Ensure storage bucket is ready
    await ensureStorageBucket();

    // Generate unique order number
    const orderNumber = await generateNextOrderNumber();

    // ── Supabase Storage Uploads ────────────────────────────────────────────
    let originalFilePath = null;
    let previewFilePath = null;
    let sequenceFilePath = null;

    // 1. Upload original image if provided
    if (originalImageData) {
      const extMatch = originalImageData.match(/^data:image\/([a-zA-Z0-9]+);base64,/);
      const ext = extMatch && extMatch[1] === 'jpeg' ? 'jpg' : extMatch ? extMatch[1] : 'jpg';
      const targetStoragePath = `orders/${orderNumber}/original.${ext}`;
      try {
        await uploadBase64ToStorage(originalImageData, targetStoragePath, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
        originalFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload original image to Supabase Storage:', err.message);
      }
    }

    // 2. Upload generated preview image if provided
    if (previewImageData) {
      const targetStoragePath = `orders/${orderNumber}/preview.png`;
      try {
        await uploadBase64ToStorage(previewImageData, targetStoragePath, 'image/png');
        previewFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload preview image to Supabase Storage:', err.message);
      }
    }

    // 3. Upload sequence instructions if provided
    if (sequenceText && typeof sequenceText === 'string') {
      const targetStoragePath = `orders/${orderNumber}/sequence.txt`;
      try {
        await uploadTextToStorage(sequenceText, targetStoragePath, 'text/plain');
        sequenceFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload sequence to Supabase Storage:', err.message);
      }
    }

    // ── Insert into Supabase Orders Table ───────────────────────────────────
    const orderPayload = {
      order_number: orderNumber,
      full_name: customer.fullName.trim(),
      email: customer.email ? customer.email.trim() : '',
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      city: customer.city.trim(),
      product_name: product.name || 'Custom Handcrafted String Art (50 cm)',
      price: typeof product.price === 'number' ? product.price : 175.0,
      payment_method: 'COD',
      payment_status: 'pending',
      order_status: 'new',
      original_file_path: originalFilePath,
      preview_file_path: previewFilePath,
      sequence_file_path: sequenceFilePath,
    };

    const { data: insertedOrder, error: insertError } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select()
      .single();

    if (insertError) {
      console.error('[orders] Supabase database insert error:', insertError);
      return res.status(500).json({
        error: 'Failed to save order to database',
        details: insertError.message,
      });
    }

    const appOrder = mapOrderRowToModel(insertedOrder);

    console.log(`[orders] Successfully created order ${orderNumber} in Supabase for ${appOrder.customer.fullName}`);

    return res.status(201).json({
      success: true,
      order: appOrder,
    });
  } catch (err) {
    console.error('[orders] Order creation failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to create order' });
  }
});

/**
 * GET /api/orders/:orderNumber
 * Fetch order details by order number
 */
router.get('/orders/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { data: orderRow, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('order_number', orderNumber.trim())
      .single();

    if (error || !orderRow) {
      return res.status(404).json({ error: `Order ${orderNumber} not found` });
    }

    const order = mapOrderRowToModel(orderRow);
    return res.json({ order });
  } catch (err) {
    console.error('[orders] Error retrieving order:', err);
    return res.status(500).json({ error: err.message || 'Failed to retrieve order' });
  }
});

/**
 * GET /api/orders
 * List orders (internal / testing)
 */
router.get('/orders', async (_req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const orders = (rows || []).map((r) => mapOrderRowToModel(r));
    return res.json({ count: orders.length, orders });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to list orders' });
  }
});

export default router;
