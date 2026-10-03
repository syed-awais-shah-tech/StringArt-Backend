/**
 * index.js — Express server entry point
 * StringArt ERN Stack Backend (Cloud Run & Supabase Production Ready)
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
// Google Cloud Run automatically passes PORT (default 8080)
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

// ── Middleware & CORS ─────────────────────────────────────────────────────────
const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

const envOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = [...defaultOrigins, ...envOrigins];

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server, Cloud Run health probes)
    if (!origin) return callback(null, true);

    // Allow configured origins or wildcard
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    // Automatically allow any Cloud Run deployed frontend domain
    if (origin.endsWith('.run.app')) {
      return callback(null, true);
    }

    // In non-production development, allow any origin
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    // Fallback: reflect origin for safe cross-origin access
    return callback(null, true);
  },
  credentials: true,
  exposedHeaders: ['X-Preview-Data', 'Content-Disposition'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve saved order uploads statically if needed (backward compatibility)
app.use('/data', express.static(path.join(__dirname, 'data')));

// ── Health Check Endpoints ────────────────────────────────────────────────────
// Standard root health check for Google Cloud Run container liveness/readiness
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'stringart-backend',
    timestamp: new Date().toISOString(),
  });
});

// Application API health check
app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    engine: 'StringArt JS',
    storage: 'Supabase',
  });
});

// ── Application Routes ────────────────────────────────────────────────────────
app.use('/api', generateRouter);
app.use('/api', ordersRouter);
app.use('/api/admin', adminRouter);

// Service Root
app.get('/', (_req, res) => {
  res.json({
    name: 'StringArt Backend API',
    status: 'online',
    version: '1.0.0',
    storage: 'Supabase',
    endpoints: {
      health: 'GET /health',
      apiHealth: 'GET /api/health',
      generate: 'POST /api/generate',
      createOrder: 'POST /api/orders',
      getOrder: 'GET /api/orders/:orderNumber',
      adminLogin: 'POST /api/admin/login',
      adminOrders: 'GET /api/admin/orders',
      adminStats: 'GET /api/admin/stats',
    },
  });
});

// Optional: Serve built frontend if embedded in same container
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/data') || req.path.startsWith('/health')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ── Start Server ──────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, async () => {
  console.log(`╔════════════════════════════════════════════════════════════╗`);
  console.log(`║   StringArt Backend running on http://${HOST}:${PORT}       ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  // Verify Supabase private bucket
  await ensureStorageBucket();
});

// ── Graceful Shutdown for Cloud Run ───────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`[server] Received ${signal}. Closing HTTP server gracefully...`);
  server.close(() => {
    console.log('[server] HTTP server closed cleanly.');
    process.exit(0);
  });
  // Force exit if hanging
  setTimeout(() => {
    console.error('[server] Force shutdown timeout exceeded. Exiting.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
