// server.js
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'merged_ndc_all_records.sqlite');

let db;
(async () => {
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    console.log('✅ SQLite DB connected');
})();

// === Normalization ===
function stripLeadingZeros(segment) {
    return segment.replace(/^0+/, '');
}

function normalizeNdcToProductOnly(ndc) {
    const digits = ndc.replace(/\D/g, '').padStart(11, '0');
    const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
    return match ? `${stripLeadingZeros(match[1])}-${stripLeadingZeros(match[2])}` : ndc;
}

function normalizeNdcToFull(ndc) {
    const digits = ndc.replace(/\D/g, '').padStart(11, '0');
    const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
    return match ? `${stripLeadingZeros(match[1])}-${stripLeadingZeros(match[2])}-${stripLeadingZeros(match[3])}` : ndc;
}

// === /proxy/rxnav/* ===
app.get('/proxy/rxnav/*', async (req, res) => {
    const subpath = req.params[0];
    const query = new URLSearchParams(req.query).toString();
    const url = `https://rxnav.nlm.nih.gov/REST/${subpath}?${query}`;

    try {
        const response = await fetch(url);
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            const data = await response.json();
            res.json(data);
        } else {
            const text = await response.text();
            console.error('RxNav response was not JSON:\n', text);
            res.status(502).send('RxNav did not return JSON');
        }
    } catch (err) {
        console.error('Proxy fetch error:', err.message);
        res.status(500).json({ error: 'RxNav proxy failed' });
    }
});

// === /ndc-lookup ===
app.get('/ndc-lookup', async (req, res) => {
    const ndc = req.query.ndc;
    if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

    const normalized = normalizeNdcToProductOnly(ndc);
    try {
        const row = await db.get(`SELECT * FROM ndc_data WHERE normalizedNDC = ?`, [normalized]);

        if (!row) return res.status(404).json({ error: 'NDC not found' });

        let inferredRxcui = row.rxcui || null;
        let inferredGpi = row.gpiCode || null;

        // Infer RxCUI if missing
        if (!inferredRxcui) {
            try {
                const response = await fetch(`https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc=${ndc}`);
                const json = await response.json();
                inferredRxcui = json?.ndcStatus?.rxCui || null;
            } catch (err) {
                console.warn('RxCUI inference failed:', err.message);
            }
        }

        res.json({ ...row, inferredRxcui, inferredGpi });
    } catch (err) {
        console.error('❌ /ndc-lookup error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === /discontinued-status ===
app.get('/discontinued-status', async (req, res) => {
    const ndc = req.query.ndc;
    if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

    const normalized = normalizeNdcToProductOnly(ndc);
    try {
        const row = await db.get(`SELECT Matched_ENDMARKETINGDATE FROM ndc_data WHERE normalizedNDC = ?`, [normalized]);
        let discontinued = false;

        if (row?.Matched_ENDMARKETINGDATE && /^\d{8}$/.test(row.Matched_ENDMARKETINGDATE)) {
            const y = parseInt(row.Matched_ENDMARKETINGDATE.slice(0, 4));
            const m = parseInt(row.Matched_ENDMARKETINGDATE.slice(4, 6)) - 1;
            const d = parseInt(row.Matched_ENDMARKETINGDATE.slice(6, 8));
            const endDate = new Date(Date.UTC(y, m, d));
            discontinued = endDate < new Date();
        }

        res.json({ discontinued });
    } catch (err) {
        console.error('❌ /discontinued-status error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === /shortage-status ===
app.get('/shortage-status', async (req, res) => {
    const ndc = req.query.ndc;
    if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

    const normalized = normalizeNdcToFull(ndc);
    try {
        const row = await db.get(`SELECT Reason_for_Shortage FROM shortages WHERE Normalized_PackageNDC = ?`, [normalized]);

        if (row) {
            res.json({ inShortage: true, reason: row.Reason_for_Shortage || null });
        } else {
            res.json({ inShortage: false });
        }
    } catch (err) {
        console.error('❌ /shortage-status error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// === Root ===
app.get('/', (req, res) => {
    res.send('✅ NDC Compare Backend is live');
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
