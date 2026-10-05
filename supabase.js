/**
 * supabase.js — Supabase Client and Storage Service for StringArt Backend
 *
 * Environment variables:
 *   SUPABASE_URL        — Supabase Project URL (e.g., https://xyzcompany.supabase.co)
 *   SUPABASE_SECRET_KEY — Supabase Service Role Secret Key (Server-side ONLY)
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
export const ORDERS_BUCKET = 'stringart-orders';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn(
    '[supabase] ⚠️ Warning: SUPABASE_URL and/or SUPABASE_SECRET_KEY are not configured.\n' +
    'Please set these environment variables in your backend .env file.'
  );
}

export const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_SECRET_KEY || 'placeholder-key', {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Ensure the private storage bucket exists
 */
export async function ensureStorageBucket() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return false;
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) {
      console.error('[supabase] Error listing storage buckets:', error.message);
      return false;
    }

    const bucketExists = buckets?.some((b) => b.name === ORDERS_BUCKET || b.id === ORDERS_BUCKET);
    if (!bucketExists) {
      const { error: createErr } = await supabase.storage.createBucket(ORDERS_BUCKET, {
        public: false,
        fileSizeLimit: 52428800, // 50MB
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'text/plain'],
      });
      if (createErr) {
        console.error(`[supabase] Failed to create bucket "${ORDERS_BUCKET}":`, createErr.message);
        return false;
      }
      console.log(`[supabase] Successfully created private bucket: "${ORDERS_BUCKET}"`);
    }
    return true;
  } catch (err) {
    console.error('[supabase] Exception in ensureStorageBucket:', err.message);
    return false;
  }
}

/**
 * Upload a Base64 / DataURL string to private Supabase Storage
 */
export async function uploadBase64ToStorage(dataUrlOrBase64, storagePath, defaultMime = 'image/png') {
  if (!dataUrlOrBase64 || typeof dataUrlOrBase64 !== 'string') return null;

  let mimeType = defaultMime;
  let base64String = dataUrlOrBase64;
  const match = dataUrlOrBase64.match(/^data:([A-Za-z0-9/+-]+);base64,(.+)$/);
  if (match) {
    mimeType = match[1];
    base64String = match[2];
  }

  const buffer = Buffer.from(base64String, 'base64');
  const { data, error } = await supabase.storage
    .from(ORDERS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    console.error(`[supabase] Upload error for ${storagePath}:`, error.message);
    throw error;
  }

  return storagePath;
}

/**
 * Upload text content (e.g. sequence.txt) to private Supabase Storage
 */
export async function uploadTextToStorage(textContent, storagePath, mimeType = 'text/plain') {
  if (textContent === undefined || textContent === null) return null;

  const buffer = Buffer.from(String(textContent), 'utf-8');
  const { data, error } = await supabase.storage
    .from(ORDERS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    console.error(`[supabase] Text upload error for ${storagePath}:`, error.message);
    throw error;
  }

  return storagePath;
}

/**
 * Generate a temporary signed URL for a private file in Supabase Storage
 */
export async function getSignedFileUrl(storagePath, expiresIn = 3600) {
  if (!storagePath) return null;

  const { data, error } = await supabase.storage
    .from(ORDERS_BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (error) {
    console.error(`[supabase] Signed URL error for ${storagePath}:`, error.message);
    return null;
  }

  return data?.signedUrl || null;
}

/**
 * Download a file from private Supabase Storage as UTF-8 text
 */
export async function downloadStorageText(storagePath) {
  if (!storagePath) return null;

  const { data, error } = await supabase.storage
    .from(ORDERS_BUCKET)
    .download(storagePath);

  if (error) {
    console.error(`[supabase] Download text error for ${storagePath}:`, error.message);
    return null;
  }

  return await data.text();
}

/**
 * Download a file from private Supabase Storage as a Node Buffer
 */
export async function downloadStorageBuffer(storagePath) {
  if (!storagePath) return null;

  const { data, error } = await supabase.storage
    .from(ORDERS_BUCKET)
    .download(storagePath);

  if (error) {
    console.error(`[supabase] Download buffer error for ${storagePath}:`, error.message);
    return null;
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Local order thread mode cache (ensures consistency even if DB migration is pending in cloud)
const orderThreadModeCache = new Map();

export function recordOrderThreadMode(orderNumber, threadMode) {
  if (orderNumber && threadMode) {
    orderThreadModeCache.set(String(orderNumber).trim().toUpperCase(), threadMode);
  }
}

export function resolveOrderThreadMode(row) {
  if (row?.thread_mode) {
    return row.thread_mode;
  }
  const key = String(row?.order_number || row?.orderNumber || '').trim().toUpperCase();
  return orderThreadModeCache.get(key) || 'black_only';
}

/**
 * Map PostgreSQL orders row to application model
 */
export function mapOrderRowToModel(row, signedUrls = {}) {
  if (!row) return null;
  const effectiveThreadMode = resolveOrderThreadMode(row);

  return {
    id: row.id,
    orderNumber: row.order_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customer: {
      fullName: row.full_name,
      email: row.email || '',
      phone: row.phone,
      address: row.address,
      city: row.city,
    },
    product: {
      name: row.product_name,
      price: Number(row.price),
      currency: 'GBP',
    },
    paymentMethod: row.payment_method || 'COD',
    paymentStatus: row.payment_status || 'pending',
    orderStatus: row.order_status || 'new',
    threadMode: effectiveThreadMode,
    thread_mode: effectiveThreadMode,
    files: {
      originalImage: signedUrls.originalImageUrl || row.original_file_path || null,
      previewImage: signedUrls.previewImageUrl || row.preview_file_path || null,
      sequenceFile: signedUrls.sequenceFileUrl || row.sequence_file_path || null,
      original_file_path: row.original_file_path || null,
      preview_file_path: row.preview_file_path || null,
      sequence_file_path: row.sequence_file_path || null,
    },
    // Raw database columns for maximum compatibility
    order_number: row.order_number,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    city: row.city,
    product_name: row.product_name,
    price: Number(row.price),
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    order_status: row.order_status,
    original_file_path: row.original_file_path,
    preview_file_path: row.preview_file_path,
    sequence_file_path: row.sequence_file_path,
    thread_mode: effectiveThreadMode,
    threadMode: effectiveThreadMode,
    idempotencyKey: row.idempotency_key || null,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
