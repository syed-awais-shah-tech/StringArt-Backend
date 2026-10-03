/**
 * middleware/security.js
 * Rate limiters and security helper utilities for StringArt Backend
 */

import rateLimit from 'express-rate-limit';

// ── Rate Limiters ────────────────────────────────────────────────────────────

/**
 * 1. General API: 100 requests per IP per 15 minutes
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  statusCode: 429,
});

/**
 * 2. Generate endpoint: 3 requests per IP per 10 minutes
 */
export const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many generation requests. Please wait 10 minutes before generating another design.' },
  statusCode: 429,
});

/**
 * 3. Create order endpoint: 5 requests per IP per 15 minutes
 */
export const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order submissions. Please wait 15 minutes before submitting again.' },
  statusCode: 429,
});

/**
 * 4. Admin login: 5 requests per IP per 15 minutes
 */
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  statusCode: 429,
});

/**
 * 5. Admin authenticated endpoints: 100 requests per IP per 15 minutes
 */
export const adminEndpointsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please slow down.' },
  statusCode: 429,
});

/**
 * 6. Admin forgot password: 5 requests per IP per 15 minutes
 */
export const adminForgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again after 15 minutes.' },
  statusCode: 429,
});

/**
 * 7. Admin reset password: 5 requests per IP per 15 minutes
 */
export const adminResetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset attempts. Please try again after 15 minutes.' },
  statusCode: 429,
});

