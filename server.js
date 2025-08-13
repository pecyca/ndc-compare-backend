// === ✅ server.js — Comments only visible to authenticated ExactCare users ===
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ClerkExpressWithAuth from '@clerk/express'; // Clerk middleware

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === DB path handling (unchanged) ===
let dbPath = '/data/merged_ndc_all_records.sqlite';
if (!fs.existsSync(dbPath)) {
    dbPath = path.join(__dirname, 'merged_ndc_all_records.sqlite');
    console.warn('⚠️ Persistent disk not found, using local DB:', dbPath);
} else {
    console.log('✅ Using persistent disk DB path');
}

let db;

// Startup
async function startServer() {
    try {
        db = await open({ filename: dbPath, driver: sqlite3.Database });
        console.log('✅ SQLite DB connected:', dbPath);

        // Users table for commenter approvals
        await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        displayName TEXT,
        isApprovedCommenter INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

        app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
}
startServer();

// === Helpers ===
function stripLeadingZeros(val) {
    return val.replace(/^0+/, '');
}

function normalizeNdcToProductOnly(ndc) {
    const digits = ndc.replace(/\D/g, '').padStart(11, '0');
    const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
    if (!match) return ndc;
    const [, labeler, product] = match;
    return `${stripLeadingZeros(labeler)}-${stripLeadingZeros(product)}`;
}

// Clerk helpers
const withAuthOptional = ClerkExpressWithAuth(); // attaches req.auth if token present (doesn't force)
const requireAuth = ClerkExpressWithAuth();      // we’ll pair with domain check to enforce

function extractEmailFromReq(req) {
    const claims = req.auth?.sessionClaims || {};
    const email =
        (claims.email && String(claims.email)) ||
        (claims.primary_email && String(claims.primary_email)) ||
        '';
    return email.toLowerCase();
}

async function upsertUserOnAccess(email, displayName) {
    await db.run(
        `INSERT INTO users (email, displayName, isApprovedCommenter)
     VALUES (?, ?, 0)
     ON CONFLICT(email) DO NOTHING`,
        [email, displayName]
    );
    return db.get('SELECT * FROM users WHERE email = ?', [email]);
}

function requireExactCareDomain(req, res, next) {
    const email = extractEmailFromReq(req);
    if (!email.endsWith('@exactcarepharmacy.com')) {
        return res.status(403).json({ error: 'Unauthorized domain' });
    }
    req.userEmail = email;
    const claims = req.auth?.sessionClaims || {};
    req.userName = String(claims.name || email);
    next();
}

async function requireApprovedCommenter(req, res, next) {
    try {
        const user = await upsertUserOnAccess(req.userEmail, req.userName);
        if (!user || user.isApprovedCommenter !== 1) {
            return res.status(403).json({ error: 'Not approved to comment' });
        }
        next();
    } catch (e) {
        console.error('❌ Approval check failed:', e.message);
        res.status(500).json({ error: 'Internal error' });
    }
}

// === Public endpoints (no comments leaked) ===

// /ndc-lookup: public drug data; comments included ONLY if caller is authed + domain OK
app.get('/ndc-lookup', withAuthOptional, async (req, res) => {
    const rawNdc = req.query.ndc || '';
    const normalized = normalizeNdcToProductOnly(rawNdc);

    if (!normalized.includes('-')) {
        return res.status(400).json({ error: 'Invalid NDC format' });
    }

    console.log('🧪 Raw NDC:', rawNdc);
    console.log('🧪 Normalized:', normalized);

    try {
        const check = await db.get(`
      SELECT COUNT(*) as count 
      FROM sqlite_master 
      WHERE type='table' AND name='ndc_data'
    `);
        console.log('🧠 ndc_data table exists:', check.count > 0);

        const drug = await db.get(`SELECT * FROM ndc_data WHERE normalizedNDC = ?`, [normalized]);
        if (!drug) return res.status(404).json({ error: `NDC ${normalized} not found` });

        // Decide if we can include comments
        const email = extractEmailFromReq(req);
        const canSeeComments = email.endsWith('@exactcarepharmacy.com');

        let payload = { ...drug };

        if (canSeeComments) {
            const rows = await db.all(
                `SELECT * FROM comments WHERE scope='ndc' AND normalizedNDC=? ORDER BY createdAt DESC`,
                [normalized]
            );
            payload = { ...payload, comments: rows || [] };
        } else {
            // Ensure public callers never see comments via this route
            payload = { ...payload, comments: [] };
        }

        return res.json(payload);
    } catch (err) {
        console.error('❌ /ndc-lookup error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// /search-ndc: unchanged (public search)
app.get('/search-ndc', async (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 3) return res.status(400).json({ error: 'Query too short' });

    const likeRaw = `%${q}%`;
    const digitsOnly = q.replace(/\D/g, '');
    const likeDigits = `%${digitsOnly}%`;

    try {
        const rows = await db.all(
            `
      SELECT ndc, gpiNDC, brandName, genericName, strength
      FROM ndc_data
      WHERE
        REPLACE(REPLACE(REPLACE(gpiNDC, '-', ''), '.', ''), ' ', '') LIKE ? OR
        LOWER(brandName) LIKE ? OR
        LOWER(genericName) LIKE ? OR
        LOWER(substanceName) LIKE ?
      LIMIT 12
    `,
            [likeDigits, likeRaw, likeRaw, likeRaw]
        );

        const results = rows.map((row) => ({
            ndc: row.ndc,
            brandName: row.brandName,
            genericName: row.genericName,
            strength: row.strength,
        }));

        res.json({ results });
    } catch (err) {
        console.error('❌ /search-ndc error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === Authenticated endpoints (read/write comments) ===

// Who am I? (used by frontend to know approval state)
app.get('/me', requireAuth, requireExactCareDomain, async (req, res) => {
    try {
        const row = await upsertUserOnAccess(req.userEmail, req.userName);
        res.json({
            email: req.userEmail,
            displayName: req.userName,
            isApprovedCommenter: row?.isApprovedCommenter === 1,
        });
    } catch (e) {
        console.error('❌ /me error:', e.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// READ comments (auth + ExactCare only)
app.get('/comments', requireAuth, requireExactCareDomain, async (req, res) => {
    const { normalizedNDC, gpiCode } = req.query;

    try {
        if (normalizedNDC) {
            const rows = await db.all(
                `SELECT * FROM comments WHERE scope='ndc' AND normalizedNDC=? ORDER BY createdAt DESC`,
                [normalizedNDC]
            );
            return res.json(rows);
        }

        if (gpiCode) {
            const rows = await db.all(
                `SELECT * FROM comments WHERE scope='gpi' AND gpiCode=? ORDER BY createdAt DESC`,
                [gpiCode]
            );
            return res.json(rows);
        }

        return res.status(400).json({ error: 'Missing normalizedNDC or gpiCode' });
    } catch (err) {
        console.error('❌ /comments error:', err.message);
        return res.status(500).json({ error: 'Internal error' });
    }
});

// WRITE comments (auth + ExactCare + approved)
app.post('/comments', requireAuth, requireExactCareDomain, requireApprovedCommenter, async (req, res) => {
    const { normalizedNDC, gpiCode, scope, comment, author } = req.body;

    if (!['ndc', 'gpi'].includes(scope)) {
        return res.status(400).json({ error: 'Invalid scope' });
    }
    if (!comment) {
        return res.status(400).json({ error: 'Missing comment' });
    }

    const finalNdc = scope === 'ndc' ? normalizedNDC : null;
    const finalGpi = scope === 'gpi' ? gpiCode : null;

    try {
        await db.run(
            `INSERT INTO comments (normalizedNDC, gpiCode, scope, comment, author)
       VALUES (?, ?, ?, ?, ?)`,
            [finalNdc, finalGpi, scope, comment, author || req.userEmail]
        );
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('❌ POST /comments error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === Proxies (unchanged) ===
app.use('/proxy/rxnav', async (req, res) => {
    const targetUrl = `https://rxnav.nlm.nih.gov/REST${req.url}`;
    try {
        const response = await fetch(targetUrl);
        const data = await response.text();
        res.type('xml').send(data);
    } catch (error) {
        console.error('❌ RxNav proxy error:', error.message);
        res.status(500).send('Proxy error');
    }
});

app.use('/proxy/openfda', async (req, res) => {
    const targetUrl = `https://api.fda.gov${req.url}`;
    try {
        const response = await fetch(targetUrl);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('❌ openFDA proxy error:', error.message);
        res.status(500).send('Proxy error');
    }
});
