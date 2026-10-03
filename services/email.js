/**
 * services/email.js
 * Transactional email service for StringArt administrative events
 */

import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
    });
  } else {
    // Development / test fallback transport: logs email dispatch safely
    transporter = {
      sendMail: async (mailOptions) => {
        console.log(`[email] Simulated dispatch: Password reset email sent to ${mailOptions.to}`);
        if (process.env.NODE_ENV !== 'production') {
          globalThis.__lastSentEmail = mailOptions;
        }
        return { messageId: 'simulated_' + Date.now() };
      },
    };
  }

  return transporter;
}

/**
 * Send password reset email with secure token link
 * @param {Object} params
 * @param {string} params.to - Recipient admin email
 * @param {string} params.resetUrl - Full reset link URL
 */
export async function sendPasswordResetEmail({ to, resetUrl }) {
  const mailer = getTransporter();
  const from = process.env.EMAIL_FROM || 'StringArt Security <security@stringart.io>';

  const subject = 'Reset Your StringArt Admin Password';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f6f6f7; margin: 0; padding: 24px; color: #202223; }
        .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e1e3e5; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .header { text-align: center; margin-bottom: 24px; }
        .title { font-size: 20px; font-weight: 600; color: #202223; margin: 0 0 8px 0; }
        .subtitle { font-size: 14px; color: #6d7175; margin: 0; }
        .content { font-size: 14px; line-height: 1.6; color: #444746; margin: 24px 0; }
        .btn-wrapper { text-align: center; margin: 28px 0; }
        .btn { display: inline-block; background-color: #008060; color: #ffffff !important; font-weight: 500; font-size: 14px; padding: 12px 24px; border-radius: 6px; text-decoration: none; }
        .note { font-size: 12px; color: #8c9196; border-top: 1px solid #e1e3e5; padding-top: 16px; margin-top: 24px; }
        .link-text { font-size: 12px; color: #008060; word-break: break-all; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 class="title">StringArt Administrator Portal</h1>
          <p class="subtitle">Password Reset Request</p>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>A request was received to reset the password for your administrator account. Click the button below to choose a new password:</p>
          <div class="btn-wrapper">
            <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
          </div>
          <p>Or paste this URL into your browser:</p>
          <p class="link-text"><a href="${resetUrl}" style="color: #008060;">${resetUrl}</a></p>
        </div>
        <div class="note">
          <p><strong>Note:</strong> This link is valid for <strong>30 minutes</strong> and can only be used once.</p>
          <p>If you did not request a password reset, you can safely disregard this email. Your password will remain unchanged.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = `
StringArt Administrator Portal - Password Reset

A request was received to reset the password for your administrator account.

To reset your password, visit the following link:
${resetUrl}

This link is valid for 30 minutes and can only be used once.

If you did not request this, please ignore this email.
  `.trim();

  return mailer.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}
