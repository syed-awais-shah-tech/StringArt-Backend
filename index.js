/**
 * index.js — Express server entry point
 * StringArt ERN Stack Backend (with Supabase)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import generateRouter from './routes/generate.js';
import ordersRouter from './routes/orders.js';
import adminRouter from './routes/admin.js';
import { ensureStorageBucket } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];
if (process.env.CLIENT_ORIGIN) {
  allowedOrigins.push(...process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim()));
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    // Allow in non-production or fallback
    return callback(null, true);
  },
  credentials: true,
  exposedHeaders: ['X-Preview-Data', 'Content-Disposition'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve saved order uploads statically if needed (backward compatibility)
app.use('/data', express.static(path.join(__dirname, 'data')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', generateRouter);
app.use('/api', ordersRouter);
app.use('/api/admin', adminRouter);

// Root greeting
app.get('/', (_req, res) => {
  res.json({
    name: 'StringArt Backend API',
    status: 'online',
    version: '1.0.0',
    storage: 'Supabase',
    endpoints: {
      generate: 'POST /api/generate',
      createOrder: 'POST /api/orders',
      getOrder: 'GET /api/orders/:orderNumber',
      adminLogin: 'POST /api/admin/login',
      adminOrders: 'GET /api/admin/orders',
      adminStats: 'GET /api/admin/stats',
      health: 'GET /api/health',
    },
  });
});

// Serve built frontend if available
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/data')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    engine: 'StringArt JS',
    storage: 'Supabase',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║   StringArt Server  →  http://localhost:${PORT} ║`);
  console.log(`╚══════════════════════════════════════════╝`);

  // Verify Supabase bucket
  await ensureStorageBucket();
});

export default app;
