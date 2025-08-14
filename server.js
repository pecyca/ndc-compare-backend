// server.js
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
    initSqliteBackup,
    buildSuggestIndex,
    // (you'll use these later for routes)
    // querySuggestRAM,
    // getNdcWithAssist,
} from './sqlite-backup.js';
import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Attach Clerk on every request (adds req.auth; getAuth(req) works)
app.use(clerkMiddleware());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Choose DB path (Render persistent disk first, fallback to local)
let dbPath = '/data/merged_ndc_all_records.sqlite';
if (!fs.existsSync(dbPath)) {
    dbPath = path.join(__dirname, 'merged_ndc_all_records.sqlite');
    console.warn('⚠️ Persistent disk not found, using local DB:', dbPath);
} else {
    console.log('✅ Using persistent disk DB path');
}

let db;

async function startServer() {
    try {
        db = await open({ filename: dbPath, driver: sqlite3.Database });
        console.log('✅ SQLite DB connected:', dbPath);

        // ---- Migrations (idempotent) ----
        await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        displayName TEXT,
        isApprovedCommenter INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

        await db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalizedNDC TEXT,
        gpiCode TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('ndc','gpi')),
        comment TEXT NOT NULL,
        author TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_comments_ndc ON comments (normalizedNDC);
      CREATE INDEX IF NOT EXISTS idx_comments_gpi ON comments (gpiCode);
      CREATE INDEX IF NOT EXISTS idx_comments_scope ON comments (scope);
    `);

        // === SQLite backup + suggest (ON STARTUP) ===
        initSqliteBackup();   // reads /data/ndc/fdandc.sqlite using env vars
        buildSuggestIndex();  // loads v_ndc_suggest into RAM for autocomplete
        // ===========================================

        app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}
startServer();


// ---------- Helpers ----------
function stripLeadingZeros(val) {
    return val.replace(/^0+/, '');
}
function normalizeNdcToProductOnly(ndc) {
    const digits = (ndc || '').replace(/\D/g, '').padStart(11, '0');
    const m = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
    if (!m) return ndc;
    const [, labeler, product] = m;
    return `${stripLeadingZeros(labeler)}-${stripLeadingZeros(product)}`;
}

// Pull email/name from Clerk claims safely
function getEmailFromReq(req) {
    const auth = getAuth(req);
    const c = auth?.sessionClaims || {};
    const email =
        (c.email && String(c.email)) ||
        (c.email_address && String(c.email_address)) ||
        (c.primary_email && String(c.primary_email)) ||
        '';
    return email.toLowerCase();
}
function getNameFromReq(req) {
    const auth = getAuth(req);
    const c = auth?.sessionClaims || {};
    return String(c.name || getEmailFromReq(req) || '');
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
    const email = getEmailFromReq(req);
    if (!email.endsWith('@exactcarepharmacy.com')) {
        return res.status(403).json({ error: 'Unauthorized domain' });
    }
    req.userEmail = email;
    req.userName = getNameFromReq(req);
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
        console.error('❌ Approval check failed:', e);
        res.status(500).json({ error: 'Internal error' });
    }
}

// ---------- Public data (comments only if authed + EC domain) ----------
app.get(['/ndc-lookup', '/ndc-lookup2'], async (req, res) => {
    const rawNdc = req.query.ndc || '';
    const normalized = normalizeNdcToProductOnly(rawNdc);

    if (!normalized || !normalized.includes('-')) {
        return res.status(400).json({ error: 'Invalid NDC format' });
    }

    try {
        const drug = await db.get(
            `SELECT * FROM ndc_data WHERE normalizedNDC = ?`,
            [normalized]
        );
        if (!drug) return res.status(404).json({ error: `NDC ${normalized} not found` });

        // Include comments only if signed in AND on EC domain
        const email = getEmailFromReq(req);
        const canSeeComments = email.endsWith('@exactcarepharmacy.com');

        let payload = { ...drug };
        if (canSeeComments) {
            const rows = await db.all(
                `SELECT * FROM comments WHERE scope='ndc' AND normalizedNDC=? ORDER BY createdAt DESC`,
                [normalized]
            );
            payload.comments = rows || [];
        } else {
            payload.comments = [];
        }

        return res.json(payload);
    } catch (err) {
        console.error('❌ /ndc-lookup error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------- Public search ----------
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
        console.error('❌ /search-ndc error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------- Authenticated routes ----------
app.get('/me', requireAuth(), requireExactCareDomain, async (req, res) => {
    try {
        const row = await upsertUserOnAccess(req.userEmail, req.userName);
        res.json({
            email: req.userEmail,
            displayName: req.userName,
            isApprovedCommenter: row?.isApprovedCommenter === 1,
        });
    } catch (e) {
        console.error('❌ /me error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/comments', requireAuth(), requireExactCareDomain, async (req, res) => {
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
        console.error('❌ GET /comments error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/comments', requireAuth(), requireExactCareDomain, requireApprovedCommenter, async (req, res) => {
    const { normalizedNDC, gpiCode, scope, comment } = req.body;

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
            [finalNdc, finalGpi, scope, comment, req.userEmail] // always stamp from auth
        );
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('❌ POST /comments error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------- Proxies ----------
app.use('/proxy/rxnav', async (req, res) => {
    const targetUrl = `https://rxnav.nlm.nih.gov/REST${req.url}`;
    try {
        const response = await fetch(targetUrl);
        const data = await response.text();
        res.type('xml').send(data);
    } catch (error) {
        console.error('❌ RxNav proxy error:', error);
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
        console.error('❌ openFDA proxy error:', error);
        res.status(500).send('Proxy error');
    }
});

// ---------- (Optional) temporary debug endpoint ----------
// Remove once verified
// app.get('/_debug/db', async (_req, res) => {
//   const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
//   res.json(tables.map(t => t.name));
// });
