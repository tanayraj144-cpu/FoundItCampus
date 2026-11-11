// seedAdmin.js
// One-off script that creates the admin account.
// Run once from the same folder as server.js:   node seedAdmin.js
//
// Optional: set ADMIN_EMAIL and ADMIN_PASSWORD in your .env file.
// Never commit .env to GitHub.

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

// Same schema as the User model in server.js (keep the two in sync)
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['student', 'admin'], default: 'student' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

async function seedAdmin() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB Atlas');

        const email = process.env.ADMIN_EMAIL || 'admin@foundit.com';
        const password = process.env.ADMIN_PASSWORD || 'admin123';

        // Safe to run more than once: skips if the admin already exists
        const existing = await User.findOne({ email });
        if (existing) {
            console.log(`Admin already exists: ${email}`);
            return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        await User.create({ name: 'Admin', email, passwordHash, role: 'admin' });
        console.log(`Admin created. Login with: ${email}`);
    } catch (error) {
        console.error('Seeding failed:', error.message);
    } finally {
        await mongoose.disconnect();
    }
}

seedAdmin();