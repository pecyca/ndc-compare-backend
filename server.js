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
    querySuggestRAM,
    getFromBackupByLabelerProduct,
    mapBackupRow,
} from './sqlite-backup.js';
import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Tunables (override via Render Environment) ----
const DEADLINE_MS = Number(process.env.NDC_BACKUP_DEADLINE_MS || 200); // (kept for health/debug)
const SUGGEST_LIMIT = Number(process.env.NDC_SUGGEST_LIMIT || 250000);
const MIN_DIGITS = Number(process.env.NDC_SUGGEST_MIN_DIGITS || 6);
const ENABLE_TEXT = /^true$/i.test(process.env.NDC_SUGGEST_ENABLE_TEXT || 'false');
const MIN_TEXT = Number(process.env.NDC_SUGGEST_MIN_TEXT || 3);
// ---------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(clerkMiddleware()); // adds req.auth / getAuth(req)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Primary DB path (your app's main DB that has ndc_data)
let dbPath = '/data/merged_ndc_all_records.sqlite';
if (!fs.existsSync(dbPath)) {
    dbPath = path.join(__dirname, 'merged_ndc_all_records.sqlite');
    console.warn('⚠️ Persistent disk not found, using local DB:', dbPath);
} else {
    console.log('✅ Using persistent disk DB path');
}

let db;

// ---- helpers ----
const stripLeadingZeros = (v) => String(v || '').replace(/^0+/, '') || '0';

function deriveLabelerProductCandidates(input) {
    if (!input) return [];
    const raw = String(input).trim();
    const digits = raw.replace(/\D/g, '');
    const out = [];
    const push = (a, b) => out.push(`${stripLeadingZeros(a)}-${stripLeadingZeros(b)}`);

    // If dashed, respect hyphenation
    const parts = raw.split('-');
    if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
        const [a, b, c] = parts;
        const la = a.length, lb = b.length, lc = c.length;
        // Known FDA patterns
        if ((la === 5 && lb === 4 && lc === 2) || // 5-4-2
            (la === 4 && lb === 4 && lc === 2) || // 4-4-2
            (la === 5 && lb === 3 && lc === 2) || // 5-3-2
            (la === 5 && lb === 4 && lc === 1)) { // 5-4-1
            push(a, b);
            return Array.from(new Set(out));
        }
        // Unknown dashed shape → still try first two
        push(a, b);
        return Array.from(new Set(out));
    }

    // 11 contiguous → 5-4-2
    if (digits.length === 11) {
        push(digits.slice(0, 5), digits.slice(5, 9));
        return Array.from(new Set(out));
    }

    // 10 contiguous → try possible 5-4 candidates
    if (digits.length === 10) {
        // 4-4-2 → 4&4
        push(digits.slice(0, 4), digits.slice(4, 8));
        // 5-3-2 → 5&3
        push(digits.slice(0, 5), digits.slice(5, 8));
        // 5-4-1 → 5&4
        push(digits.slice(0, 5), digits.slice(5, 9));
        return Array.from(new Set(out));
    }

    // Last resort: if ≥9 digits, guess 5-4
    if (digits.length >= 9) {
        push(digits.slice(0, 5), digits.slice(5, 9));
    }

    return Array.from(new Set(out));
}

function getEmailFromReq(req) {
    const c = getAuth(req)?.sessionClaims || {};
    const email =
        (c.email && String(c.email)) ||
        (c.email_address && String(c.email_address)) ||
        (c.primary_email && String(c.primary_email)) || '';
    return email.toLowerCase();
}
function getNameFromReq(req) {
    const c = getAuth(req)?.sessionClaims || {};
    return String(c.name || getEmailFromReq(req) || '');
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

// ---- startup ----
async function startServer() {
    try {
        db = await open({ filename: dbPath, driver: sqlite3.Database });
        console.log('✅ SQLite DB connected:', dbPath);

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
      CREATE INDEX IF NOT EXISTS idx_comments_ndc   ON comments (normalizedNDC);
      CREATE INDEX IF NOT EXISTS idx_comments_gpi   ON comments (gpiCode);
      CREATE INDEX IF NOT EXISTS idx_comments_scope ON comments (scope);
    `);

        // Build backup RAM index
        await initSqliteBackup();
        await buildSuggestIndex({ limit: SUGGEST_LIMIT });

        app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}
startServer();

// ---- comments helpers ----
async function upsertUserOnAccess(email, displayName) {
    await db.run(
        `INSERT INTO users (email, displayName, isApprovedCommenter)
     VALUES (?, ?, 0)
     ON CONFLICT(email) DO NOTHING`,
        [email, displayName]
    );
    return db.get('SELECT * FROM users WHERE email = ?', [email]);
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

// ---- map backup → your primary row shape ----
function mapBackupToPrimaryShape(b) {
    return {
        normalizedNDC: b.normalizedLP,
        ndc: b.ndc10,
        brandName: b.proprietaryName || null,
        genericName: b.nonProprietaryName || null,
        substanceName: b.substanceName || null,
        strength: b.strengthText || null,
        dosageForm: b.dosageForm || null,
        routeName: b.routeName || null,
        deaClass: b.deaClass ?? null,
        gpiNDC: null,
        gpi: b.gpi ?? null,
        rxcui: b.rxcui ?? null,
        _source: b._source, // "sqlite-backup"
    };
}

// ---- Assisted lookup (accepts dashed 10/11, contiguous, etc.) ----
app.get(['/ndc-lookup', '/ndc-lookup2'], async (req, res) => {
    const raw = req.query.ndc || '';
    const candidates = deriveLabelerProductCandidates(raw);
    if (!candidates.length) {
        return res.status(400).json({ error: 'Invalid NDC format' });
    }

    try {
        // Try primary DB across LP candidates
        let drug = null;
        for (const lp of candidates) {
            const row = await db.get(`SELECT * FROM ndc_data WHERE normalizedNDC = ?`, [lp]);
            if (row) { drug = row; break; }
        }

        // If none, try backup (fdandc.sqlite)
        if (!drug) {
            for (const lp of candidates) {
                const b = await getFromBackupByLabelerProduct(lp);
                if (b) { drug = mapBackupToPrimaryShape(mapBackupRow(b, lp)); break; }
            }
        }

        if (!drug) return res.status(404).json({ error: `NDC not found` });

        // Include comments only if EC domain
        const email = getEmailFromReq(req);
        const canSeeComments = email.endsWith('@exactcarepharmacy.com');
        const payload = { ...drug, comments: [] };

        if (canSeeComments) {
            payload.comments = await db.all(
                `SELECT * FROM comments
           WHERE scope='ndc' AND normalizedNDC IN (${candidates.map(() => '?').join(',')})
           ORDER BY createdAt DESC`,
                candidates
            ) || [];
        }

        res.json(payload);
    } catch (err) {
        console.error('❌ /ndc-lookup error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---- Suggest API (min-digits gate, RAM first from backup, then primary DB fallback) ----
app.get('/search-ndc', async (req, res) => {
    const q = (req.query.q || '').trim();
    const digitsOnly = q.replace(/\D/g, '');
    const lettersOnly = q.replace(/[^a-z]/gi, '');

    const allow =
        digitsOnly.length >= MIN_DIGITS ||
        (ENABLE_TEXT && lettersOnly.length >= MIN_TEXT);

    if (!allow) {
        return res.json({ results: [], _skipped: true, minDigits: MIN_DIGITS });
    }

    // 1) RAM (fdandc.sqlite → merged_ndc_data → NDCPACKAGECODE)
    try {
        const ram = querySuggestRAM(q, { limit: 12 });
        if (ram.length > 0) {
            const results = ram.map(r => ({
                ndc: r.ndc10,          // dashed
                brandName: r.brand,
                genericName: r.generic,
                strength: r.strength ?? null,
            }));
            return res.json({ results, _source: 'ram' });
        }
    } catch (err) {
        console.error('❌ /search-ndc RAM error:', err);
        // continue to DB fallback
    }

    // 2) Primary DB fallback (ndc_data with `ndc` column)
    const likeRaw = `%${q.toLowerCase()}%`;
    const likeDigits = `%${digitsOnly}%`;

    try {
        const rows = await db.all(`
      SELECT
        ndc,                -- dashed 10-digit in your primary table
        brandName,
        genericName,
        strength
      FROM ndc_data
      WHERE
        REPLACE(REPLACE(REPLACE(ndc, '-', ''), '.', ''), ' ', '') LIKE ?
        OR LOWER(brandName)   LIKE ?
        OR LOWER(genericName) LIKE ?
        OR LOWER(substanceName) LIKE ?
      LIMIT 12
    `, [likeDigits, likeRaw, likeRaw, likeRaw]);

        const results = (rows || []).map(row => ({
            ndc: row.ndc,
            brandName: row.brandName,
            genericName: row.genericName,
            strength: row.strength,
        }));

        return res.json({ results, _source: 'primary-db' });
    } catch (err) {
        console.error('❌ /search-ndc primary-db error:', err);
        return res.status(500).json({ results: [], _source: 'error', _error: String(err?.message || err) });
    }
});

// ---- Health + admin ----
app.get('/_health/ndc-backup', (_req, res) => {
    res.json({
        ok: true,
        backupPath: process.env.NDC_SQLITE_PATH || null,
        suggestLimit: SUGGEST_LIMIT,
        assistDeadlineMs: DEADLINE_MS,
        suggestSize: globalThis.__NDC_SUGGEST_SIZE__ ?? null,
    });
});

app.post('/admin/reload-ndc-backup/', async (req, res) => {
    const expected = process.env.NDC_RELOAD_TOKEN || '';
    const got = req.get('x-ndc-reload-token') || '';
    if (!expected || got !== expected) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
        await initSqliteBackup();
        await buildSuggestIndex({ limit: SUGGEST_LIMIT });
        res.json({ ok: true, size: globalThis.__NDC_SUGGEST_SIZE__ ?? null });
    } catch (e) {
        console.error('reload-ndc-backup failed', e);
        res.status(500).json({ ok: false });
    }
});

// ---- Auth routes ----
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
        res.status(400).json({ error: 'Missing normalizedNDC or gpiCode' });
    } catch (err) {
        console.error('❌ GET /comments error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/comments', requireAuth(), requireExactCareDomain, requireApprovedCommenter, async (req, res) => {
    const { normalizedNDC, gpiCode, scope, comment } = req.body;
    if (!['ndc', 'gpi'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
    if (!comment) return res.status(400).json({ error: 'Missing comment' });

    const finalNdc = scope === 'ndc' ? normalizedNDC : null;
    const finalGpi = scope === 'gpi' ? gpiCode : null;

    try {
        await db.run(
            `INSERT INTO comments (normalizedNDC, gpiCode, scope, comment, author)
       VALUES (?, ?, ?, ?, ?)`,
            [finalNdc, finalGpi, scope, comment, req.userEmail]
        );
        res.status(201).json({ success: true });
    } catch (err) {
        console.error('❌ POST /comments error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---- Proxies (unchanged) ----
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
