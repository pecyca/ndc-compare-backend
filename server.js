// server.js
import 'dotenv/config';
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

// Auth
import { requireAuth } from './middleware/requireAuth.js';
import { requirePermission } from './middleware/requirePermission.js';

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- Security / debug headers ---------------- */
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set(
        'x-build',
        `${process.env.RENDER_GIT_BRANCH || 'local'}-${(process.env.RENDER_GIT_COMMIT || '').slice(0, 7)}`
    );
    next();
});

/* ---------------- Tunables (env) ---------------- */
const DEADLINE_MS = Number(process.env.NDC_BACKUP_DEADLINE_MS || 200);
const SUGGEST_LIMIT = Number(process.env.NDC_SUGGEST_LIMIT || 250000);
const MIN_DIGITS = Number(process.env.NDC_SUGGEST_MIN_DIGITS || 6);
const ENABLE_TEXT = /^true$/i.test(process.env.NDC_SUGGEST_ENABLE_TEXT || 'false');
const MIN_TEXT = Number(process.env.NDC_SUGGEST_MIN_TEXT || 3);

/* ---------------- CORS ---------------- */
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use(
    cors({
        origin(origin, cb) {
            if (!origin || allowedOrigins.length === 0) return cb(null, true);
            if (allowedOrigins.includes(origin)) return cb(null, true);
            return cb(new Error(`Not allowed by CORS: ${origin}`));
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
        maxAge: 86400,
    })
);
app.options('*', (_req, res) => {
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(204);
});

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------- DB ---------------- */
let dbPath = '/data/merged_ndc_all_records.sqlite';
if (!fs.existsSync(dbPath)) {
    dbPath = path.join(__dirname, 'merged_ndc_all_records.sqlite');
    console.warn('⚠️ Persistent disk not found, using local DB:', dbPath);
} else {
    console.log('✅ Using persistent disk DB path');
}

let db;

/* ---------------- helpers ---------------- */
const stripLeadingZeros = (v) => String(v || '').replace(/^0+/, '') || '0';

function deriveLabelerProductCandidates(input) {
    if (!input) return [];
    const raw = String(input).trim();
    const digits = raw.replace(/\D/g, '');
    const out = [];
    const push = (a, b) => out.push(`${stripLeadingZeros(a)}-${stripLeadingZeros(b)}`);

    // dashed
    const parts = raw.split('-');
    if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
        const [a, b, c] = parts;
        const la = a.length, lb = b.length, lc = c.length;
        if (
            (la === 5 && lb === 4 && lc === 2) || // 5-4-2
            (la === 4 && lb === 4 && lc === 2) || // 4-4-2
            (la === 5 && lb === 3 && lc === 2) || // 5-3-2
            (la === 5 && lb === 4 && lc === 1)    // 5-4-1
        ) {
            push(a, b);
            return Array.from(new Set(out));
        }
        push(a, b);
        return Array.from(new Set(out));
    }

    // contiguous
    if (digits.length === 11) { push(digits.slice(0, 5), digits.slice(5, 9)); return Array.from(new Set(out)); }
    if (digits.length === 10) {
        push(digits.slice(0, 4), digits.slice(4, 8));
        push(digits.slice(0, 5), digits.slice(5, 8));
        push(digits.slice(0, 5), digits.slice(5, 9));
        return Array.from(new Set(out));
    }
    if (digits.length >= 9) push(digits.slice(0, 5), digits.slice(5, 9));
    return Array.from(new Set(out));
}

// 10-digit dashed → 11-digit (no dashes)
function to11FromDashed10(ndc10) {
    const m = String(ndc10 || '').match(/^(\d+)-(\d+)-(\d+)$/);
    if (!m) return null;
    let [, a, b, c] = m;
    if (a.length === 4 && b.length === 4 && c.length === 2) a = a.padStart(5, '0');
    else if (a.length === 5 && b.length === 3 && c.length === 2) b = b.padStart(4, '0');
    else if (a.length === 5 && b.length === 4 && c.length === 1) c = c.padStart(2, '0');
    else if (!(a.length === 5 && b.length === 4 && c.length === 2)) return null;
    return `${a}${b}${c}`;
}

function variantsForSearch(q) {
    const s = String(q || '').trim();
    const d = s.replace(/\D/g, '');
    const set = new Set();
    if (s) set.add(s);
    if (d) set.add(d);
    for (const lp of deriveLabelerProductCandidates(s)) {
        set.add(lp);
        set.add(lp.replace('-', ''));
    }
    if (d.startsWith('00')) set.add(d.slice(1));
    if (d) set.add(d.replace(/^0+/, ''));
    return Array.from(set).filter(Boolean);
}

// Auth helpers
function getEmailFromReq(req) {
    const email = (req.user?.email && String(req.user.email)) || '';
    return email.toLowerCase();
}
function getNameFromReq(req) {
    const email = getEmailFromReq(req);
    return String(req.user?.name || req.user?.nickname || email || '');
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

/* ---------------- startup ---------------- */
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

        await initSqliteBackup();
        await buildSuggestIndex({ limit: SUGGEST_LIMIT });

        app.listen(PORT, () => {
            console.log(`🚀 Server listening on ${PORT}`);
            console.log('Allowed CORS origins:', allowedOrigins.length ? allowedOrigins : '(all)');
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}
startServer();

/* ---------------- Assisted lookup ---------------- */
app.get(['/ndc-lookup', '/ndc-lookup2'], async (req, res) => {
    const raw = req.query.ndc || '';
    const candidates = deriveLabelerProductCandidates(raw);
    if (!candidates.length) return res.status(400).json({ error: 'Invalid NDC format' });

    try {
        let drug = null;
        for (const lp of candidates) {
            const row = await db.get(`SELECT * FROM ndc_data WHERE normalizedNDC = ?`, [lp]);
            if (row) { drug = row; break; }
        }

        if (!drug) {
            for (const lp of candidates) {
                const b = await getFromBackupByLabelerProduct(lp);
                if (b) { drug = mapBackupRow(b, lp); break; }
            }
        }

        if (!drug) return res.status(404).json({ error: 'NDC not found' });

        const email = getEmailFromReq(req);
        const canSeeComments = email.endsWith('@exactcarepharmacy.com');
        const payload = { ...drug, _source: drug._source || 'primary-db', comments: [] };

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

/* ---------------- Suggest API ---------------- */
app.get('/search-ndc', async (req, res) => {
    const q = (req.query.q || '').trim();
    const digitsOnly = q.replace(/\D/g, '');
    const lettersOnly = q.replace(/[^a-z]/gi, '');

    const allow = digitsOnly.length >= MIN_DIGITS || (ENABLE_TEXT && lettersOnly.length >= MIN_TEXT);
    if (!allow) return res.json({ results: [], _skipped: true, minDigits: MIN_DIGITS });

    const variants = variantsForSearch(q);

    try {
        const seen = new Set();
        const ramResults = [];
        for (const v of variants) {
            const list = querySuggestRAM(v, { limit: 12 });
            for (const r of list) {
                const key = r.ndc10 || `${r.lp}:${r.brand}:${r.generic}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const ndc10 = r.ndc10 || null;
                    const ndc11 = ndc10 ? to11FromDashed10(ndc10) : null;
                    ramResults.push({
                        ndc: ndc10,
                        ndc11,
                        brandName: r.brand || null,
                        genericName: r.generic || null,
                        strength: r.strength ?? null,
                    });
                }
            }
            if (ramResults.length >= 12) break;
        }
        if (ramResults.length > 0) return res.json({ results: ramResults.slice(0, 12), _source: 'ram' });
    } catch (err) {
        console.error('❌ /search-ndc RAM error:', err);
    }

    try {
        const digitVariants = Array.from(
            new Set(variants.map(v => v.replace(/\D/g, '')).filter(v => v && v.length >= 5))
        );

        const likeDigitsParts = digitVariants.map(
            () => `REPLACE(REPLACE(REPLACE(ndc, '-', ''), '.', ''), ' ', '') LIKE ?`
        );
        const likeDigitsArgs = digitVariants.map(d => `%${d}%`);

        const likeRaw = `%${q.toLowerCase()}%`;

        const sql = `
      SELECT ndc, brandName, genericName, strength
      FROM ndc_data
      WHERE
        (${likeDigitsParts.length ? likeDigitsParts.join(' OR ') : '0'})
        OR LOWER(brandName)      LIKE ?
        OR LOWER(genericName)    LIKE ?
        OR LOWER(substanceName)  LIKE ?
      LIMIT 12
    `;

        const rows = await db.all(sql, [...likeDigitsArgs, likeRaw, likeRaw, likeRaw]);
        const results = (rows || []).map(row => {
            const ndc10 = row.ndc || null;
            const ndc11 = ndc10 ? to11FromDashed10(ndc10) : null;
            return { ndc: ndc10, ndc11, brandName: row.brandName, genericName: row.genericName, strength: row.strength };
        });

        return res.json({ results, _source: 'primary-db' });
    } catch (err) {
        console.error('❌ /search-ndc primary-db error:', err);
        return res.status(500).json({ results: [], _source: 'error', _error: String(err?.message || err) });
    }
});

/* ---------------- Health + admin ---------------- */
app.get('/_health/ndc-backup', (_req, res) => {
    res.json({
        ok: true,
        backupPath: process.env.NDC_SQLITE_PATH || null,
        suggestLimit: SUGGEST_LIMIT,
        assistDeadlineMs: DEADLINE_MS,
        suggestSize: globalThis.__NDC_SUGGEST_SIZE__ ?? null,
    });
});

app.get('/', (_req, res) => res.type('text').send('ok'));

app.post('/admin/reload-ndc-backup/', async (req, res) => {
    const expected = process.env.NDC_RELOAD_TOKEN || '';
    const got = req.get('x-ndc-reload-token') || '';
    if (!expected || got !== expected) return res.status(403).json({ ok: false, error: 'forbidden' });
    try {
        await initSqliteBackup();
        await buildSuggestIndex({ limit: SUGGEST_LIMIT });
        res.json({ ok: true, size: globalThis.__NDC_SUGGEST_SIZE__ ?? null });
    } catch (e) {
        console.error('reload-ndc-backup failed', e);
        res.status(500).json({ ok: false });
    }
});

/* ---------------- Auth & comments ---------------- */
app.get('/me', requireAuth(), requireExactCareDomain, async (req, res) => {
    try {
        await db.run(
            `INSERT INTO users (email, displayName, isApprovedCommenter)
       VALUES (?, ?, 0)
       ON CONFLICT(email) DO NOTHING`,
            [req.userEmail, req.userName]
        );

        const row = await db.get('SELECT * FROM users WHERE email = ?', [req.userEmail]);
        const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];

        const canPostComments = perms.includes('comment:write') || row?.isApprovedCommenter === 1;
        const canDeleteComments = perms.includes('comment:delete');

        res.json({
            email: req.userEmail,
            displayName: req.userName,
            isApprovedCommenter: row?.isApprovedCommenter === 1,
            permissions: perms,
            canPostComments,
            canDeleteComments,
        });
    } catch (e) {
        console.error('❌ /me error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Create comment (RBAC OR legacy DB-approved)
app.post(
    '/comments',
    requireAuth(),
    requireExactCareDomain,
    requirePermission('comment:write', true, db),
    async (req, res) => {
        const { normalizedNDC, gpiCode, scope, comment } = req.body;
        if (!['ndc', 'gpi'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
        if (!comment) return res.status(400).json({ error: 'Missing comment' });

        const finalNdc = scope === 'ndc' ? normalizedNDC : null;
        const finalGpi = scope === 'gpi' ? gpiCode : null;

        try {
            await db.run(
                `INSERT INTO comments (normalizedNDC, gpiCode, scope, comment, author)
         VALUES (?, ?, ?, ?, ?)`,
                [finalNdc, finalGpi, scope, comment, getEmailFromReq(req)]
            );
            res.status(201).json({ success: true });
        } catch (err) {
            console.error('❌ POST /comments error:', err);
            res.status(500).json({ error: 'Internal error' });
        }
    }
);

// Delete comment (RBAC only)
app.delete(
    '/comments/:id',
    requireAuth(),
    requireExactCareDomain,
    requirePermission('comment:delete'),
    async (req, res) => {
        try {
            await db.run(`DELETE FROM comments WHERE id = ?`, [req.params.id]);
            res.json({ ok: true });
        } catch (err) {
            console.error('❌ DELETE /comments error:', err);
            res.status(500).json({ error: 'Internal error' });
        }
    }
);

/* ---------------- Proxies ---------------- */
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
