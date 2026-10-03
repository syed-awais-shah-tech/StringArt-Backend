/**
 * index.js — Express server entry point
 * StringArt ERN Stack Backend (Cloud Run & Supabase Production Ready with Security Protections)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import generateRouter from './routes/generate.js';
import ordersRouter from './routes/orders.js';
import adminRouter from './routes/admin.js';
import { generalLimiter } from './middleware/security.js';
import { ensureStorageBucket } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';

// Trust first proxy for accurate client IP identification in Cloud Run / reverse proxies
app.set('trust proxy', 1);

// ── 1. Security Headers (Helmet) ─────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows cross-origin frontend asset access
}));

// ── 2. Strict CORS Configuration ─────────────────────────────────────────────
const rawClientOrigin = process.env.CLIENT_ORIGIN || '';
const productionOrigins = rawClientOrigin
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0 && o !== '*'); // Disallow '*' in production

const developmentOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  ...productionOrigins,
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests without origin header (e.g. server-to-server, curl, Cloud Run health checks)
    if (!origin) {
      return callback(null, true);
    }

    if (isProduction) {
      if (productionOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    }

    // In development allow localhost ports or configured origin
    if (developmentOrigins.includes(origin)) {
      return callback(null, true);
    }
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  exposedHeaders: ['X-Preview-Data', 'Content-Disposition'],
};

app.use(cors(corsOptions));

// ── 3. Reduced Body-Parser Limits ────────────────────────────────────────────
// Specific body parser for orders route (receives base64 uploaded image/preview)
app.use('/api/orders', express.json({ limit: '10mb' }));
app.use('/api/orders', express.urlencoded({ limit: '10mb', extended: true }));

// General body parser for all other requests: strict 100kb limit
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));

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

// ── 4. Application Routes with Rate Limiting ──────────────────────────────────
// General API rate limiter (100 requests per IP per 15 minutes)
app.use('/api', generalLimiter);

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

// ── 5. Centralized Error Handling Middleware ─────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }

  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Request payload too large (maximum 100kb for JSON requests).' });
  }

  const statusCode = err.status || err.statusCode || 500;
  console.error(`[server] Error on ${req.method} ${req.path}:`, err.message);

  res.status(statusCode).json({
    error: isProduction ? 'An unexpected server error occurred.' : (err.message || 'Internal server error'),
  });
});

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
