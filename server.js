const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Atlas Connected Successfully'))
    .catch((err) => console.error('MongoDB Connection Error:', err));

// ==================== DATABASE SCHEMAS & MODELS ====================

// 1. Users Collection
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['student', 'admin'], default: 'student' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 2. Items Collection
const itemSchema = new mongoose.Schema({
    type: { type: String, enum: ['lost', 'found'], required: true },
    category: {
        type: String,
        enum: ['ID Card', 'Wallet', 'Keys', 'Electronics', 'Books', 'Bag', 'Clothing', 'Other'],
        required: true
    },
    color: {
        type: String,
        enum: ['Black', 'White', 'Blue', 'Red', 'Green', 'Brown', 'Grey', 'Other'],
        required: true
    },
    description: { type: String, required: true },
    location: {
        type: String,
        enum: [
            'Library',
            "Lara's Cafe",
            'Hostel',
            'Admin Block',
            'Golden Jubilee',
            'Sports Ground',
            'Parking',
            'Other',
            'Unknown'
        ],
        required: true
    },
    date: { type: Date, required: true },
    imageUrl: { type: String, required: true },
    status: {
        type: String,
        enum: ['Reported', 'Matched', 'Claim Pending', 'Verified', 'Returned', 'Closed'],
        default: 'Reported'
    },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    verificationQuestion: { type: String }, // Required for 'found' items only
    createdAt: { type: Date, default: Date.now }
});
const Item = mongoose.model('Item', itemSchema);

// 3. Claims Collection
const claimSchema = new mongoose.Schema({
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
    claimant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    answer: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
const Claim = mongoose.model('Claim', claimSchema);

// 4. Notifications Collection
const notificationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
    relatedItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Notification = mongoose.model('Notification', notificationSchema);

// ==================== IMAGE UPLOAD CONFIGURATION ====================
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create the uploads folder if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Serve the uploads folder as static files so the frontend can display them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); // Save files to the local uploads directory
    },
    filename: function (req, file, cb) {
        // Rename the file to prevent conflicts: timestamp + original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

// Initialize Multer
const upload = multer({ storage: storage });

// ==================== AUTHENTICATION ROUTES ====================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists.' });
        }

        // Hash password 
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Create and save user
        const newUser = new User({ name, email, passwordHash, role });
        await newUser.save();

        res.status(201).json({ message: 'User registered successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        // Compare password 
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        // Generate JWT 
        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.status(200).json({ token, message: 'Logged in successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// ==================== MIDDLEWARE ====================
// Verify JWT Token
const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

    try {
        // Remove 'Bearer ' if it exists
        const verified = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (error) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

// ==================== ITEM ROUTES ====================

// POST /api/items (FR-2 & FR-3: Report Lost/Found Item)
app.post('/api/items', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        const { type, category, color, description, location, date, verificationQuestion } = req.body;

        // NEW: Prevent 'found' items from using 'Unknown' location
        if (type === 'found' && location === 'Unknown') {
            return res.status(400).json({ message: 'Found items must have a specific location.' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'Image is required.' });
        }

        const imageUrl = `/uploads/${req.file.filename}`;

        const newItem = new Item({
            type,
            category,
            color,
            description,
            location,
            date,
            imageUrl,
            verificationQuestion, // Will be saved if item is 'found'
            reportedBy: req.user.userId
        });

        await newItem.save();
        res.status(201).json({ message: `Successfully reported ${type} item.`, item: newItem });
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// GET /api/items (FR-4: Search and filter items)
app.get('/api/items', authMiddleware, async (req, res) => {
    try {
        // Build a dynamic filter object based on query parameters
        const filter = {};
        if (req.query.type) filter.type = req.query.type;
        if (req.query.category) filter.category = req.query.category;
        if (req.query.color) filter.color = req.query.color;
        if (req.query.location) filter.location = req.query.location;
        if (req.query.status) filter.status = req.query.status;

        // Fetch items from the database, newest first
        const items = await Item.find(filter)
            .sort({ createdAt: -1 })
            .populate('reportedBy', 'name email'); // Includes the reporter's name/email

        res.status(200).json(items);
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// GET /api/items/:id/matches (FR-5: Suggest possible matches using a weighted score)
app.get('/api/items/:id/matches', authMiddleware, async (req, res) => {
    try {
        const targetItem = await Item.findById(req.params.id);
        if (!targetItem) {
            return res.status(404).json({ message: 'Item not found.' });
        }

        // We only want to match 'lost' items with 'found' items, and vice versa
        const oppositeType = targetItem.type === 'lost' ? 'found' : 'lost';

        // Fetch potential candidates
        const potentialMatches = await Item.find({ type: oppositeType });

        const scoredMatches = potentialMatches.map(item => {
            let score = 0;

            // 1. Category match (40 points)
            if (item.category === targetItem.category) score += 40;

            // 2. Color match (20 points)
            if (item.color === targetItem.color) score += 20;

            // 3. Location match (20 points for exact match, 10 points if either is Unknown)
            if (item.location === targetItem.location) {
                score += 20;
            } else if (item.location === 'Unknown' || targetItem.location === 'Unknown') {
                score += 10;
            }

            // 4. Date within 3 days (20 points)
            const timeDiff = Math.abs(new Date(item.date) - new Date(targetItem.date));
            const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
            if (daysDiff <= 3) score += 20;

            return { item, score };
        });

        // Filter score > 50, sort by highest score, get top 3
        const topMatches = scoredMatches
            .filter(match => match.score > 50)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        res.status(200).json(topMatches);
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// ==================== CLAIM ROUTES ====================

// POST /api/claims (FR-6: Submit a claim for a found item)
app.post('/api/claims', authMiddleware, async (req, res) => {
    try {
        const { itemId, answer } = req.body;

        const item = await Item.findById(itemId);
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }
        if (item.type !== 'found') {
            return res.status(400).json({ message: 'You can only submit claims for found items.' });
        }

        // 1. Create the claim
        const newClaim = new Claim({
            item: itemId,
            claimant: req.user.userId,
            answer
        });
        await newClaim.save();

        // 2. Update the item's status
        item.status = 'Claim Pending';
        await item.save();

        // 3. Create a notification for the user who reported the item
        const notification = new Notification({
            user: item.reportedBy,
            message: `Someone claimed the ${item.color} ${item.category} you found. Please review their answer.`,
            relatedItem: item._id
        });
        await notification.save();

        res.status(201).json({ message: 'Claim submitted successfully.', claim: newClaim });
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// PATCH /api/claims/:id/status (Approve or Reject a claim)
app.patch('/api/claims/:id/status', authMiddleware, async (req, res) => {
    try {
        const { status } = req.body; // Expects 'approved' or 'rejected'
        const claimId = req.params.id;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status.' });
        }

        const claim = await Claim.findById(claimId).populate('item');
        if (!claim) {
            return res.status(404).json({ message: 'Claim not found.' });
        }

        // Security check: Only the person who reported the item can approve/reject claims
        if (claim.item.reportedBy.toString() !== req.user.userId) {
            return res.status(403).json({ message: 'Not authorized. Only the finder can update this claim.' });
        }

        claim.status = status;
        await claim.save();

        // Update the actual item's status based on the decision
        if (status === 'approved') {
            claim.item.status = 'Verified';
        } else if (status === 'rejected') {
            claim.item.status = 'Reported'; // Revert to 'Reported' so others can try to claim it
        }
        await claim.item.save();

        res.status(200).json({ message: `Claim ${status} successfully.`, claim });
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// ==================== NOTIFICATION ROUTES ====================

// GET /api/notifications (Fetch notifications for the logged-in user)
app.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
        const notifications = await Notification.find({ user: req.user.userId })
            .sort({ createdAt: -1 })
            .populate('relatedItem', 'category color type');

        res.status(200).json(notifications);
    } catch (error) {
        res.status(500).json({ message: 'Server error.', error: error.message });
    }
});

// ==================== TEST ROUTE ====================
app.get('/', (req, res) => {
    res.send('FoundIt Campus API is running...');
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});