// === ✅ FULL MERGED server.js with Fixed Comments Filtering ===

import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = '/data/merged_ndc_all_records.sqlite';

let db;

async function startServer() {
    try {
        db = await open({ filename: dbPath, driver: sqlite3.Database });
        console.log('✅ SQLite DB connected');

        app.listen(PORT, () => {
            console.log(`🚀 Server listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
}

startServer();

function stripLeadingZeros(val) {
    return val.replace(/^0+/, '');
}

function normalizeNdcToDigitsOnly(ndc) {
    return ndc.replace(/\D/g, '').padStart(11, '0');
}

function normalizeNdcToProductOnly(ndc) {
    const digits = ndc.replace(/\D/g, '').padStart(11, '0');
    const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
    if (!match) return ndc;
    const [_, labeler, product] = match;
    return `${stripLeadingZeros(labeler)}-${stripLeadingZeros(product)}`;
}

// === 🔍 /ndc-lookup with embedded comments ===
app.get('/ndc-lookup', async (req, res) => {
    const rawNdc = req.query.ndc || '';
    const normalized = normalizeNdcToProductOnly(rawNdc);

    if (!normalized.includes('-')) {
        return res.status(400).json({ error: 'Invalid NDC format' });
    }

    try {
        const drug = await db.get(`SELECT * FROM ndc_data WHERE normalizedNDC = ?`, [normalized]);
        if (!drug) return res.status(404).json({ error: `NDC ${normalized} not found` });

        const comments = await db.all(`
            SELECT * FROM comments
            WHERE scope = 'ndc' AND normalizedNDC = ?
            ORDER BY createdAt DESC
        `, [normalized]);

        res.json({ ...drug, comments });
    } catch (err) {
        console.error('❌ /ndc-lookup error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === /search-ndc ===
app.get('/search-ndc', async (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 3) return res.status(400).json({ error: 'Query too short' });

    const likeRaw = `%${q}%`;
    const digitsOnly = q.replace(/\D/g, '');
    const likeDigits = `%${digitsOnly}%`;

    try {
        const rows = await db.all(`
            SELECT ndc, gpiNDC, brandName, genericName, strength
            FROM ndc_data
            WHERE
                REPLACE(REPLACE(REPLACE(gpiNDC, '-', ''), '.', ''), ' ', '') LIKE ? OR
                LOWER(brandName) LIKE ? OR
                LOWER(genericName) LIKE ? OR
                LOWER(substanceName) LIKE ?
            LIMIT 12
        `, [likeDigits, likeRaw, likeRaw, likeRaw]);

        const results = rows.map(row => ({
            ndc: row.ndc,
            brandName: row.brandName,
            genericName: row.genericName,
            strength: row.strength
        }));

        res.json({ results });
    } catch (err) {
        console.error('❌ /search-ndc error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === 🔐 Internal Comments API ===
const INTERNAL_API_TOKEN = 'test-editor-token';

function isAuthorized(req) {
    const auth = req.headers.authorization || '';
    return auth === `Bearer ${INTERNAL_API_TOKEN}`;
}

// ✅ FIXED GET /comments
app.get('/comments', async (req, res) => {
    if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });

    const { normalizedNDC, gpiCode } = req.query;

    if (normalizedNDC) {
        try {
            const rows = await db.all(`
                SELECT * FROM comments
                WHERE scope = 'ndc' AND normalizedNDC = ?
                ORDER BY createdAt DESC
            `, [normalizedNDC]);
            return res.json(rows);
        } catch (err) {
            console.error('❌ /comments error:', err.message);
            return res.status(500).json({ error: 'Internal error' });
        }
    }

    if (gpiCode) {
        try {
            const rows = await db.all(`
                SELECT * FROM comments
                WHERE scope = 'gpi' AND gpiCode = ?
                ORDER BY createdAt DESC
            `, [gpiCode]);
            return res.json(rows);
        } catch (err) {
            console.error('❌ /comments error:', err.message);
            return res.status(500).json({ error: 'Internal error' });
        }
    }

    return res.status(400).json({ error: 'Missing normalizedNDC or gpiCode' });
});


// POST /comments
app.post('/comments', async (req, res) => {
    if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });

    const { normalizedNDC, gpiCode, scope, comment, author } = req.body;

    if (!['ndc', 'gpi'].includes(scope)) {
        return res.status(400).json({ error: 'Invalid scope' });
    }
    if (!comment || !author) {
        return res.status(400).json({ error: 'Missing comment or author' });
    }

    const finalNdc = scope === 'ndc' ? normalizedNDC : null;
    const finalGpi = scope === 'gpi' ? gpiCode : null;

    try {
        await db.run(`
            INSERT INTO comments (normalizedNDC, gpiCode, scope, comment, author)
            VALUES (?, ?, ?, ?, ?)
        `, [finalNdc, finalGpi, scope, comment, author]);

        res.status(201).json({ success: true });
    } catch (err) {
        console.error('❌ POST /comments error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === RxNav Proxy ===
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

// === openFDA Proxy ===
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
