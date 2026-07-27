// Invite-only account creation. The operator never sees/sets the user's real
// password - this creates the account and prints a single-use link that lets
// them set their own password. Send the link however you want (no email
// integration involved). Run locally:
//   node scripts/create-invite.js <email> [--admin]
require('dotenv').config();
const { inviteUser } = require('../src/auth');

const [, , email, flag] = process.argv;
if (!email) {
  console.error('Usage: node scripts/create-invite.js <email> [--admin]');
  process.exit(1);
}

try {
  const { userId, token } = inviteUser(email, { isAdmin: flag === '--admin' });
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

  console.log(`Created user ${email} (id: ${userId})${flag === '--admin' ? ' [admin]' : ''}.`);
  console.log('Send them this link to set their password (expires in 7 days, single-use):');
  console.log(`${baseUrl}/set-password?token=${token}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
