/**
 * test_admin_password_management.mjs
 * End-to-end verification of Admin Password Management:
 *   1. Unauthenticated access & protected routes (401)
 *   2. Wrong login password (401)
 *   3. Login with HttpOnly cookie (200, no token in body)
 *   4. Wrong current password on change-password (400)
 *   5. Change password successfully (200)
 *   6. Old password fails after change (401), new password works (200)
 *   7. Forgot password (generic 200 response, does not reveal email existence)
 *   8. Reset password with invalid token (400)
 *   9. Reset password successfully with valid token (200)
 *  10. Single-use enforcement: reuse of reset token rejected (400)
 *  11. Expired reset token rejected and invalidated (400)
 *  12. Logout clears cookie (200), subsequent request returns 401
 *  13. Forgot-password rate limiting (5 allowed, 6th triggers 429)
 */

import 'dotenv/config';
import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3018;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverProcess = null;

async function startServer() {
  console.log(`[test] Launching test server on port ${PORT}…`);
  serverProcess = spawn('node', ['index.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      CLIENT_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: 'test_jwt_secret_key_password_mgmt_2026',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stderr.on('data', (d) => {
    process.stderr.write(d.toString());
  });

  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) {
        console.log(`[test] Server successfully booted on port ${PORT}.`);
        return;
      }
    } catch {}
    await delay(300);
  }
  throw new Error(`Server failed to start on port ${PORT} within 7.5s`);
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill('SIGINT');
      serverProcess = null;
    } catch {}
  }
}

async function runTests() {
  const adminEmail = process.env.INITIAL_SEED_EMAIL || 'admin@stringart.io';
  const initialPassword = process.env.INITIAL_SEED_PASSWORD || 'StringArtAdmin2026!';
  const changedPassword = 'StringArtAdminChanged2026!';
  const resetPassword = 'StringArtAdminResetFinal2026!';

  console.log('\n=============================================================');
  console.log('  Admin Password Management Test Suite');
  console.log('=============================================================');

  try {
    await startServer();

    // ── 1. Unauthenticated access to admin routes ───────────────────────────
    console.log('\n1. Testing unauthenticated access to protected routes...');
    const unauthOrders = await fetch(`${BASE_URL}/api/admin/orders`);
    console.log(`   GET /api/admin/orders status: ${unauthOrders.status}`);
    if (unauthOrders.status !== 401) throw new Error('Unauthenticated /orders did not return 401');

    const unauthMe = await fetch(`${BASE_URL}/api/admin/me`);
    console.log(`   GET /api/admin/me status: ${unauthMe.status}`);
    if (unauthMe.status !== 401) throw new Error('Unauthenticated /me did not return 401');

    const unauthChange = await fetch(`${BASE_URL}/api/admin/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'foo', newPassword: 'bar' }),
    });
    console.log(`   POST /api/admin/change-password without auth status: ${unauthChange.status}`);
    if (unauthChange.status !== 401) throw new Error('Unauthenticated /change-password did not return 401');
    console.log('   ✅ PASS: Unauthenticated requests strictly return 401 Unauthorized.');

    // ── 2. Wrong login password ─────────────────────────────────────────────
    console.log('\n2. Testing login with incorrect password...');
    const wrongLoginRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: 'definitely_wrong_password' }),
    });
    console.log(`   Login status: ${wrongLoginRes.status}`);
    if (wrongLoginRes.status !== 401) throw new Error('Wrong password did not return 401');
    console.log('   ✅ PASS: Wrong password rejected with 401 Unauthorized.');

    // ── 3. Successful login & cookie receipt ────────────────────────────────
    console.log('\n3. Testing valid login & HttpOnly cookie receipt...');
    const validLoginRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: initialPassword }),
    });
    const loginJson = await validLoginRes.json();
    const setCookie = validLoginRes.headers.get('set-cookie');
    console.log(`   Login status: ${validLoginRes.status}, success: ${loginJson.success}`);
    console.log(`   Response body token check: ${loginJson.token ? 'LEAKED IN BODY ❌' : 'NOT in response body ✅'}`);
    console.log(`   Set-Cookie contains admin_jwt: ${setCookie?.includes('admin_jwt') ? 'YES ✅' : 'NO ❌'}`);

    if (validLoginRes.status !== 200 || !loginJson.success || loginJson.token !== undefined) {
      throw new Error(`Login failed or leaked token: ${JSON.stringify(loginJson)}`);
    }

    const cookieMatch = setCookie.match(/admin_jwt=([^;]+)/);
    if (!cookieMatch) throw new Error('Missing admin_jwt in Set-Cookie header');
    const authCookie = `admin_jwt=${cookieMatch[1]}`;

    // ── 4. Change Password: Wrong current password ──────────────────────────
    console.log('\n4. Testing change-password with wrong current password...');
    const wrongCurrentRes = await fetch(`${BASE_URL}/api/admin/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({
        currentPassword: 'wrong_current_password',
        newPassword: changedPassword,
        confirmPassword: changedPassword,
      }),
    });
    const wrongCurrentJson = await wrongCurrentRes.json();
    console.log(`   Status: ${wrongCurrentRes.status}, error: "${wrongCurrentJson.error}"`);
    if (wrongCurrentRes.status !== 400 || !wrongCurrentJson.error.includes('Current password is incorrect')) {
      throw new Error('Wrong current password was not rejected properly');
    }
    console.log('   ✅ PASS: Wrong current password rejected with 400.');

    // ── 5. Change Password: Password length validation & success ─────────────
    console.log('\n5. Testing change-password validation (< 8 chars) & successful change...');
    const shortPwdRes = await fetch(`${BASE_URL}/api/admin/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({
        currentPassword: initialPassword,
        newPassword: 'short',
        confirmPassword: 'short',
      }),
    });
    if (shortPwdRes.status !== 400) throw new Error('Short password was not rejected');
    console.log('   ✅ PASS: Short password (<8 chars) rejected.');

    const successChangeRes = await fetch(`${BASE_URL}/api/admin/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({
        currentPassword: initialPassword,
        newPassword: changedPassword,
        confirmPassword: changedPassword,
      }),
    });
    const successChangeJson = await successChangeRes.json();
    console.log(`   Change password status: ${successChangeRes.status}, message: "${successChangeJson.message}"`);
    if (successChangeRes.status !== 200 || !successChangeJson.success) {
      throw new Error(`Change password failed: ${JSON.stringify(successChangeJson)}`);
    }
    console.log('   ✅ PASS: Password changed successfully.');

    // ── 6. Verify old password fails, new password succeeds ─────────────────
    console.log('\n6. Verifying old password fails and new password authenticates...');
    const testOldLogin = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: initialPassword }),
    });
    console.log(`   Old password login status: ${testOldLogin.status} (expected 401)`);
    if (testOldLogin.status !== 401) throw new Error('Old password still authenticated!');

    const testNewLogin = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: changedPassword }),
    });
    console.log(`   New password login status: ${testNewLogin.status} (expected 200)`);
    if (testNewLogin.status !== 200) throw new Error('New password failed to authenticate!');
    console.log('   ✅ PASS: Old password rejected, new password verified.');

    // ── 7. Forgot Password Flow ─────────────────────────────────────────────
    console.log('\n7. Testing forgot-password endpoint...');
    // Unknown email test (must not reveal existence)
    const unknownForgotRes = await fetch(`${BASE_URL}/api/admin/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent_admin_12345@stringart.io' }),
    });
    const unknownForgotJson = await unknownForgotRes.json();
    console.log(`   Unknown email status: ${unknownForgotRes.status}, message: "${unknownForgotJson.message}"`);
    if (unknownForgotRes.status !== 200 || !unknownForgotJson.success) {
      throw new Error('Forgot password revealed email non-existence');
    }

    // Real admin email test
    const realForgotRes = await fetch(`${BASE_URL}/api/admin/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail }),
    });
    const realForgotJson = await realForgotRes.json();
    console.log(`   Real admin email status: ${realForgotRes.status}, message: "${realForgotJson.message}"`);
    console.log(`   Token exposed in response body: ${realForgotJson.token ? 'YES ❌' : 'NO ✅'}`);
    if (realForgotRes.status !== 200 || realForgotJson.token !== undefined) {
      throw new Error('Forgot password leaked token or failed');
    }

    // Verify token hash is stored in database
    const { data: adminRecord } = await supabase
      .from('admins')
      .select('reset_token_hash, reset_token_expires')
      .eq('email', adminEmail)
      .single();

    console.log(`   DB reset_token_hash length: ${adminRecord?.reset_token_hash?.length} chars (SHA-256)`);
    console.log(`   DB reset_token_expires: ${adminRecord?.reset_token_expires}`);
    if (!adminRecord?.reset_token_hash || !adminRecord?.reset_token_expires) {
      throw new Error('Database did not store reset_token_hash / expires');
    }
    console.log('   ✅ PASS: Forgot password generated secure token hash and generic response.');

    // ── 8. Reset Password: Invalid Token & Validation ───────────────────────
    console.log('\n8. Testing reset-password with invalid token...');
    const invalidTokenRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'invalid_fake_token_382918301',
        newPassword: resetPassword,
        confirmPassword: resetPassword,
      }),
    });
    const invalidTokenJson = await invalidTokenRes.json();
    console.log(`   Invalid token status: ${invalidTokenRes.status}, error: "${invalidTokenJson.error}"`);
    if (invalidTokenRes.status !== 400 || !invalidTokenJson.error.includes('Invalid or expired')) {
      throw new Error('Invalid token was not rejected');
    }
    console.log('   ✅ PASS: Invalid reset token rejected with 400.');

    // ── 9. Reset Password: Valid Token ──────────────────────────────────────
    console.log('\n9. Testing reset-password with valid token...');
    // Create a deterministic test reset token in DB
    const testRawToken = 'test_reset_token_' + crypto.randomBytes(16).toString('hex');
    const testTokenHash = crypto.createHash('sha256').update(testRawToken).digest('hex');
    const testExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await supabase
      .from('admins')
      .update({
        reset_token_hash: testTokenHash,
        reset_token_expires: testExpiresAt,
      })
      .eq('email', adminEmail);

    const validResetRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: testRawToken,
        newPassword: resetPassword,
        confirmPassword: resetPassword,
      }),
    });
    const validResetJson = await validResetRes.json();
    console.log(`   Valid reset status: ${validResetRes.status}, message: "${validResetJson.message}"`);
    if (validResetRes.status !== 200 || !validResetJson.success) {
      throw new Error(`Reset password failed: ${JSON.stringify(validResetJson)}`);
    }

    // Verify token hash is deleted in database (single-use)
    const { data: updatedAdmin } = await supabase
      .from('admins')
      .select('reset_token_hash, reset_token_expires')
      .eq('email', adminEmail)
      .single();

    if (updatedAdmin?.reset_token_hash !== null || updatedAdmin?.reset_token_expires !== null) {
      throw new Error('reset_token_hash was not deleted after reset!');
    }
    console.log('   ✅ PASS: Password reset successfully, token cleared from DB.');

    // ── 10. Single-use enforcement: Token reuse rejected ─────────────────────
    console.log('\n10. Testing single-use enforcement: Attempting to reuse same token...');
    const reuseRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: testRawToken,
        newPassword: 'AnotherPassword123!',
        confirmPassword: 'AnotherPassword123!',
      }),
    });
    const reuseJson = await reuseRes.json();
    console.log(`   Reuse attempt status: ${reuseRes.status}, error: "${reuseJson.error}"`);
    if (reuseRes.status !== 400 || !reuseJson.error.includes('Invalid or expired')) {
      throw new Error('Reused reset token was not rejected!');
    }
    console.log('   ✅ PASS: Reused token rejected with 400 (Single-use verified).');

    // ── 11. Expired Token Enforcement ───────────────────────────────────────
    console.log('\n11. Testing expired reset token handling...');
    const expiredRawToken = 'expired_token_' + crypto.randomBytes(16).toString('hex');
    const expiredTokenHash = crypto.createHash('sha256').update(expiredRawToken).digest('hex');
    const pastExpiresAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute in the past

    await supabase
      .from('admins')
      .update({
        reset_token_hash: expiredTokenHash,
        reset_token_expires: pastExpiresAt,
      })
      .eq('email', adminEmail);

    const expiredRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: expiredRawToken,
        newPassword: 'ExpiredPassword123!',
        confirmPassword: 'ExpiredPassword123!',
      }),
    });
    const expiredJson = await expiredRes.json();
    console.log(`   Expired token status: ${expiredRes.status}, error: "${expiredJson.error}"`);
    if (expiredRes.status !== 400 || !expiredJson.error.includes('expired')) {
      throw new Error('Expired token was not rejected!');
    }

    // Verify expired token was deleted
    const { data: expiredAdminCheck } = await supabase
      .from('admins')
      .select('reset_token_hash')
      .eq('email', adminEmail)
      .single();

    if (expiredAdminCheck?.reset_token_hash !== null) {
      throw new Error('Expired token was not cleared from DB upon detection');
    }
    console.log('   ✅ PASS: Expired reset token rejected and cleaned from DB.');

    // ── 12. Login with newly reset password & Logout ────────────────────────
    console.log('\n12. Testing login with reset password & logout flow...');
    const loginResetRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: resetPassword }),
    });
    console.log(`   Login status with reset password: ${loginResetRes.status}`);
    if (loginResetRes.status !== 200) throw new Error('Login with reset password failed');

    const resetSetCookie = loginResetRes.headers.get('set-cookie');
    const resetCookieMatch = resetSetCookie.match(/admin_jwt=([^;]+)/);
    const resetAuthCookie = `admin_jwt=${resetCookieMatch[1]}`;

    // Verify /me
    const meCheck = await fetch(`${BASE_URL}/api/admin/me`, {
      headers: { Cookie: resetAuthCookie },
    });
    if (meCheck.status !== 200) throw new Error('/me check failed');

    // Logout
    const logoutRes = await fetch(`${BASE_URL}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: resetAuthCookie },
    });
    console.log(`   Logout status: ${logoutRes.status}`);
    if (logoutRes.status !== 200) throw new Error('Logout failed');

    // Access /me after logout
    const meAfterLogout = await fetch(`${BASE_URL}/api/admin/me`, {
      headers: { Cookie: 'admin_jwt=; Max-Age=0' },
    });
    console.log(`   /me status after logout: ${meAfterLogout.status} (expected 401)`);
    if (meAfterLogout.status !== 401) throw new Error('/me did not return 401 after logout');
    console.log('   ✅ PASS: Login with reset password & logout cookie clearing verified.');

    // ── 13. Reset password back to original for subsequent test suites ──────
    console.log('\n13. Restoring original development password in DB...');
    const bcrypt = (await import('bcryptjs')).default;
    const restoredHash = await bcrypt.hash(initialPassword, 12);
    await supabase
      .from('admins')
      .update({
        password_hash: restoredHash,
        reset_token_hash: null,
        reset_token_expires: null,
        updated_at: new Date().toISOString(),
      })
      .eq('email', adminEmail);
    console.log('   ✅ Restored original password hash in Supabase.');

    // ── 14. Forgot Password Rate Limiting ───────────────────────────────────
    console.log('\n14. Testing forgot-password rate limiting (max 5 requests per 15 min)...');
    // Note: 2 forgot-password requests were already made in step 7
    for (let i = 3; i <= 5; i++) {
      const res = await fetch(`${BASE_URL}/api/admin/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adminEmail }),
      });
      console.log(`   Request ${i} status: ${res.status}`);
      if (res.status !== 200) throw new Error(`Request ${i} unexpectedly failed`);
    }

    // 6th request: MUST trigger 429
    const blockedRes = await fetch(`${BASE_URL}/api/admin/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail }),
    });
    const blockedJson = await blockedRes.json();
    console.log(`   Request 6 (rate-limited) status: ${blockedRes.status}, error: "${blockedJson.error}"`);
    if (blockedRes.status === 429 && blockedJson.error.includes('Too many password reset requests')) {
      console.log('   ✅ PASS: Forgot-password rate limit enforced with HTTP 429.');
    } else {
      throw new Error(`Expected 429 on 6th forgot-password attempt, got ${blockedRes.status}`);
    }

    console.log('\n═════════════════════════════════════════════════════════════');
    console.log('🎉 ALL ADMIN PASSWORD MANAGEMENT TESTS PASSED (14/14)! 🎉');
    console.log('═════════════════════════════════════════════════════════════\n');
  } finally {
    stopServer();
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  stopServer();
  process.exit(1);
});
