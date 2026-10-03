/**
 * test_supabase_integration.cjs
 * Comprehensive test script for StringArt Supabase Database and Storage
 */

const http = require('http');
const https = require('https');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

function request(options, data) {
  return new Promise((resolve, reject) => {
    const isHttps = options.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function ensureServerRunning() {
  try {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/health',
      method: 'GET',
    });
    if (res.status === 200) {
      console.log('Detected existing server running on port ' + PORT);
      return null;
    }
  } catch (_) {}

  console.log('Starting local backend server on port ' + PORT + ' for tests...');
  const { spawn } = require('child_process');
  const serverProcess = spawn('node', ['index.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
  });

  // Wait for server to boot up
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/health',
        method: 'GET',
      });
      if (res.status === 200) {
        console.log('Server successfully booted.');
        return serverProcess;
      }
    } catch (_) {}
  }

  serverProcess.kill();
  throw new Error('Failed to start backend server within 6 seconds.');
}

async function runTests() {
  console.log('====================================================');
  console.log('  StringArt Supabase Backend Integration Tests');
  console.log('====================================================\n');

  console.log('Checking environment configuration...');
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'CONFIGURED' : 'MISSING ❌');
  console.log('SUPABASE_SECRET_KEY:', process.env.SUPABASE_SECRET_KEY ? 'CONFIGURED' : 'MISSING ❌');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('\n❌ Please provide SUPABASE_URL and SUPABASE_SECRET_KEY in .env before running tests.');
    process.exit(1);
  }

  let spawnedServer = null;
  try {
    spawnedServer = await ensureServerRunning();

    // 1. Health check
    console.log('\n1. Checking Server Health...');
    const healthRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/health',
      method: 'GET',
    });
    console.log(`Status: ${healthRes.status}, Engine: ${healthRes.body?.engine}, Storage: ${healthRes.body?.storage}`);
    if (healthRes.status !== 200) throw new Error('Server health check failed');

    // 2. Admin Login
    console.log('\n2. Logging in as Admin...');
    const loginRes = await request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/api/admin/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        email: process.env.INITIAL_SEED_EMAIL || 'admin@stringart.io',
        password: process.env.INITIAL_SEED_PASSWORD || 'StringArtAdmin2026!',
      }
    );
    console.log(`Login Status: ${loginRes.status}, Success: ${loginRes.body?.success}`);
    const setCookie = loginRes.headers?.['set-cookie'];
    if (!setCookie || !loginRes.body?.success) throw new Error('Admin login failed or missing cookie');
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : setCookie.split(';')[0];
    console.log(`   HttpOnly Cookie received: ${cookieHeader.split('=')[0]}=***`);

    // 3. Customer Order Creation with Base64 Images & Sequence Text
    console.log('\n3. Testing Customer Order Creation (POST /api/orders)...');
    const dummyPixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dummyPixelJpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const sampleSequence = 'START\nPIN 1\nPIN 88\nPIN 142\nPIN 25\nPIN 199\nEND';

    const orderPayload = {
      customer: {
        fullName: 'Test Customer Awais',
        email: 'awais.test@example.com',
        phone: '+44 7911 000111',
        address: '42 Baker Street, Suite 5B',
        city: 'London',
      },
      product: {
        name: 'Custom Handcrafted String Art (50 cm)',
        price: 175,
        currency: 'GBP',
      },
      originalImageData: dummyPixelJpg,
      previewImageData: dummyPixelPng,
      sequenceText: sampleSequence,
      previewMetadata: {
        totalLines: 3000,
        numNails: 200,
      },
    };

    const createRes = await request(
      {
        hostname: 'localhost',
        port: PORT,
        path: '/api/orders',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      orderPayload
    );

    console.log(`Order Creation Status: ${createRes.status}`);
    if (createRes.status !== 201 || !createRes.body?.success) {
      console.error('Order creation response:', createRes.body);
      throw new Error('Order creation failed');
    }

    const createdOrder = createRes.body.order;
    const orderNumber = createdOrder.orderNumber;
    console.log(`✅ Order created successfully: ${orderNumber}`);
    console.log(`   Customer: ${createdOrder.customer?.fullName}`);
    console.log(`   Original File: ${createdOrder.files?.original_file_path || createdOrder.files?.originalImage}`);
    console.log(`   Preview File: ${createdOrder.files?.preview_file_path || createdOrder.files?.previewImage}`);
    console.log(`   Sequence File: ${createdOrder.files?.sequence_file_path || createdOrder.files?.sequenceFile}`);

    // 4. Admin Order Listing
    console.log('\n4. Testing Admin Order Listing (GET /api/admin/orders)...');
    const listRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/orders?search=${encodeURIComponent(orderNumber)}`,
      method: 'GET',
      headers: { Cookie: cookieHeader },
    });

    console.log(`Listing Status: ${listRes.status}, Total Found: ${listRes.body?.total}`);
    const foundInList = listRes.body?.orders?.find((o) => o.orderNumber === orderNumber);
    if (!foundInList) throw new Error(`Created order ${orderNumber} not found in admin order listing`);
    console.log(`✅ Verified order present in admin list: ${foundInList.orderNumber}`);

    // 5. Admin Order Details with Signed URLs
    console.log('\n5. Testing Admin Order Details with Signed URLs (GET /api/admin/orders/:id)...');
    const detailRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/orders/${orderNumber}`,
      method: 'GET',
      headers: { Cookie: cookieHeader },
    });

    console.log(`Detail Status: ${detailRes.status}`);
    const orderDetail = detailRes.body?.order;
    if (!orderDetail) throw new Error('Order detail could not be retrieved');

    console.log(`   Signed Original URL: ${orderDetail.files?.originalImage ? 'GENERATED ✅' : 'NONE'}`);
    console.log(`   Signed Preview URL:  ${orderDetail.files?.previewImage ? 'GENERATED ✅' : 'NONE'}`);
    console.log(`   Signed Sequence URL: ${orderDetail.files?.sequenceFile ? 'GENERATED ✅' : 'NONE'}`);
    console.log(`   Sequence Content:    ${orderDetail.sequenceFileContent ? 'FETCHED ✅ (' + orderDetail.sequenceFileContent.length + ' bytes)' : 'NONE'}`);

    // 6. Admin Order Status Update
    console.log('\n6. Testing Admin Status Update (PATCH /api/admin/orders/:id)...');
    const updateRes = await request(
      {
        hostname: 'localhost',
        port: PORT,
        path: `/api/admin/orders/${orderNumber}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
      },
      { orderStatus: 'in_production', paymentStatus: 'paid' }
    );

    console.log(`Update Status: ${updateRes.status}`);
    if (updateRes.status !== 200 || !updateRes.body?.success) {
      throw new Error('Failed to update order status');
    }
    console.log(`✅ Order status updated in Supabase: status=${updateRes.body.order.orderStatus}, payment=${updateRes.body.order.paymentStatus}`);

    // 7. Sequence File Download Stream
    console.log('\n7. Testing Admin Sequence Download (GET /api/admin/orders/:id/sequence)...');
    const seqRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/orders/${orderNumber}/sequence`,
      method: 'GET',
      headers: { Cookie: cookieHeader },
    });

    console.log(`Sequence Download Status: ${seqRes.status}, Content-Type: ${seqRes.headers?.['content-type']}`);
    if (seqRes.status !== 200 || !seqRes.body.includes('PIN 88')) {
      throw new Error('Sequence file download content did not match');
    }
    console.log('✅ Sequence file streamed and verified successfully!');

    // 8. Dashboard Stats
    console.log('\n8. Testing Admin Stats (GET /api/admin/stats)...');
    const statsRes = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/stats',
      method: 'GET',
      headers: { Cookie: cookieHeader },
    });
    console.log(`Stats Status: ${statsRes.status}, Total Orders: ${statsRes.body?.stats?.totalOrders}, Total Revenue: £${statsRes.body?.stats?.totalRevenue}`);

    console.log('\n====================================================');
    console.log('  🎉 ALL SUPABASE INTEGRATION TESTS PASSED!');
    console.log('====================================================\n');
  } finally {
    if (spawnedServer) {
      spawnedServer.kill();
      console.log('Local test backend process stopped.');
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
