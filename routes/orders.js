/**
 * orders.js — Customer Order System (Cash on Delivery with Supabase)
 *
 * Routes:
 *   POST /api/orders      — Create a new customer order (Database + Storage, Idempotent, Rate-limited)
 *   GET  /api/orders/:id  — Retrieve order details by order number
 *   GET  /api/orders      — List all orders (internal)
 */

import { Router } from 'express';
import crypto from 'crypto';
import {
  supabase,
  ensureStorageBucket,
  uploadBase64ToStorage,
  uploadTextToStorage,
  mapOrderRowToModel,
  recordOrderThreadMode,
} from '../supabase.js';
import { createOrderLimiter } from '../middleware/security.js';
import { getStoreSettings } from '../services/settingsService.js';

const router = Router();

// Server-authoritative product definitions (never trust client price/name)
const SERVER_PRODUCT_NAME = 'Custom Handcrafted String Art (50 cm)';
const SERVER_PRODUCT_PRICE = 175.00;

/**
 * Validate customer order inputs against strict bounds and patterns.
 */
function validateCustomerFields(customer = {}) {
  const errors = {};

  // 1. Full Name: required, 2-100 characters
  if (!customer.fullName || typeof customer.fullName !== 'string' || !customer.fullName.trim()) {
    errors.fullName = 'Full Name is required.';
  } else {
    const trimmed = customer.fullName.trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      errors.fullName = 'Full Name must be between 2 and 100 characters.';
    }
  }

  // 2. Email: optional, valid format if supplied
  if (customer.email && typeof customer.email === 'string' && customer.email.trim()) {
    const trimmedEmail = customer.email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (trimmedEmail.length > 150 || !emailRegex.test(trimmedEmail)) {
      errors.email = 'Please provide a valid email address.';
    }
  }

  // 3. Phone: required, 7-25 characters, valid phone characters
  if (!customer.phone || typeof customer.phone !== 'string' || !customer.phone.trim()) {
    errors.phone = 'Phone number is required.';
  } else {
    const trimmedPhone = customer.phone.trim();
    const phoneRegex = /^[\d\s+\-()]{7,25}$/;
    if (!phoneRegex.test(trimmedPhone)) {
      errors.phone = 'Please provide a valid phone number (7-25 digits/symbols).';
    }
  }

  // 4. Address: required, 5-250 characters
  if (!customer.address || typeof customer.address !== 'string' || !customer.address.trim()) {
    errors.address = 'Delivery Address is required.';
  } else {
    const trimmedAddress = customer.address.trim();
    if (trimmedAddress.length < 5 || trimmedAddress.length > 250) {
      errors.address = 'Address must be between 5 and 250 characters.';
    }
  }

  // 5. City: required, 2-100 characters
  if (!customer.city || typeof customer.city !== 'string' || !customer.city.trim()) {
    errors.city = 'City is required.';
  } else {
    const trimmedCity = customer.city.trim();
    if (trimmedCity.length < 2 || trimmedCity.length > 100) {
      errors.city = 'City must be between 2 and 100 characters.';
    }
  }

  return errors;
}

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
 * Submit customer order with COD, Idempotency protection & Rate limiting
 */
router.post('/orders', createOrderLimiter, async (req, res) => {
  try {
    const {
      customer = {},
      originalImageData,
      previewImageData,
      sequenceText,
    } = req.body || {};

    // ── 1. Validate Customer Fields ──────────────────────────────────────────
    const validationErrors = validateCustomerFields(customer);
    if (Object.keys(validationErrors).length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validationErrors,
      });
    }

    // ── 2. Idempotency Key Handling ─────────────────────────────────────────
    const rawIdempotencyKey =
      req.body.idempotencyKey ||
      req.headers['idempotency-key'] ||
      crypto.randomUUID();

    const idempotencyKey = String(rawIdempotencyKey).trim().slice(0, 128);

    // Check if an order was already processed with this key
    const { data: existingOrder, error: checkError } = await supabase
      .from('orders')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (checkError) {
      console.warn('[orders] Warning during idempotency check:', checkError.message);
    }

    if (existingOrder) {
      console.log(`[orders] Idempotent request: returning existing order ${existingOrder.order_number}`);
      const appOrder = mapOrderRowToModel(existingOrder);
      return res.status(200).json({
        success: true,
        duplicate: true,
        order: appOrder,
      });
    }

    // ── 3. Storage Bucket & Order Number ────────────────────────────────────
    await ensureStorageBucket();
    const orderNumber = await generateNextOrderNumber();

    // ── 4. Supabase Storage Uploads ─────────────────────────────────────────
    let originalFilePath = null;
    let previewFilePath = null;
    let sequenceFilePath = null;

    // Upload original image if provided
    if (originalImageData && typeof originalImageData === 'string') {
      const extMatch = originalImageData.match(/^data:image\/([a-zA-Z0-9]+);base64,/);
      const ext = extMatch && extMatch[1] === 'jpeg' ? 'jpg' : extMatch ? extMatch[1] : 'jpg';
      const targetStoragePath = `orders/${orderNumber}/original.${ext}`;
      try {
        await uploadBase64ToStorage(originalImageData, targetStoragePath, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
        originalFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload original image:', err.message);
      }
    }

    // Upload generated preview image if provided
    if (previewImageData && typeof previewImageData === 'string') {
      const targetStoragePath = `orders/${orderNumber}/preview.png`;
      try {
        await uploadBase64ToStorage(previewImageData, targetStoragePath, 'image/png');
        previewFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload preview image:', err.message);
      }
    }

    // Upload sequence instructions if provided
    if (sequenceText && typeof sequenceText === 'string') {
      const targetStoragePath = `orders/${orderNumber}/sequence.txt`;
      try {
        await uploadTextToStorage(sequenceText, targetStoragePath, 'text/plain');
        sequenceFilePath = targetStoragePath;
      } catch (err) {
        console.error('[orders] Failed to upload sequence:', err.message);
      }
    }

    // ── 5. Resolve Effective Thread Mode (Server-Authoritative) ──────────────
    const { eight_color_enabled } = await getStoreSettings();
    const candidateThreadMode = req.body.threadMode || req.body.thread_mode;
    let effectiveThreadMode = 'black_only';
    if (eight_color_enabled && candidateThreadMode === 'eight_color') {
      effectiveThreadMode = 'eight_color';
    } else {
      effectiveThreadMode = 'black_only';
    }

    // ── 6. Database Insert with Server-Side Authoritative Values ────────────
    const orderPayload = {
      order_number: orderNumber,
      full_name: customer.fullName.trim(),
      email: customer.email && typeof customer.email === 'string' ? customer.email.trim() : '',
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      city: customer.city.trim(),
      product_name: SERVER_PRODUCT_NAME,
      price: SERVER_PRODUCT_PRICE,
      payment_method: 'COD',
      payment_status: 'pending',
      order_status: 'new',
      original_file_path: originalFilePath,
      preview_file_path: previewFilePath,
      sequence_file_path: sequenceFilePath,
      thread_mode: effectiveThreadMode,
      idempotency_key: idempotencyKey,
    };

    let insertedOrder = null;
    const { data: directInsert, error: insertError } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select()
      .single();

    if (!insertError && directInsert) {
      insertedOrder = directInsert;
    } else if (insertError) {
      // If concurrent request inserted same idempotency_key, handle gracefully
      if (insertError.code === '23505' || String(insertError.message).includes('idempotency_key')) {
        const { data: duplicateOrder } = await supabase
          .from('orders')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();

        if (duplicateOrder) {
          return res.status(200).json({
            success: true,
            duplicate: true,
            order: mapOrderRowToModel(duplicateOrder),
          });
        }
      }

      // If the column thread_mode is not yet in Supabase schema cache, retry without column
      if (String(insertError.message).includes('thread_mode') || insertError.code === 'PGRST204') {
        console.warn('[orders] thread_mode column not found in schema cache. Inserting fallback without column.');
        const { thread_mode, ...safePayload } = orderPayload;
        const { data: retryData, error: retryErr } = await supabase
          .from('orders')
          .insert(safePayload)
          .select()
          .single();

        if (!retryErr && retryData) {
          retryData.thread_mode = effectiveThreadMode;
          insertedOrder = retryData;
        } else {
          console.error('[orders] Database fallback insert error:', retryErr?.message);
        }
      }

      if (!insertedOrder) {
        console.error('[orders] Database insert error:', insertError.message);
        const isProd = process.env.NODE_ENV === 'production';
        return res.status(500).json({
          error: isProd ? 'Failed to save order to database.' : insertError.message,
        });
      }
    }

    recordOrderThreadMode(orderNumber, effectiveThreadMode);
    insertedOrder.thread_mode = insertedOrder.thread_mode || effectiveThreadMode;
    const appOrder = mapOrderRowToModel(insertedOrder);
    appOrder.thread_mode = effectiveThreadMode;
    appOrder.threadMode = effectiveThreadMode;

    console.log(`[orders] Created order ${orderNumber} (${effectiveThreadMode}) for ${appOrder.customer.fullName}`);

    return res.status(201).json({
      success: true,
      order: appOrder,
    });
  } catch (err) {
    console.error('[orders] Order creation exception:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    return res.status(500).json({
      error: isProd ? 'Failed to create order.' : (err.message || 'Internal server error'),
    });
  }
});

/**
 * GET /api/orders/:orderNumber
 * Fetch order details by order number
 */
router.get('/orders/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const sanitizedOrderNumber = String(orderNumber).trim().slice(0, 32);

    const { data: orderRow, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('order_number', sanitizedOrderNumber)
      .single();

    if (error || !orderRow) {
      return res.status(404).json({ error: `Order ${sanitizedOrderNumber} not found` });
    }

    const order = mapOrderRowToModel(orderRow);
    return res.json({ order });
  } catch (err) {
    console.error('[orders] Error retrieving order:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve order' });
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
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return res.status(500).json({ error: 'Failed to list orders' });
    }

    const orders = (rows || []).map((r) => mapOrderRowToModel(r));
    return res.json({ count: orders.length, orders });
  } catch (err) {
    console.error('[orders] Failed to list orders:', err.message);
    return res.status(500).json({ error: 'Failed to list orders' });
  }
});

export default router;
