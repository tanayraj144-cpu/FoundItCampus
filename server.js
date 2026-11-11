// =====================================================================
// FoundIt Campus - Backend (server.js)
// Requirement IDs in comments refer to the SRS / project brief.
// =====================================================================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');

// Cloudinary Imports
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Atlas Connected Successfully'))
    .catch((err) => console.error('MongoDB Connection Error:', err));

// ==================== CONSTANTS ====================
const OPEN_STATUSES = ['Reported', 'Matched', 'Claim Pending']; // items still worth matching
const CLAIMABLE_STATUSES = ['Reported', 'Matched'];             // items that can receive a claim
const MATCH_THRESHOLD = 50;                                     // score must be ABOVE this
const MAX_MATCHES = 3;

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
    imageUrl: { type: String },
    status: {
        type: String,
        enum: ['Reported', 'Matched', 'Claim Pending', 'Verified', 'Returned', 'Closed'],
        default: 'Reported'
    },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    verificationQuestion: { type: String, trim: true }, // Required for 'found' items only
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

// ==================== IMAGE UPLOAD CONFIGURATION (CLOUDINARY) ====================

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'FoundItCampus',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// ==================== HELPERS ====================

// Central error handler for route catch blocks
const handleError = (res, error) => {
    if (error.name === 'ValidationError') {
        const message = Object.values(error.errors).map(e => e.message).join(' ');
        return res.status(400).json({ message });
    }
    if (error.name === 'CastError') {
        return res.status(400).json({ message: 'Invalid value or id in request.' });
    }
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
};

// Reject malformed ids before they reach the database
const validateId = (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ message: 'Invalid id.' });
    }
    next();
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ==================== MATCHING ENGINE (FR-5) ====================

// Score = category 40 + color 20 + location 20 (10 if either is Unknown) + date within 3 days 20
const calculateScore = (a, b) => {
    let score = 0;

    if (a.category === b.category) score += 40;
    if (a.color === b.color) score += 20;

    if (a.location === b.location) {
        score += 20;
    } else if (a.location === 'Unknown' || b.location === 'Unknown') {
        score += 10;
    }

    const timeDiff = Math.abs(new Date(a.date) - new Date(b.date));
    const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
    if (daysDiff <= 3) score += 20;

    return score;
};

// Returns up to MAX_MATCHES opposite-type items scoring above the threshold.
// Verified / Returned / Closed items are excluded.
const findMatches = async (targetItem, populateReporter = false) => {
    const oppositeType = targetItem.type === 'lost' ? 'found' : 'lost';

    const query = Item.find({ type: oppositeType, status: { $in: OPEN_STATUSES } });
    if (populateReporter) query.populate('reportedBy', 'name'); // never expose email here
    const candidates = await query;

    return candidates
        .map(item => ({ item, score: calculateScore(item, targetItem) }))
        .filter(match => match.score > MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_MATCHES);
};

// FR-6 + FR-9: notify both sides of a match and move items Reported -> Matched
const processMatches = async (newItem) => {
    const matches = await findMatches(newItem);
    if (matches.length === 0) return matches;

    const newReporterId = String(newItem.reportedBy);
    const notifications = [];

    // Tell the person who just reported
    notifications.push({
        user: newItem.reportedBy,
        message: `We found ${matches.length} possible match${matches.length > 1 ? 'es' : ''} for your ${newItem.type} ${newItem.color} ${newItem.category}. Open it to review.`,
        relatedItem: newItem._id
    });

    // Tell the people who reported the matching items
    for (const { item } of matches) {
        if (String(item.reportedBy) === newReporterId) continue; // don't notify yourself
        notifications.push({
            user: item.reportedBy,
            message: `A new ${newItem.type} report (${newItem.color} ${newItem.category}) may match your ${item.type} ${item.color} ${item.category}.`,
            relatedItem: item._id
        });
    }
    await Notification.insertMany(notifications);

    // Lifecycle: Reported -> Matched
    const matchedIds = matches.map(m => m.item._id);
    await Item.updateMany({ _id: { $in: matchedIds }, status: 'Reported' }, { status: 'Matched' });
    if (newItem.status === 'Reported') {
        newItem.status = 'Matched';
        await newItem.save();
    }

    return matches;
};

// ==================== AUTH MIDDLEWARE ====================

// Verify JWT Token (NFR-2)
const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

    try {
        const verified = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
        req.user = verified; // { userId, role }
        next();
    } catch (error) {
        res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

// Allow only admins (FR-10)
const adminOnly = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
};

// ==================== AUTHENTICATION ROUTES (FR-1) ====================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    try {
        // Role is never taken from the client; admins are created with seedAdmin.js
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email and password are required.' });
        }

        // NFR-5: input validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Invalid email format.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists.' });
        }

        // NFR-2: hash the password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const newUser = new User({
            name: name.trim(),
            email: normalizedEmail,
            passwordHash,
            role: 'student'
        });
        await newUser.save();

        res.status(201).json({ message: 'User registered successfully.' });
    } catch (error) {
        handleError(res, error);
    }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        const user = await User.findOne({ email: email.trim().toLowerCase() });
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials.' });
        }

        const token = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // The frontend needs the role to decide whether to show the admin page
        res.status(200).json({
            token,
            user: { id: user._id, name: user.name, role: user.role },
            message: 'Logged in successfully.'
        });
    } catch (error) {
        handleError(res, error);
    }
});

// ==================== ITEM ROUTES ====================

// POST /api/items (FR-2 & FR-3: Report Lost/Found Item, FR-5/FR-6: matching + notifications)
app.post('/api/items', authMiddleware, upload.single('image'), async (req, res) => {
    // If validation fails after multer uploads to Cloudinary, clean up the asset
    const fail = async (status, message) => {
        if (req.file && req.file.filename) {
            await cloudinary.uploader.destroy(req.file.filename).catch(() => { });
        }
        return res.status(status).json({ message });
    };

    try {
        const { type, category, color, description, location, date, verificationQuestion } = req.body;

        if (!['lost', 'found'].includes(type)) {
            return await fail(400, 'Type must be "lost" or "found".');
        }

        // Image is required only if the item is 'found'
        if (type === 'found' && !req.file) {
            return await fail(400, 'An image is required for found items.');
        }

        if (type === 'found' && location === 'Unknown') {
            return await fail(400, 'Found items must have a specific location.');
        }

        // FR-8: finder must set a verification question
        if (type === 'found' && (!verificationQuestion || !verificationQuestion.trim())) {
            return await fail(400, 'Found items need a verification question.');
        }

        const newItem = new Item({
            type,
            category,
            color,
            description,
            location,
            date,
            // Cloudinary provides the full secure URL on req.file.path
            imageUrl: req.file ? req.file.path : undefined,
            verificationQuestion: type === 'found' ? verificationQuestion : undefined,
            reportedBy: req.user.userId
        });
        await newItem.save();

        // Matching must never make the report itself fail
        let matches = [];
        try {
            matches = await processMatches(newItem);
        } catch (matchError) {
            console.error('Matching failed:', matchError);
        }

        res.status(201).json({
            message: `Successfully reported ${type} item.`,
            item: newItem,
            matchCount: matches.length
        });
    } catch (error) {
        if (req.file && req.file.filename) {
            await cloudinary.uploader.destroy(req.file.filename).catch(() => { });
        }
        handleError(res, error);
    }
});

// GET /api/items (FR-4: Search and filter items)
app.get('/api/items', authMiddleware, async (req, res) => {
    try {
        const filter = {};
        if (req.query.type) filter.type = req.query.type;
        if (req.query.category) filter.category = req.query.category;
        if (req.query.color) filter.color = req.query.color;
        if (req.query.location) filter.location = req.query.location;
        if (req.query.status) filter.status = req.query.status;
        if (req.query.q) {
            filter.description = { $regex: escapeRegex(String(req.query.q)), $options: 'i' };
        }

        const items = await Item.find(filter)
            .sort({ createdAt: -1 })
            .populate('reportedBy', 'name'); // NFR-3: email is NOT exposed

        res.status(200).json(items);
    } catch (error) {
        handleError(res, error);
    }
});

// GET /api/items/mine (FR-9: items reported by the logged-in user)
// NOTE: must stay ABOVE '/api/items/:id', otherwise Express treats "mine" as an id
app.get('/api/items/mine', authMiddleware, async (req, res) => {
    try {
        const items = await Item.find({ reportedBy: req.user.userId }).sort({ createdAt: -1 });
        res.status(200).json(items);
    } catch (error) {
        handleError(res, error);
    }
});

// GET /api/items/:id (FR-4: item details)
// NFR-3: the finder's contact is only included for a claimant whose claim was approved
app.get('/api/items/:id', authMiddleware, validateId, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id).populate('reportedBy', 'name email');
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }

        const result = item.toObject();
        const reporter = result.reportedBy;

        if (reporter) {
            const isReporter = String(reporter._id) === req.user.userId;

            if (!isReporter && item.type === 'found') {
                const approved = await Claim.findOne({
                    item: item._id,
                    claimant: req.user.userId,
                    status: 'approved'
                });
                if (approved) {
                    result.finderContact = { name: reporter.name, email: reporter.email };
                }
            }

            result.reportedBy = { _id: reporter._id, name: reporter.name }; // hide email
        }

        res.status(200).json(result);
    } catch (error) {
        handleError(res, error);
    }
});

// GET /api/items/:id/matches (FR-5: Suggest possible matches using a weighted score)
app.get('/api/items/:id/matches', authMiddleware, validateId, async (req, res) => {
    try {
        const targetItem = await Item.findById(req.params.id);
        if (!targetItem) {
            return res.status(404).json({ message: 'Item not found.' });
        }

        const topMatches = await findMatches(targetItem, true);
        res.status(200).json(topMatches);
    } catch (error) {
        handleError(res, error);
    }
});

// PATCH /api/items/:id/returned (FR-9: Verified -> Returned, by the finder or an admin)
app.patch('/api/items/:id/returned', authMiddleware, validateId, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }

        const isOwner = String(item.reportedBy) === req.user.userId;
        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Not authorized.' });
        }
        if (item.status !== 'Verified') {
            return res.status(400).json({ message: 'Only verified items can be marked as returned.' });
        }

        item.status = 'Returned';
        await item.save();

        // Let the approved claimant know
        const approvedClaim = await Claim.findOne({ item: item._id, status: 'approved' });
        if (approvedClaim) {
            await Notification.create({
                user: approvedClaim.claimant,
                message: `The ${item.color} ${item.category} has been marked as returned to you.`,
                relatedItem: item._id
            });
        }

        res.status(200).json({ message: 'Item marked as returned.', item });
    } catch (error) {
        handleError(res, error);
    }
});

// ==================== CLAIM ROUTES ====================

// POST /api/claims (FR-7: Submit a claim for a found item)
app.post('/api/claims', authMiddleware, async (req, res) => {
    try {
        const { itemId, answer } = req.body;

        if (!mongoose.isValidObjectId(itemId)) {
            return res.status(400).json({ message: 'Invalid item id.' });
        }
        if (typeof answer !== 'string' || !answer.trim()) {
            return res.status(400).json({ message: 'Answer is required.' });
        }

        const item = await Item.findById(itemId);
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }
        if (item.type !== 'found') {
            return res.status(400).json({ message: 'You can only submit claims for found items.' });
        }
        if (String(item.reportedBy) === req.user.userId) {
            return res.status(400).json({ message: 'You cannot claim an item you reported.' });
        }
        // One pending claim at a time; verified/returned/closed items are not claimable
        if (!CLAIMABLE_STATUSES.includes(item.status)) {
            return res.status(400).json({ message: 'This item is not available for claims.' });
        }
        // One attempt per user, so answers cannot be guessed repeatedly
        const alreadyClaimed = await Claim.findOne({ item: itemId, claimant: req.user.userId });
        if (alreadyClaimed) {
            return res.status(400).json({ message: 'You have already claimed this item.' });
        }

        // 1. Create the claim
        const newClaim = new Claim({
            item: itemId,
            claimant: req.user.userId,
            answer: answer.trim()
        });
        await newClaim.save();

        // 2. Update the item's status
        item.status = 'Claim Pending';
        await item.save();

        // 3. Notify the finder
        await Notification.create({
            user: item.reportedBy,
            message: `Someone claimed the ${item.color} ${item.category} you found. Please review their answer.`,
            relatedItem: item._id
        });

        res.status(201).json({ message: 'Claim submitted successfully.', claim: newClaim });
    } catch (error) {
        handleError(res, error);
    }
});

// GET /api/claims/received (FR-8: claims on the logged-in user's found items)
app.get('/api/claims/received', authMiddleware, async (req, res) => {
    try {
        const myItems = await Item.find({ reportedBy: req.user.userId }).select('_id');

        const filter = { item: { $in: myItems.map(i => i._id) } };
        if (req.query.status) filter.status = req.query.status; // e.g. ?status=pending

        const claims = await Claim.find(filter)
            .sort({ createdAt: -1 })
            .populate('item', 'category color location imageUrl verificationQuestion status')
            .populate('claimant', 'name'); // claimant's email is not exposed

        res.status(200).json(claims);
    } catch (error) {
        handleError(res, error);
    }
});

// GET /api/claims/mine (claims the logged-in user has submitted)
// NFR-3: finder contact is returned ONLY when the claim is approved
app.get('/api/claims/mine', authMiddleware, async (req, res) => {
    try {
        const claims = await Claim.find({ claimant: req.user.userId })
            .sort({ createdAt: -1 })
            .populate({
                path: 'item',
                select: 'category color location imageUrl status reportedBy',
                populate: { path: 'reportedBy', select: 'name email' }
            });

        const result = claims.map(claim => {
            const obj = claim.toObject();
            if (obj.item && obj.item.reportedBy) {
                if (claim.status === 'approved') {
                    obj.finderContact = {
                        name: obj.item.reportedBy.name,
                        email: obj.item.reportedBy.email
                    };
                }
                delete obj.item.reportedBy; // never leak the finder's email otherwise
            }
            return obj;
        });

        res.status(200).json(result);
    } catch (error) {
        handleError(res, error);
    }
});

// PATCH /api/claims/:id/status (FR-8 + FR-9: Approve or Reject a claim)
app.patch('/api/claims/:id/status', authMiddleware, validateId, async (req, res) => {
    try {
        const { status } = req.body; // Expects 'approved' or 'rejected'

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status.' });
        }

        const claim = await Claim.findById(req.params.id).populate('item');
        if (!claim) {
            return res.status(404).json({ message: 'Claim not found.' });
        }
        if (!claim.item) {
            return res.status(404).json({ message: 'The item for this claim no longer exists.' });
        }

        // Only the person who reported the item can decide
        if (String(claim.item.reportedBy) !== req.user.userId) {
            return res.status(403).json({ message: 'Not authorized. Only the finder can update this claim.' });
        }
        // A decision cannot be changed afterwards
        if (claim.status !== 'pending') {
            return res.status(400).json({ message: 'This claim has already been decided.' });
        }

        claim.status = status;
        await claim.save();

        const item = claim.item;
        let message;
        if (status === 'approved') {
            item.status = 'Verified';
            message = `Your claim on the ${item.color} ${item.category} was approved. Finder contact details are now visible on the item. Collect it from the security drop-off point.`;
        } else {
            item.status = 'Reported'; // reopen so others can try to claim it
            message = `Your claim on the ${item.color} ${item.category} was rejected because the answer did not match.`;
        }
        await item.save();

        // Tell the claimant the outcome
        await Notification.create({
            user: claim.claimant,
            message,
            relatedItem: item._id
        });

        res.status(200).json({ message: `Claim ${status} successfully.`, claim });
    } catch (error) {
        handleError(res, error);
    }
});

// ==================== NOTIFICATION ROUTES (FR-6) ====================

// GET /api/notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
        const notifications = await Notification.find({ user: req.user.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('relatedItem', 'category color type');

        res.status(200).json(notifications);
    } catch (error) {
        handleError(res, error);
    }
});

// PATCH /api/notifications/:id/read
app.patch('/api/notifications/:id/read', authMiddleware, validateId, async (req, res) => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, user: req.user.userId }, // users can only touch their own
            { isRead: true },
            { new: true }
        );
        if (!notification) {
            return res.status(404).json({ message: 'Notification not found.' });
        }
        res.status(200).json(notification);
    } catch (error) {
        handleError(res, error);
    }
});

// ==================== ADMIN ROUTES (FR-10) ====================

// GET /api/admin/items
app.get('/api/admin/items', authMiddleware, adminOnly, async (req, res) => {
    try {
        const items = await Item.find()
            .sort({ createdAt: -1 })
            .populate('reportedBy', 'name email');
        res.status(200).json(items);
    } catch (error) {
        handleError(res, error);
    }
});

// PATCH /api/admin/items/:id/close
app.patch('/api/admin/items/:id/close', authMiddleware, adminOnly, validateId, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }
        item.status = 'Closed';
        await item.save();
        res.status(200).json({ message: 'Item closed.', item });
    } catch (error) {
        handleError(res, error);
    }
});

// DELETE /api/admin/items/:id
app.delete('/api/admin/items/:id', authMiddleware, adminOnly, validateId, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) {
            return res.status(404).json({ message: 'Item not found.' });
        }

        // Delete the image file from Cloudinary instead of local storage
        if (item.imageUrl) {
            const filename = item.imageUrl.split('/').pop().split('.')[0];
            await cloudinary.uploader.destroy(`FoundItCampus/${filename}`).catch(() => { });
        }

        await Claim.deleteMany({ item: item._id });
        await Notification.deleteMany({ relatedItem: item._id });
        await item.deleteOne();

        res.status(200).json({ message: 'Item removed.' });
    } catch (error) {
        handleError(res, error);
    }
});

// ==================== TEST ROUTE ====================
app.get('/', (req, res) => {
    res.send('FoundIt Campus API is running...');
});

// ==================== UPLOAD ERROR HANDLER ====================
// Catches multer errors (wrong file type, file too large) and returns a clean 400
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 5 MB.' : err.message;
        return res.status(400).json({ message });
    }
    if (err && err.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: err.message });
    }
    if (err) {
        console.error(err);
        return res.status(500).json({ message: 'Server error.' });
    }
    next();
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});