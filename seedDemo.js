// seedDemo.js
// Loads demo data into FoundIt Campus by calling the REAL API, so matching,
// notifications and status changes work exactly as they do in the app.
// It also acts as a quick smoke test of register, login and report-item.
//
// How to run (needs Node 18 or newer):
//   1. Terminal 1:  node server.js
//   2. Terminal 2:  node seedDemo.js
//
// Optional: set API_URL in .env if the server is not on http://localhost:5000
// Run it once on an empty database. Running again stops if demo data exists.

const zlib = require('zlib');
require('dotenv').config();

const BASE_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;
const PASSWORD = 'demo123';

const USERS = {
    riya: { name: 'Riya Sharma', email: 'riya@demo.com' },
    karthik: { name: 'Karthik Rao', email: 'karthik@demo.com' }
};

// Dates are relative to today so the 3-day matching window always works
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ---------- Demo items ----------
// Created in this order, so a match fires when the second item of a pair is saved.
const ITEMS = [
    // Pair 1: wallet, perfect match
    {
        who: 'riya', type: 'lost', category: 'Wallet', color: 'Black', location: 'Library', daysAgo: 2,
        description: 'Black leather wallet with some cash and a bus pass. Lost near the reading hall.'
    },
    {
        who: 'karthik', type: 'found', category: 'Wallet', color: 'Black', location: 'Library', daysAgo: 1,
        description: 'Black leather wallet found on a table in the Library reading hall.',
        question: 'Which card is kept in the front slot of the wallet?'
    },

    // Pair 2: ID card, found first and then reported lost
    {
        who: 'riya', type: 'found', category: 'ID Card', color: 'Blue', location: 'Admin Block', daysAgo: 2,
        description: 'Blue student ID card found near the Admin Block notice board.',
        question: 'Which department is printed on the card?'
    },
    {
        who: 'karthik', type: 'lost', category: 'ID Card', color: 'Blue', location: 'Admin Block', daysAgo: 3,
        description: 'Lost my blue college ID card somewhere around the Admin Block.'
    },

    // Pair 3: keys, lost location unknown (scores a little lower), lost report has NO photo
    {
        who: 'riya', type: 'lost', category: 'Keys', color: 'Black', location: 'Unknown', daysAgo: 4, photo: false,
        description: 'Room key on a black keychain with a small football charm. Not sure where I dropped it.'
    },
    {
        who: 'karthik', type: 'found', category: 'Keys', color: 'Black', location: 'Hostel', daysAgo: 3,
        description: 'Bunch of keys on a black keychain found in the Hostel corridor.',
        question: 'What charm is attached to the keychain?'
    },

    // Pair 4: earbuds, found at a different place (partial match)
    {
        who: 'karthik', type: 'lost', category: 'Electronics', color: 'White', location: "Lara's Cafe", daysAgo: 5,
        description: 'White wireless earbuds in a charging case. Left them on a table at the cafe.'
    },
    {
        who: 'riya', type: 'found', category: 'Electronics', color: 'White', location: 'Golden Jubilee', daysAgo: 4,
        description: 'White earbuds with a charging case found at Golden Jubilee.',
        question: 'What sticker is on the charging case?'
    },

    // Live demo item: a lost report with NO counterpart yet (see the hint printed at the end)
    {
        who: 'riya', type: 'lost', category: 'Bag', color: 'Red', location: 'Sports Ground', daysAgo: 1,
        description: 'Red sports bag with a water bottle and a towel inside.'
    },

    // Items that should NOT match anything
    {
        who: 'karthik', type: 'found', category: 'Books', color: 'Brown', location: 'Library', daysAgo: 2,
        description: 'Brown hardcover notebook found on a Library shelf.',
        question: 'Whose name is written on the first page?'
    },
    {
        who: 'riya', type: 'found', category: 'Clothing', color: 'Green', location: 'Sports Ground', daysAgo: 1,
        description: 'Green hoodie left on the bench near the Sports Ground.',
        question: 'What is printed on the left sleeve?'
    },
    {
        who: 'karthik', type: 'lost', category: 'Bag', color: 'Grey', location: 'Parking', daysAgo: 3,
        description: 'Grey backpack with a laptop sleeve, lost near the Parking area.'
    }
];

// ---------- Tiny solid-colour PNG generator (so every item has a photo) ----------
const COLORS = {
    Black: [40, 40, 40], White: [235, 235, 235], Blue: [50, 100, 200], Red: [200, 50, 50],
    Green: [50, 160, 80], Brown: [130, 85, 50], Grey: [140, 140, 140], Other: [180, 150, 200]
};

const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
};

const solidPng = ([r, g, b], size = 96) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: RGB
    const row = Buffer.alloc(1 + size * 3); // first byte = filter type 0
    for (let x = 0; x < size; x++) {
        row[1 + x * 3] = r;
        row[2 + x * 3] = g;
        row[3 + x * 3] = b;
    }
    const raw = Buffer.concat(Array(size).fill(row));
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
};

// ---------- API helper ----------
async function api(path, { method = 'GET', token, json, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    }
    if (form) body = form; // fetch sets the multipart boundary itself

    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

async function getToken(user) {
    try {
        await api('/api/auth/register', {
            method: 'POST',
            json: { name: user.name, email: user.email, password: PASSWORD }
        });
        console.log(`Created user ${user.email}`);
    } catch (err) {
        if (!(err.status === 400 && /already exists/i.test(err.message))) throw err;
        console.log(`User ${user.email} already exists, logging in`);
    }
    const { token } = await api('/api/auth/login', {
        method: 'POST',
        json: { email: user.email, password: PASSWORD }
    });
    return token;
}

// ---------- Main ----------
async function main() {
    if (typeof fetch === 'undefined' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
        throw new Error('Node 18 or newer is required to run this script.');
    }

    console.log(`Seeding demo data through ${BASE_URL}\n`);

    const tokens = {};
    for (const key of Object.keys(USERS)) {
        tokens[key] = await getToken(USERS[key]);
    }

    // Do not create duplicates
    for (const key of Object.keys(USERS)) {
        const mine = await api('/api/items/mine', { token: tokens[key] });
        if (mine.length > 0) {
            console.log('\nDemo data already exists, nothing was added.');
            console.log('To reseed, remove the items from the admin page or clear the items, claims and notifications collections in Atlas, then run this again.');
            return;
        }
    }

    console.log('');
    for (const item of ITEMS) {
        const form = new FormData();
        form.append('type', item.type);
        form.append('category', item.category);
        form.append('color', item.color);
        form.append('description', item.description);
        form.append('location', item.location);
        form.append('date', daysAgoISO(item.daysAgo));
        if (item.type === 'found') form.append('verificationQuestion', item.question);
        if (item.photo !== false) {
            const png = solidPng(COLORS[item.color] || COLORS.Other);
            form.append('image', new Blob([png], { type: 'image/png' }), `${item.category.replace(/\s+/g, '-').toLowerCase()}.png`);
        }

        const result = await api('/api/items', { method: 'POST', token: tokens[item.who], form });
        const matchNote = result.matchCount ? `  -> ${result.matchCount} match(es) found` : '';
        console.log(`[${item.who}] ${item.type.padEnd(5)} ${item.color} ${item.category} @ ${item.location}${matchNote}`);
    }

    console.log('\nNotifications created:');
    for (const key of Object.keys(USERS)) {
        const notes = await api('/api/notifications', { token: tokens[key] });
        console.log(`  ${USERS[key].email}: ${notes.length}`);
    }

    console.log(`
Done. Demo logins (password for both: ${PASSWORD}):
  ${USERS.riya.email}     (has lost items and found items)
  ${USERS.karthik.email}  (has lost items and found items)
Admin: log in with the account created by seedAdmin.js.

Ready-made matches: wallet, ID card, keys and earbuds each have a lost and a found report.
Photo-less lost report: Riya's lost keys (checks the placeholder image on the frontend).

Live demo idea: log in as karthik@demo.com and report a FOUND red bag at Sports Ground
(today's date, with a photo and a verification question). Riya's lost red bag will match,
both users get a notification, and then you can run the claim and approval flow on screen.`);
}

main().catch((err) => {
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
        console.error(`Could not reach the API at ${BASE_URL}. Start the server first with: node server.js`);
    } else {
        console.error('Seeding failed:', err.message);
    }
    process.exitCode = 1;
});