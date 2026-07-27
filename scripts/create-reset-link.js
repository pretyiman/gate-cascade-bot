// Generates a single-use "set a new password" link for an existing user, for
// when they forget theirs. You send the link manually; there's no self-service
// "forgot password" request in the app. Run locally:
//   node scripts/create-reset-link.js <email>
require('dotenv').config();
const { createResetLinkForEmail } = require('../src/auth');

const [, , email] = process.argv;
if (!email) {
  console.error('Usage: node scripts/create-reset-link.js <email>');
  process.exit(1);
}

try {
  const { token } = createResetLinkForEmail(email);
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

  console.log(`Send this link to ${email} to reset their password (expires in 1 hour, single-use):`);
  console.log(`${baseUrl}/set-password?token=${token}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
