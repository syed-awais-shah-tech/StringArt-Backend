/**
 * generate.js — POST /api/generate route
 *
 * Accepts multipart/form-data with:
 *   image         — image file (required)
 *   params        — JSON string of generation parameters
 *
 * Returns JSON:
 *   { lines, totalLines, sequence, metadata, sequenceText, previewData, filename }
 */

import { Router } from 'express';
import multer from 'multer';
import { processImage } from '../engine/imageProcessor.js';
import { generateNails } from '../engine/nailGenerator.js';
import { generate } from '../engine/scoreCalculator.js';
import { formatSequence } from '../engine/sequenceFormatter.js';

const router = Router();

// Store upload in memory (max 20 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted'));
    }
    cb(null, true);
  },
});

// Default thread color palette — matches the C++ default
const DEFAULT_COLORS = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 0],
];

router.post('/generate', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    // ── Parse parameters ──────────────────────────────────────────────────
    let params = {};
    try {
      params = JSON.parse(req.body.params || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid params JSON' });
    }

    const numNails          = Math.max(10,  Math.min(500,  parseInt(params.numNails)          || 200));
    const boardDiameterMm   = parseFloat(params.boardDiameterMm)   || 480;
    const threadThicknessMm = parseFloat(params.threadThicknessMm) || 0.10;
    const maxIterations     = Math.max(100, Math.min(10000, parseInt(params.maxIterations)   || 3000));
    const alpha             = Math.max(0.01, Math.min(1.0,  parseFloat(params.alpha)         || 0.13));
    const lineDensity       = Math.max(0.1,  Math.min(5.0,  parseFloat(params.lineDensity)   || 1.0));
    const kDensity          = lineDensity * 500;   // mirrors C++ default of 500 at density=1.0
    const brightness        = Math.max(0.1,  Math.min(3.0,  parseFloat(params.brightness)    || 1.0));
    const contrast          = Math.max(0.1,  Math.min(4.0,  parseFloat(params.contrast)      || 1.0));
    const bgThreshold       = Math.max(0,    Math.min(255,  parseInt(params.bgThreshold)     || 0));
    const imageSize         = Math.max(256,  Math.min(1024, parseInt(params.imageSize)        || 512));
    const projectName       = (params.name || 'myStringArt').replace(/[^a-zA-Z0-9_-]/g, '_');

    // ── Parse thread colors ───────────────────────────────────────────────
    let colors = DEFAULT_COLORS;
    if (Array.isArray(params.colors) && params.colors.length > 0) {
      colors = params.colors
        .filter((c) => Array.isArray(c) && c.length === 3)
        .map((c) => [
          Math.max(0, Math.min(255, parseInt(c[0]) || 0)),
          Math.max(0, Math.min(255, parseInt(c[1]) || 0)),
          Math.max(0, Math.min(255, parseInt(c[2]) || 0)),
        ]);
      if (colors.length === 0) colors = DEFAULT_COLORS;
    }

    // ── Process image ─────────────────────────────────────────────────────
    console.log(`[generate] Processing image (${imageSize}×${imageSize})…`);
    const { data: original, width, height } = await processImage(req.file.buffer, {
      size: imageSize,
      brightness,
      contrast,
      bgThreshold,
    });

    // ── Generate nails ────────────────────────────────────────────────────
    const nails = generateNails(numNails, width, height);

    // ── Build thread objects (random start nails) ─────────────────────────
    const threads = colors.map((color) => ({
      color,
      currentNail: Math.floor(Math.random() * numNails),
    }));

    // ── Run generation ────────────────────────────────────────────────────
    console.log(`[generate] Running algorithm: ${maxIterations} iterations, ${numNails} nails, ${colors.length} threads…`);
    const t0 = Date.now();

    const { sequence, preview } = generate({
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

    // ── Format sequence file ──────────────────────────────────────────────
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

    // ── Send response ─────────────────────────────────────────────────────
    res.json({
      sequenceText,
      previewData: previewPayload,
      filename: `${projectName}.txt`
    });
  } catch (err) {
    console.error('[generate] Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

export default router;
