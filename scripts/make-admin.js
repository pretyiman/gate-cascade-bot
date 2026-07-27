// Promotes an existing user to admin (can invite others / send reset links
// from inside the app). Run locally: node scripts/make-admin.js <email>
require('dotenv').config();
const db = require('../src/db');

const [, , email] = process.argv;
if (!email) {
  console.error('Usage: node scripts/make-admin.js <email>');
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user found with email ${email}`);
  process.exit(1);
}

db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
console.log(`${email} is now an admin.`);
