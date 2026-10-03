/**
 * test_security.mjs
 * Comprehensive automated security test suite for StringArt-Backend
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let currentPort = 3010;
let BASE_URL = `http://127.0.0.1:${currentPort}`;

// Helper: wait ms
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverProcess = null;

async function startServer(port = 3010) {
  currentPort = port;
  BASE_URL = `http://127.0.0.1:${currentPort}`;
  console.log(`[test] Launching test backend instance on port ${currentPort}…`);
  return new Promise((resolve, reject) => {
    let started = false;
    serverProcess = spawn('node', ['index.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(currentPort),
        NODE_ENV: 'development',
        CLIENT_ORIGIN: 'http://localhost:5173',
        ADMIN_EMAIL: 'admin@stringart.io',
        ADMIN_PASSWORD: 'admin123',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (d) => {
      const text = d.toString();
      if (text.includes('StringArt Backend running') && !started) {
        started = true;
        console.log(`[test] Backend server started successfully on port ${currentPort}.`);
        resolve();
      }
    });

    serverProcess.stderr.on('data', (d) => {
      process.stderr.write(d.toString());
    });

    serverProcess.on('error', (err) => {
      if (!started) reject(err);
    });

    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 4000);
  });
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
    serverProcess = null;
  }
}

// ── Test Suites ──────────────────────────────────────────────────────────────

async function testHelmetHeaders() {
  console.log('\n--- 1. Testing Helmet Security Headers ---');
  const res = await fetch(`${BASE_URL}/health`);
  const headers = res.headers;

  const nosniff = headers.get('x-content-type-options');
  const corp = headers.get('cross-origin-resource-policy');
  const xssFilter = headers.get('x-frame-options');

  console.log(`  x-content-type-options: ${nosniff}`);
  console.log(`  cross-origin-resource-policy: ${corp}`);
  console.log(`  x-frame-options: ${xssFilter}`);

  if (nosniff === 'nosniff' && corp === 'cross-origin') {
    console.log('  ✅ PASS: Helmet security headers properly configured.');
  } else {
    throw new Error('Helmet security headers missing or incorrect.');
  }
}

async function testCors() {
  console.log('\n--- 2. Testing CORS Policies ---');

  // Test allowed origin
  const resAllowed = await fetch(`${BASE_URL}/api/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  const allowHeader = resAllowed.headers.get('access-control-allow-origin');
  console.log(`  Allowed origin header: ${allowHeader}`);
  if (allowHeader !== 'http://localhost:5173') {
    throw new Error(`Expected Access-Control-Allow-Origin: http://localhost:5173, got ${allowHeader}`);
  }
  console.log('  ✅ PASS: Allowed origin accepted.');

  // Test unapproved origin
  const resBlocked = await fetch(`${BASE_URL}/api/health`, {
    headers: { Origin: 'https://malicious-attacker.com' },
  });
  console.log(`  Unapproved origin status: ${resBlocked.status}`);
  if (resBlocked.status === 403) {
    console.log('  ✅ PASS: Unapproved origin rejected with 403 Forbidden.');
  } else {
    throw new Error(`Expected 403 Forbidden for unauthorized origin, got ${resBlocked.status}`);
  }
}

async function testBodyParserLimit() {
  console.log('\n--- 3. Testing Reduced Body-Parser Limit (100kb) ---');
  // Generate 150KB payload
  const largePayload = {
    email: 'test@example.com',
    password: 'x'.repeat(150 * 1024),
  };

  const res = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(largePayload),
  });

  console.log(`  150KB JSON status: ${res.status}`);
  if (res.status === 413) {
    console.log('  ✅ PASS: 150KB JSON request rejected with 413 Payload Too Large.');
  } else {
    throw new Error(`Expected 413 Payload Too Large, got ${res.status}`);
  }
}

async function testOrderValidation() {
  console.log('\n--- 4. Testing Customer Order Validation ---');
  const invalidOrder = {
    customer: {
      fullName: 'A', // too short
      email: 'not-an-email',
      phone: 'invalid#phone!',
      address: '',
      city: '',
    },
  };

  const res = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invalidOrder),
  });

  const json = await res.json();
  console.log(`  Invalid order response status: ${res.status}`);
  console.log(`  Validation error details:`, json.details);

  if (res.status === 400 && json.details?.fullName && json.details?.phone && json.details?.address) {
    console.log('  ✅ PASS: Server-side validation caught all invalid customer fields.');
  } else {
    throw new Error(`Order validation did not catch invalid fields properly: ${JSON.stringify(json)}`);
  }
}

async function testOrderCreationAndIdempotency() {
  console.log('\n--- 5. Testing Order Creation, Server Authoritative Price & Idempotency Key ---');
  const idempotencyKey = `idem-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  // Tampered client order attempting to set price = 0.01 and fake name
  const validOrder = {
    customer: {
      fullName: 'Muhammad Ali',
      email: 'muhammad.ali@example.com',
      phone: '+44 7911 123456',
      address: '221B Baker Street',
      city: 'London',
    },
    product: {
      name: 'Hacked $0.01 Art',
      price: 0.01,
    },
    idempotencyKey,
  };

  // 1st submission
  const res1 = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validOrder),
  });
  const data1 = await res1.json();
  console.log(`  1st order submission status: ${res1.status}, OrderNumber: ${data1.order?.orderNumber}`);
  console.log(`  Stored Product Name: "${data1.order?.product?.name}", Price: £${data1.order?.product?.price}`);

  if (res1.status !== 201 || !data1.order?.orderNumber) {
    throw new Error(`First order creation failed: ${JSON.stringify(data1)}`);
  }

  if (data1.order.product.price !== 175 || data1.order.product.name !== 'Custom Handcrafted String Art (50 cm)') {
    throw new Error(`Server did not enforce authoritative price/name! Price was: ${data1.order.product.price}`);
  }
  console.log('  ✅ PASS: Server enforced authoritative product name and £175.00 price.');

  // 2nd submission with SAME idempotency key
  const res2 = await fetch(`${BASE_URL}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validOrder),
  });
  const data2 = await res2.json();
  console.log(`  2nd order submission status: ${res2.status}, Duplicate: ${data2.duplicate}, OrderNumber: ${data2.order?.orderNumber}`);

  if (res2.status === 200 && data2.duplicate === true && data2.order?.orderNumber === data1.order.orderNumber) {
    console.log('  ✅ PASS: Idempotent duplicate submission returned existing order without creating a new one.');
  } else {
    throw new Error(`Idempotency check failed: ${JSON.stringify(data2)}`);
  }
}

async function testMulterValidation() {
  console.log('\n--- 6. Testing Multer Upload Security ---');

  // 1. Invalid MIME type (text file)
  const formText = new FormData();
  formText.append('image', new Blob(['hello world text file'], { type: 'text/plain' }), 'test.txt');

  const resText = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    body: formText,
  });
  const textJson = await resText.json();
  console.log(`  Invalid MIME type response status: ${resText.status}, error: "${textJson.error}"`);
  if (resText.status === 400 && textJson.error.includes('Only JPEG, PNG, and WebP')) {
    console.log('  ✅ PASS: Invalid MIME type rejected.');
  } else {
    throw new Error(`Invalid MIME rejection failed: ${JSON.stringify(textJson)}`);
  }

  // 2. Oversized image (>10MB)
  console.log('  Testing oversized upload rejection (>10MB)…');
  const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
  const formOversized = new FormData();
  formOversized.append('image', new Blob([oversizedBuffer], { type: 'image/png' }), 'oversized.png');

  const resOversized = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    body: formOversized,
  });
  const oversizedJson = await resOversized.json();
  console.log(`  Oversized upload response status: ${resOversized.status}, error: "${oversizedJson.error}"`);
  if (resOversized.status === 400 && oversizedJson.error.includes('10MB')) {
    console.log('  ✅ PASS: Oversized image (>10MB) rejected.');
  } else {
    throw new Error(`Oversized image rejection failed: ${JSON.stringify(oversizedJson)}`);
  }
}

async function testGenerationParamsValidation() {
  console.log('\n--- 7. Testing Generation Parameters Bounds & Sanitization ---');

  // Create a minimal valid 64x64 PNG in memory using sharp
  const testPngBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 1 },
    },
  }).png().toBuffer();

  // Test negative nails
  const formNegative = new FormData();
  formNegative.append('image', new Blob([testPngBuffer], { type: 'image/png' }), 'test.png');
  formNegative.append('params', JSON.stringify({ numNails: -100 }));

  const resNeg = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    body: formNegative,
  });
  const negJson = await resNeg.json();
  console.log(`  Negative nails response status: ${resNeg.status}, details:`, negJson.details);
  if (resNeg.status === 400 && negJson.details?.some((d) => d.includes('numNails'))) {
    console.log('  ✅ PASS: Negative parameter rejected.');
  } else {
    throw new Error(`Negative parameter validation failed: ${JSON.stringify(negJson)}`);
  }

  // Test abusive iterations (>5000)
  const formIterations = new FormData();
  formIterations.append('image', new Blob([testPngBuffer], { type: 'image/png' }), 'test.png');
  formIterations.append('params', JSON.stringify({ maxIterations: 999999 }));

  const resIter = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    body: formIterations,
  });
  const iterJson = await resIter.json();
  console.log(`  Abusive iterations response status: ${resIter.status}, details:`, iterJson.details);
  if (resIter.status === 400 && iterJson.details?.some((d) => d.includes('maxIterations'))) {
    console.log('  ✅ PASS: Runaway iteration count rejected.');
  } else {
    throw new Error(`Iteration bounds check failed: ${JSON.stringify(iterJson)}`);
  }
}

async function testNormalGeneration() {
  console.log('\n--- 8. Testing Normal Valid Generation (<10MB image) ---');

  const testPngBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 50, g: 50, b: 50, alpha: 1 },
    },
  }).png().toBuffer();

  const validForm = new FormData();
  validForm.append('image', new Blob([testPngBuffer], { type: 'image/png' }), 'avatar.png');
  validForm.append('params', JSON.stringify({
    numNails: 50,
    maxIterations: 100,
    imageSize: 128,
    name: 'test_art',
  }));

  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    body: validForm,
  });
  const json = await res.json();
  console.log(`  Valid generation response status: ${res.status}`);
  console.log(`  Generated filename: ${json.filename}`);
  console.log(`  Total sequence lines: ${json.previewData?.totalLines}`);

  if (res.status === 200 && json.sequenceText && json.previewData && json.filename.startsWith('test_art_')) {
    console.log('  ✅ PASS: Normal generation works correctly and returns safe sanitized filename.');
  } else {
    throw new Error(`Normal generation failed: ${JSON.stringify(json)}`);
  }
}

async function testGenerationRateLimit() {
  console.log('\n--- 9. Testing Generation Rate Limit (3 requests per 10 min) ---');

  const testPngBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 200, g: 200, b: 200, alpha: 1 },
    },
  }).png().toBuffer();

  const makeGenRequest = async () => {
    const f = new FormData();
    f.append('image', new Blob([testPngBuffer], { type: 'image/png' }), 'art.png');
    f.append('params', JSON.stringify({ numNails: 50, maxIterations: 100, imageSize: 128 }));
    return fetch(`${BASE_URL}/api/generate`, { method: 'POST', body: f });
  };

  // We already performed 1 valid generation in step 8.
  // 2nd request:
  const res2 = await makeGenRequest();
  console.log(`  Generation request 2 status: ${res2.status}`);

  // 3rd request:
  const res3 = await makeGenRequest();
  console.log(`  Generation request 3 status: ${res3.status}`);

  // 4th request: MUST trigger 429
  const res4 = await makeGenRequest();
  console.log(`  Generation request 4 status: ${res4.status}`);
  const data4 = await res4.json();
  console.log(`  Rate limit message: "${data4.error}"`);

  if (res4.status === 429 && data4.error.includes('Too many generation requests')) {
    console.log('  ✅ PASS: 4th generation request blocked with HTTP 429 Rate Limit.');
  } else {
    throw new Error(`Expected 429 Too Many Requests on 4th generation, got ${res4.status}`);
  }
}

async function testAdminSecurityAndRateLimit() {
  console.log('\n--- 10. Testing Admin Security, Protected Routes & Rate Limit ---');

  // 1. Protected route without auth
  const resNoAuth = await fetch(`${BASE_URL}/api/admin/orders`);
  console.log(`  Admin orders without auth status: ${resNoAuth.status}`);
  if (resNoAuth.status !== 401) {
    throw new Error(`Expected 401 Unauthorized for unprotected access, got ${resNoAuth.status}`);
  }
  console.log('  ✅ PASS: Protected admin route rejects unauthorized access.');

  // 2. Admin login rate limit test (max 5 per 15 min)
  console.log('  Testing admin login rate limiting (5 attempts)…');
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@stringart.io', password: 'wrongpassword' }),
    });
    console.log(`  Attempt ${i}: status ${res.status}`);
    if (res.status !== 401) {
      throw new Error(`Expected 401 on failed attempt ${i}, got ${res.status}`);
    }
  }

  // 6th attempt: MUST trigger 429
  const resBlocked = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@stringart.io', password: 'wrongpassword' }),
  });
  const blockedJson = await resBlocked.json();
  console.log(`  Attempt 6 status: ${resBlocked.status}, error: "${blockedJson.error}"`);
  if (resBlocked.status === 429 && blockedJson.error.includes('Too many login attempts')) {
    console.log('  ✅ PASS: Admin login rate limit enforced with HTTP 429.');
  } else {
    throw new Error(`Expected 429 on 6th login attempt, got ${resBlocked.status}`);
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  try {
    await startServer(3011);
    await testHelmetHeaders();
    await testCors();
    await testBodyParserLimit();
    await testOrderValidation();
    await testOrderCreationAndIdempotency();

    // Phase 2a: Multer upload validation (2 requests)
    stopServer();
    await delay(300);
    await startServer(3012);
    await testMulterValidation();

    // Phase 2b: Parameter bounds validation (2 requests)
    stopServer();
    await delay(300);
    await startServer(3015);
    await testGenerationParamsValidation();

    // Phase 3: Normal generation & 4th request 429 rate limit
    stopServer();
    await delay(300);
    await startServer(3013);
    await testNormalGeneration();
    await testGenerationRateLimit();

    // Phase 4: Admin security & login 5-attempt rate limit
    stopServer();
    await delay(300);
    await startServer(3014);

    await testAdminSecurityAndRateLimit();

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🎉 ALL SECURITY REQUIREMENTS VERIFIED AND PASSED 100%! 🎉');
    console.log('════════════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n❌ TEST FAILURE:', err);
    process.exitCode = 1;
  } finally {
    stopServer();
  }
}

run();
