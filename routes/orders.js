/**
 * orders.js — Customer Order System (Cash on Delivery)
 *
 * Routes:
 *   POST /api/orders      — Create a new customer order
 *   GET  /api/orders/:id  — Retrieve order details by order number
 *   GET  /api/orders      — List all orders (internal/admin)
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ORDERS_UPLOADS_DIR = path.join(DATA_DIR, 'orders');

// Ensure directories and storage file exist
function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(ORDERS_UPLOADS_DIR)) {
    fs.mkdirSync(ORDERS_UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

// Read all orders safely
function readOrders() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[orders] Error reading orders.json:', err);
    return [];
  }
}

// Write orders atomically
function writeOrders(orders) {
  ensureStorage();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

// Generate sequential order number e.g. SA-1001, SA-1002
function generateOrderNumber(orders) {
  const existingNums = orders
    .map((o) => {
      const match = typeof o.orderNumber === 'string' && o.orderNumber.match(/^SA-(\d+)$/i);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((n) => n !== null && !isNaN(n));

  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1001;
  return `SA-${nextNum}`;
}

// Helper to save base64 / dataURL to file
function saveBase64File(dataUrlOrBase64, targetPath) {
  if (!dataUrlOrBase64 || typeof dataUrlOrBase64 !== 'string') return null;

  try {
    const matches = dataUrlOrBase64.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    const base64Data = matches ? matches[2] : dataUrlOrBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(targetPath, buffer);
    return true;
  } catch (err) {
    console.error('[orders] Failed to save base64 file:', err);
    return false;
  }
}

/**
 * POST /api/orders
 * Submit a customer order with Cash on Delivery
 */
router.post('/orders', (req, res) => {
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

    const orders = readOrders();
    const orderNumber = generateOrderNumber(orders);

    // ── File saving ─────────────────────────────────────────────────────────
    const files = {
      originalImage: null,
      previewImage: null,
      sequenceFile: null,
    };

    // 1. Save original image if provided
    if (originalImageData) {
      const extMatch = originalImageData.match(/^data:image\/([a-zA-Z0-9]+);base64,/);
      const ext = extMatch && extMatch[1] === 'jpeg' ? 'jpg' : extMatch ? extMatch[1] : 'png';
      const origFileName = `${orderNumber}-original.${ext}`;
      const origFilePath = path.join(ORDERS_UPLOADS_DIR, origFileName);
      if (saveBase64File(originalImageData, origFilePath)) {
        files.originalImage = `orders/${origFileName}`;
      }
    }

    // 2. Save preview image if provided
    if (previewImageData) {
      const prevFileName = `${orderNumber}-preview.png`;
      const prevFilePath = path.join(ORDERS_UPLOADS_DIR, prevFileName);
      if (saveBase64File(previewImageData, prevFilePath)) {
        files.previewImage = `orders/${prevFileName}`;
      }
    }

    // 3. Save sequence file
    if (sequenceText && typeof sequenceText === 'string') {
      const seqFileName = `${orderNumber}-sequence.txt`;
      const seqFilePath = path.join(ORDERS_UPLOADS_DIR, seqFileName);
      try {
        fs.writeFileSync(seqFilePath, sequenceText, 'utf-8');
        files.sequenceFile = `orders/${seqFileName}`;
      } catch (err) {
        console.error('[orders] Failed to save sequence file:', err);
      }
    }

    // ── Construct Order Record ──────────────────────────────────────────────
    const newOrder = {
      orderNumber,
      createdAt: new Date().toISOString(),
      customer: {
        fullName: customer.fullName.trim(),
        email: customer.email ? customer.email.trim() : '',
        phone: customer.phone.trim(),
        address: customer.address.trim(),
        city: customer.city.trim(),
      },
      product: {
        name: product.name || 'Custom Handcrafted String Art (50 cm)',
        price: typeof product.price === 'number' ? product.price : 175,
        currency: product.currency || 'GBP',
      },
      paymentMethod: 'COD',
      paymentStatus: 'pending',
      orderStatus: 'new',
      files,
      metadata: {
        totalLines: previewMetadata?.totalLines || 3000,
        boardSize: '50 cm circular',
        numNails: previewMetadata?.numNails || 200,
      },
    };

    orders.push(newOrder);
    writeOrders(orders);

    console.log(`[orders] Successfully created order ${orderNumber} for ${newOrder.customer.fullName}`);

    res.status(201).json({
      success: true,
      order: newOrder,
    });
  } catch (err) {
    console.error('[orders] Order creation failed:', err);
    res.status(500).json({ error: err.message || 'Failed to create order' });
  }
});

/**
 * GET /api/orders/:orderNumber
 * Fetch order details by order number
 */
router.get('/orders/:orderNumber', (req, res) => {
  try {
    const orders = readOrders();
    const order = orders.find(
      (o) => o.orderNumber?.toUpperCase() === req.params.orderNumber?.toUpperCase()
    );

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to retrieve order' });
  }
});

/**
 * GET /api/orders
 * List orders (internal / testing)
 */
router.get('/orders', (_req, res) => {
  try {
    const orders = readOrders();
    res.json({ count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list orders' });
  }
});

export default router;
