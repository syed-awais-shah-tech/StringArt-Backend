/**
 * generate.js — POST /api/generate route
 *
 * Accepts multipart/form-data with:
 *   image         — image file (required, max 10MB, jpeg/png/webp)
 *   params        — JSON string of generation parameters
 *
 * Returns JSON:
 *   { sequenceText, previewData, filename }
 */

import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { processImage } from '../engine/imageProcessor.js';
import { generateNails } from '../engine/nailGenerator.js';
import { generate } from '../engine/scoreCalculator.js';
import { formatSequence } from '../engine/sequenceFormatter.js';
import { generateLimiter } from '../middleware/security.js';
import { getStoreSettings } from '../services/settingsService.js';
import {
  resolveThreadModeAndColors,
  THREAD_MODES,
  BLACK_ONLY_PALETTE,
  FIXED_EIGHT_COLOR_PALETTE,
} from '../engine/palette.js';

const router = Router();

// ── Secure Multer Configuration ──────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const multerUpload = multer({
  storage: multer.memoryStorage(), // In-memory processing: never executed, no disk leak
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB maximum file size
    files: 1,                   // Maximum 1 uploaded file per request
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('INVALID_MIME_TYPE'));
    }
    cb(null, true);
  },
}).single('image');

// Custom upload middleware to handle Multer errors cleanly
const handleUpload = (req, res, next) => {
  multerUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds maximum limit of 10MB.' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'Maximum 1 image file allowed.' });
      }
      if (err.message === 'INVALID_MIME_TYPE') {
        return res.status(400).json({
          error: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed.',
        });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next();
  });
};

/**
 * Validate and sanitize generation parameters.
 * Rejects negative, NaN, infinite, or abusive values.
 * Arbitrary thread colors are disallowed: palette is resolved server-side.
 */
function validateGenerationParams(rawParams) {
  const errors = [];

  // Helper for numeric bounds
  const checkNumber = (key, val, { min, max, integer = false, defaultValue }) => {
    if (val === undefined || val === null || val === '') {
      return defaultValue;
    }
    const num = Number(val);
    if (!Number.isFinite(num) || Number.isNaN(num)) {
      errors.push(`${key} must be a valid finite number.`);
      return defaultValue;
    }
    if (integer && !Number.isInteger(num)) {
      errors.push(`${key} must be an integer.`);
      return defaultValue;
    }
    if (num < min || num > max) {
      errors.push(`${key} must be between ${min} and ${max}.`);
      return defaultValue;
    }
    return num;
  };

  const numNails = checkNumber('numNails', rawParams.numNails, {
    min: 50,
    max: 500,
    integer: true,
    defaultValue: 200,
  });

  const maxIterations = checkNumber('maxIterations', rawParams.maxIterations, {
    min: 100,
    max: 5000,
    integer: true,
    defaultValue: 3000,
  });

  const imageSize = checkNumber('imageSize', rawParams.imageSize, {
    min: 128,
    max: 1024,
    integer: true,
    defaultValue: 512,
  });

  const boardDiameterMm = checkNumber('boardDiameterMm', rawParams.boardDiameterMm, {
    min: 100,
    max: 1200,
    integer: false,
    defaultValue: 480,
  });

  const threadThicknessMm = checkNumber('threadThicknessMm', rawParams.threadThicknessMm, {
    min: 0.01,
    max: 2.0,
    integer: false,
    defaultValue: 0.10,
  });

  const alpha = checkNumber('alpha', rawParams.alpha, {
    min: 0.01,
    max: 1.0,
    integer: false,
    defaultValue: 0.13,
  });

  const lineDensity = checkNumber('lineDensity', rawParams.lineDensity, {
    min: 0.1,
    max: 5.0,
    integer: false,
    defaultValue: 1.0,
  });

  const brightness = checkNumber('brightness', rawParams.brightness, {
    min: 0.1,
    max: 4.0,
    integer: false,
    defaultValue: 1.0,
  });

  const contrast = checkNumber('contrast', rawParams.contrast, {
    min: 0.1,
    max: 4.0,
    integer: false,
    defaultValue: 1.0,
  });

  const bgThreshold = checkNumber('bgThreshold', rawParams.bgThreshold, {
    min: 0,
    max: 255,
    integer: true,
    defaultValue: 0,
  });

  // Thread mode requested by client (e.g. 'black_only' or 'eight_color')
  const requestedThreadMode = typeof (rawParams.threadMode || rawParams.thread_mode) === 'string'
    ? String(rawParams.threadMode || rawParams.thread_mode).trim().toLowerCase()
    : undefined;

  // Project name: sanitize, max 50 chars, never trust raw filename
  const safeBaseName = typeof rawParams.name === 'string'
    ? rawParams.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)
    : 'stringart';
  const safeId = crypto.randomUUID().slice(0, 8);
  const projectName = `${safeBaseName || 'stringart'}_${safeId}`;

  return {
    errors,
    params: {
      numNails,
      maxIterations,
      imageSize,
      boardDiameterMm,
      threadThicknessMm,
      alpha,
      lineDensity,
      kDensity: lineDensity * 500,
      brightness,
      contrast,
      bgThreshold,
      requestedThreadMode,
      projectName,
    },
  };
}

// ── POST /api/generate ───────────────────────────────────────────────────────
router.post('/generate', generateLimiter, handleUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // ── Parse and validate parameters ────────────────────────────────────────
    let rawParams = {};
    if (req.body.params) {
      try {
        rawParams = JSON.parse(req.body.params);
        if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
          return res.status(400).json({ error: 'params must be a valid JSON object.' });
        }
      } catch {
        return res.status(400).json({ error: 'Invalid params JSON format.' });
      }
    }

    const { errors, params } = validateGenerationParams(rawParams);
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Invalid generation parameters',
        details: errors,
      });
    }

    const {
      numNails,
      boardDiameterMm,
      threadThicknessMm,
      maxIterations,
      alpha,
      kDensity,
      brightness,
      contrast,
      bgThreshold,
      imageSize,
      requestedThreadMode,
      projectName,
    } = params;

    // ── Resolve thread mode from store settings & customer request ──────────
    const { eight_color_enabled } = await getStoreSettings();
    const candidateMode = requestedThreadMode || req.body.threadMode || req.body.thread_mode;
    const { effectiveMode, colors } = resolveThreadModeAndColors(eight_color_enabled, candidateMode);

    console.log(
      `[generate] Admin 8-color enabled: ${eight_color_enabled}, requested: "${candidateMode || 'default'}", effective: "${effectiveMode}" (${colors.length} threads)`
    );

    // ── Process image in memory ──────────────────────────────────────────────
    console.log(`[generate] Processing image (${imageSize}×${imageSize})…`);
    const { data: original, width, height } = await processImage(req.file.buffer, {
      size: imageSize,
      brightness,
      contrast,
      bgThreshold,
    });

    // ── Generate nails ───────────────────────────────────────────────────────
    const nails = generateNails(numNails, width, height);

    // ── Build thread objects ─────────────────────────────────────────────────
    const threads = colors.map((color) => ({
      color,
      currentNail: Math.floor(Math.random() * numNails),
    }));

    // ── Run generation algorithm ─────────────────────────────────────────────
    console.log(`[generate] Running algorithm: ${maxIterations} iterations, ${numNails} nails, ${colors.length} threads…`);
    const t0 = Date.now();

    const { sequence } = generate({
      original,
      width,
      height,
      nails,
      threads,
      maxIterations,
      alpha,
      kDensity,
      onProgress: (pct, iter) => {
        process.stdout.write(`\r[generate] ${pct.toFixed(1)}% (iter ${iter}/${maxIterations})`);
      },
    });
    console.log(`\n[generate] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${sequence.length} lines`);

    // ── Format sequence file ─────────────────────────────────────────────────
    const sequenceText = formatSequence(sequence, {
      name: projectName,
      numNails,
      boardDiameterMm,
      threadThicknessMm,
    });

    const previewPayload = {
      nails: nails.map((n) => [n.x, n.y]),
      width,
      height,
      sequence: sequence.map((s) => [s.r, s.g, s.b, s.nailIdx]),
      totalLines: sequence.length,
    };

    // ── Safe response (server-generated filename & effective mode) ───────────
    res.json({
      sequenceText,
      previewData: previewPayload,
      filename: `${projectName}.txt`,
      threadMode: effectiveMode,
      thread_mode: effectiveMode,
    });
  } catch (err) {
    console.error('[generate] Error:', err.message);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: isProd ? 'An error occurred during generation.' : (err.message || 'Internal server error'),
    });
  }
});

// ── GET /api/settings/generation ─────────────────────────────────────────────
// Safe public endpoint exposing whether 8-color generation is allowed
router.get('/settings/generation', async (_req, res) => {
  try {
    const { eight_color_enabled } = await getStoreSettings();
    res.json({
      eightColorEnabled: Boolean(eight_color_enabled),
      eight_color_enabled: Boolean(eight_color_enabled),
    });
  } catch (err) {
    console.error('[generate] Error fetching generation settings:', err.message);
    res.status(500).json({ error: 'Failed to retrieve generation settings' });
  }
});

export default router;
