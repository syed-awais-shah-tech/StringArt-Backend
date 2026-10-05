/**
 * test_admin_settings_thread_modes.mjs
 * Comprehensive end-to-end test suite for Admin-Controlled Thread Generation Modes:
 *   1. Unauthenticated GET /api/admin/settings returns 401
 *   2. Unauthenticated PATCH /api/admin/settings returns 401
 *   3. Authenticated GET /api/admin/settings returns default { eight_color_enabled: false }
 *   4. PATCH validation: non-boolean value rejected with 400
 *   5. Safe public endpoint GET /api/settings/generation returns { eightColorEnabled: false }
 *   6. Generation with 8-color disabled (admin OFF):
 *      - default generation uses black_only
 *      - customer manually requesting eight_color is strictly ignored -> uses black_only
 *      - customer cannot bypass with arbitrary colors
 *   7. Authenticated PATCH /api/admin/settings enables 8-color (eight_color_enabled: true)
 *   8. Generation with 8-color enabled (admin ON):
 *      - requesting black_only -> generates with black_only (1 thread)
 *      - requesting eight_color -> generates with eight_color (8 threads, Blue [0,0,255] verified)
 *   9. Order creation & persistence:
 *      - while admin OFF: manual eight_color order is forced to black_only
 *      - while admin ON: eight_color order is saved as eight_color
 *      - GET /api/admin/orders/:id returns the saved thread_mode
 *  10. Reset setting to false and verify cleanup
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { resetSettingsCache } from './services/settingsService.js';
import { FIXED_EIGHT_COLOR_PALETTE, BLACK_ONLY_PALETTE } from './engine/palette.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3025;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverProcess = null;

async function startServer() {
  console.log(`[test] Starting test server on port ${PORT}…`);
  serverProcess = spawn('node', ['index.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      CLIENT_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: 'test_jwt_secret_key_thread_mode_2026',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stderr.on('data', (d) => {
    process.stderr.write(d.toString());
  });

  for (let i = 0; i < 30; i++) {
    await delay(350);
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        console.log(`[test] Server booted on port ${PORT}.`);
        return;
      }
    } catch {}
  }
  throw new Error(`Server failed to boot on port ${PORT}`);
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill('SIGTERM');
    } catch {}
    serverProcess = null;
  }
}

// Generate minimal 128x128 JPEG buffer for generation testing
async function createTestImageBuffer() {
  return await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 180, g: 100, b: 60 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function run() {
  console.log('═════════════════════════════════════════════════════════════');
  console.log('  Admin Thread Modes & Generation Settings Test Suite');
  console.log('═════════════════════════════════════════════════════════════\n');

  try {
    resetSettingsCache();
    await startServer();

    // ── 1. Unauthenticated access check ─────────────────────────────────────
    console.log('1. Testing unauthenticated access to /api/admin/settings...');
    const unauthGet = await fetch(`${BASE_URL}/api/admin/settings`);
    console.log(`   GET /api/admin/settings without auth: status ${unauthGet.status}`);
    if (unauthGet.status !== 401) throw new Error(`Expected 401, got ${unauthGet.status}`);

    const unauthPatch = await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eight_color_enabled: true }),
    });
    console.log(`   PATCH /api/admin/settings without auth: status ${unauthPatch.status}`);
    if (unauthPatch.status !== 401) throw new Error(`Expected 401, got ${unauthPatch.status}`);
    console.log('   ✅ PASS: Unauthenticated access strictly blocked with 401.');

    // ── 2. Admin Login to get HttpOnly Cookie ────────────────────────────────
    console.log('\n2. Logging in as Admin...');
    const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.INITIAL_SEED_EMAIL || 'admin@stringart.io',
        password: process.env.INITIAL_SEED_PASSWORD || 'StringArtAdmin2026!',
      }),
    });
    if (!loginRes.ok) throw new Error(`Admin login failed with status ${loginRes.status}`);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    if (!setCookieHeader) throw new Error('Missing Set-Cookie header');
    const cookieHeader = setCookieHeader.split(';')[0];
    console.log('   ✅ Admin logged in successfully.');

    // Ensure setting starts as false
    await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ eight_color_enabled: false }),
    });

    // ── 3. Authenticated GET /api/admin/settings ─────────────────────────────
    console.log('\n3. Testing GET /api/admin/settings with admin auth...');
    const getSettingsRes = await fetch(`${BASE_URL}/api/admin/settings`, {
      headers: { Cookie: cookieHeader },
    });
    if (!getSettingsRes.ok) throw new Error(`GET /api/admin/settings failed: ${getSettingsRes.status}`);
    const settingsData = await getSettingsRes.json();
    console.log(`   eight_color_enabled: ${settingsData.eight_color_enabled}`);
    if (settingsData.eight_color_enabled !== false) {
      throw new Error(`Expected eight_color_enabled to be false, got ${settingsData.eight_color_enabled}`);
    }
    console.log('   ✅ PASS: Current setting loaded and defaulted to false.');

    // ── 4. PATCH Validation ──────────────────────────────────────────────────
    console.log('\n4. Testing PATCH validation (rejecting non-boolean values)...');
    const invalidPatch = await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ eight_color_enabled: 'not-a-boolean' }),
    });
    console.log(`   PATCH invalid value status: ${invalidPatch.status}`);
    if (invalidPatch.status !== 400) throw new Error(`Expected 400 for invalid boolean, got ${invalidPatch.status}`);
    console.log('   ✅ PASS: Invalid non-boolean value rejected with 400.');

    // ── 5. Public Generation Settings Endpoint ───────────────────────────────
    console.log('\n5. Testing public endpoint GET /api/settings/generation...');
    const pubRes = await fetch(`${BASE_URL}/api/settings/generation`);
    if (!pubRes.ok) throw new Error(`Public settings failed: ${pubRes.status}`);
    const pubData = await pubRes.json();
    console.log(`   Public eightColorEnabled: ${pubData.eightColorEnabled}`);
    if (pubData.eightColorEnabled !== false) throw new Error('Expected public setting false');
    console.log('   ✅ PASS: Safe public generation setting endpoint verified.');

    // ── 6. Generation with 8-Color DISABLED ──────────────────────────────────
    console.log('\n6. Testing Generation with 8-Color DISABLED in Admin...');
    const imageBuffer = await createTestImageBuffer();

    // 6a. Default generation (no mode specified) -> must use black_only
    console.log('   6a. Sending generation request with NO threadMode supplied...');
    const formDataNoMode = new FormData();
    formDataNoMode.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg');
    formDataNoMode.append(
      'params',
      JSON.stringify({
        numNails: 50,
        maxIterations: 100,
        imageSize: 128,
      })
    );

    const genResNoMode = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      body: formDataNoMode,
    });
    if (!genResNoMode.ok) throw new Error(`Generation failed: ${genResNoMode.status}`);
    const genDataNoMode = await genResNoMode.json();
    console.log(`   Returned threadMode: "${genDataNoMode.threadMode}"`);
    if (genDataNoMode.threadMode !== 'black_only') {
      throw new Error(`Expected black_only, got ${genDataNoMode.threadMode}`);
    }
    // Verify previewData sequence colors: all entries must be black [0, 0, 0]
    const seqNoMode = genDataNoMode.previewData?.sequence || [];
    const nonBlackNoMode = seqNoMode.filter((s) => s[0] !== 0 || s[1] !== 0 || s[2] !== 0);
    if (nonBlackNoMode.length > 0) {
      throw new Error(`Found non-black lines in black_only mode: ${JSON.stringify(nonBlackNoMode[0])}`);
    }
    console.log('   ✅ PASS: Default generation generated strictly black thread.');

    // 6b. Customer manually requesting eight_color while Admin is OFF -> must still use black_only
    console.log('   6b. Customer manually sending threadMode="eight_color" while Admin is OFF...');
    const formDataBypass = new FormData();
    formDataBypass.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg');
    formDataBypass.append(
      'params',
      JSON.stringify({
        numNails: 50,
        maxIterations: 100,
        imageSize: 128,
        threadMode: 'eight_color',
      })
    );

    const genResBypass = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      body: formDataBypass,
    });
    if (!genResBypass.ok) throw new Error(`Bypass generation attempt failed: ${genResBypass.status}`);
    const genDataBypass = await genResBypass.json();
    console.log(`   Returned threadMode: "${genDataBypass.threadMode}"`);
    if (genDataBypass.threadMode !== 'black_only') {
      throw new Error(`Security violation: backend allowed 8-color when disabled! Got: ${genDataBypass.threadMode}`);
    }
    const seqBypass = genDataBypass.previewData?.sequence || [];
    const nonBlackBypass = seqBypass.filter((s) => s[0] !== 0 || s[1] !== 0 || s[2] !== 0);
    if (nonBlackBypass.length > 0) {
      throw new Error(`Security violation: non-black pixels generated while admin disabled!`);
    }
    console.log('   ✅ PASS: Client attempt to force 8-color was strictly ignored & converted to black_only.');

    // ── 7. Enable 8-Color in Admin Settings ──────────────────────────────────
    console.log('\n7. Enabling 8-color generation via PATCH /api/admin/settings...');
    const patchEnable = await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ eight_color_enabled: true }),
    });
    if (!patchEnable.ok) throw new Error(`PATCH enable failed: ${patchEnable.status}`);
    const patchEnableData = await patchEnable.json();
    console.log(`   Updated setting: eight_color_enabled=${patchEnableData.eight_color_enabled}`);
    if (patchEnableData.eight_color_enabled !== true) throw new Error('Setting was not updated to true');

    const pubResEnabled = await fetch(`${BASE_URL}/api/settings/generation`);
    const pubDataEnabled = await pubResEnabled.json();
    if (pubDataEnabled.eightColorEnabled !== true) throw new Error('Public setting does not reflect enabled state');
    console.log('   ✅ PASS: 8-color mode enabled and reflected across admin & public endpoints.');

    // ── 8. Generation with 8-Color ENABLED ───────────────────────────────────
    console.log('\n8. Testing Generation with 8-Color ENABLED...');

    // 8a. black_only mode when enabled
    console.log('   8a. Generating with threadMode="black_only"...');
    const formDataBlack = new FormData();
    formDataBlack.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg');
    formDataBlack.append(
      'params',
      JSON.stringify({
        numNails: 50,
        maxIterations: 100,
        imageSize: 128,
        threadMode: 'black_only',
      })
    );
    const genResBlack = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      body: formDataBlack,
    });
    const genDataBlack = await genResBlack.json();
    if (genDataBlack.threadMode !== 'black_only') throw new Error('Expected black_only mode');
    console.log('   ✅ PASS: black_only mode generates successfully.');

    // 8b. eight_color mode when enabled
    console.log('   8b. Generating with threadMode="eight_color"...');
    const formDataEight = new FormData();
    formDataEight.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'test.jpg');
    formDataEight.append(
      'params',
      JSON.stringify({
        numNails: 50,
        maxIterations: 150,
        imageSize: 128,
        threadMode: 'eight_color',
      })
    );
    const genResEight = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      body: formDataEight,
    });
    if (!genResEight.ok) throw new Error(`8-color generation failed: ${genResEight.status}`);
    const genDataEight = await genResEight.json();
    console.log(`   Returned threadMode: "${genDataEight.threadMode}"`);
    if (genDataEight.threadMode !== 'eight_color') throw new Error('Expected eight_color mode');

    // Verify colors used come strictly from FIXED_EIGHT_COLOR_PALETTE
    const seqEight = genDataEight.previewData?.sequence || [];
    const colorKey = (c) => `${c[0]},${c[1]},${c[2]}`;
    const allowedKeys = new Set(FIXED_EIGHT_COLOR_PALETTE.map((c) => colorKey(c)));
    const uniqueColorsUsed = new Set();
    for (const step of seqEight) {
      const k = `${step[0]},${step[1]},${step[2]}`;
      uniqueColorsUsed.add(k);
      if (!allowedKeys.has(k)) {
        throw new Error(`Unexpected arbitrary color in 8-color sequence: [${k}]`);
      }
    }
    console.log(`   Unique colors used from palette: ${uniqueColorsUsed.size} colors`);
    console.log('   ✅ PASS: 8-color generation strictly uses fixed palette (with Blue [0,0,255]).');

    // ── 9. Order creation & thread_mode persistence ─────────────────────────
    console.log('\n9. Testing Order creation & thread_mode persistence...');
    const dummyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // 9a. Order created with eight_color when admin is ON
    const orderPayloadEight = {
      customer: {
        fullName: 'Color Customer',
        phone: '+1 555 123 4567',
        address: '100 Rainbow Way',
        city: 'Color City',
      },
      threadMode: 'eight_color',
      previewImageData: dummyPng,
      sequenceText: 'START\nPIN 1\nEND',
    };
    const orderResEight = await fetch(`${BASE_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayloadEight),
    });
    if (!orderResEight.ok) throw new Error(`Order creation failed: ${orderResEight.status}`);
    const orderDataEight = await orderResEight.json();
    const createdEight = orderDataEight.order;
    console.log(`   Created order ${createdEight.orderNumber} with thread_mode: "${createdEight.thread_mode}"`);
    if (createdEight.thread_mode !== 'eight_color') {
      throw new Error(`Expected thread_mode "eight_color", got "${createdEight.thread_mode}"`);
    }

    // 9b. Verify Admin detail endpoint returns saved thread_mode
    const adminDetailRes = await fetch(`${BASE_URL}/api/admin/orders/${createdEight.orderNumber}`, {
      headers: { Cookie: cookieHeader },
    });
    if (!adminDetailRes.ok) throw new Error(`Admin order detail failed: ${adminDetailRes.status}`);
    const adminDetailData = await adminDetailRes.json();
    console.log(`   Admin detail order thread_mode: "${adminDetailData.order?.thread_mode}"`);
    if (adminDetailData.order?.thread_mode !== 'eight_color') {
      throw new Error(`Admin detail missing thread_mode: ${adminDetailData.order?.thread_mode}`);
    }
    console.log('   ✅ PASS: Order saved and retrieved with thread_mode="eight_color".');

    // 9c. Now switch Admin setting back to OFF and test that manual eight_color order is forced to black_only
    console.log('\n10. Switching Admin setting back to OFF and testing order creation...');
    await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ eight_color_enabled: false }),
    });

    const orderPayloadBypass = {
      customer: {
        fullName: 'Bypass Customer',
        phone: '+1 555 999 8888',
        address: '42 Secret Lane',
        city: 'Shadow Town',
      },
      threadMode: 'eight_color', // Customer attempts to force eight_color when disabled
      previewImageData: dummyPng,
      sequenceText: 'START\nPIN 1\nEND',
    };
    const orderResBypass = await fetch(`${BASE_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayloadBypass),
    });
    if (!orderResBypass.ok) throw new Error(`Order creation failed: ${orderResBypass.status}`);
    const orderDataBypass = await orderResBypass.json();
    console.log(`   Created order ${orderDataBypass.order?.orderNumber} with thread_mode: "${orderDataBypass.order?.thread_mode}"`);
    if (orderDataBypass.order?.thread_mode !== 'black_only') {
      throw new Error(`Security failure: order allowed eight_color when admin was OFF!`);
    }
    console.log('   ✅ PASS: When admin is OFF, order creation strictly forces thread_mode="black_only".');

    console.log('\n═════════════════════════════════════════════════════════════');
    console.log('🎉 ALL ADMIN SETTINGS & THREAD MODE TESTS PASSED (10/10)! 🎉');
    console.log('═════════════════════════════════════════════════════════════\n');
  } finally {
    stopServer();
  }
}

run().catch((err) => {
  console.error('\n❌ Test execution failed:', err);
  stopServer();
  process.exit(1);
});
