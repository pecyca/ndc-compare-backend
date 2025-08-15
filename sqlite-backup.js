// sqlite-backup.js  (uses sqlite + sqlite3; no better-sqlite3)
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

let backupDb = null;
let suggestIndex = [];

/* ---------- small utilities ---------- */
const ident = (s) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error('Bad ident ' + s);
    return s;
};

const envTrue = (v, def = true) => {
    if (v == null) return def;
    return /^true$/i.test(String(v));
};

/* ---------- open backup DB ---------- */
export async function initSqliteBackup() {
    const path = process.env.NDC_SQLITE_PATH; // e.g. /data/ndc/fdandc.sqlite
    const table = ident(process.env.NDC_SQLITE_TABLE || 'merged_ndc_data');
    if (!path) {
        console.warn('[sqlite-backup] NDC_SQLITE_PATH not set');
        return;
    }
    backupDb = await open({ filename: path, driver: sqlite3.Database });

    // Best-effort sanity check (don’t crash if table/view names differ)
    try {
        await backupDb.get(
            `SELECT name FROM sqlite_master WHERE (type='table' OR type='view') AND name=?`,
            [table]
        );
    } catch (e) {
        console.warn('[sqlite-backup] table/view check skipped:', e?.message || e);
    }

    console.log('[sqlite-backup] opened', path);
}

/* ---------- point lookup from backup DB ---------- */
export async function getFromBackupByLabelerProduct(lp) {
    if (!backupDb) return null;
    const table = ident(process.env.NDC_SQLITE_TABLE || 'merged_ndc_data');
    const col = ident(process.env.NDC_SQLITE_NDCPACKAGE_COL || 'NDCPACKAGECODE');

    // Extract labeler-product from dashed NDCPACKAGECODE (e.g. 12345-6789-01 → 12345-6789)
    const sql = `
    SELECT *
    FROM ${table}
    WHERE (
      CAST(substr(${col}, 1, instr(${col}, '-') - 1) AS INT) || '-' ||
      CAST(substr(
        ${col},
        instr(${col}, '-') + 1,
        instr(substr(${col}, instr(${col}, '-') + 1), '-') - 1
      ) AS INT)
    ) = ?
    LIMIT 1
  `;
    return backupDb.get(sql, [lp]);
}

/* ---------- map backup row → “primary” shape ---------- */
export function mapBackupRow(row, normalizedLP) {
    if (!row) return null;
    return {
        normalizedLP,
        ndc10: row.NDCPACKAGECODE ?? null,
        proprietaryName: row.PROPRIETARYNAME ?? null,
        proprietaryNameSuffix: row.PROPRIETARYNAMESUFFIX ?? null,
        nonProprietaryName: row.NONPROPRIETARYNAME ?? null,
        substanceName: row.SUBSTANCENAME ?? null,
        dosageForm: row.DOSAGEFORMNAME ?? null,
        routeName: row.ROUTENAME ?? null,
        strengthText:
            row.ACTIVE_NUMERATOR_STRENGTH && row.ACTIVE_INGRED_UNIT
                ? `${row.ACTIVE_NUMERATOR_STRENGTH} ${row.ACTIVE_INGRED_UNIT}`
                : null,
        deaClass: row.DEASCHEDULE_NUMERIC ?? row.DEASCHEDULE ?? null,
        discontinuedStatus: null,
        shortageStatus: null,
        refrigerate: null,
        niosh_code: null,
        gpi: null,
        rxcui: null,
        _source: 'sqlite-backup',
    };
}

/* ---------- assisted primary-with-backup ---------- */
export async function getNdcWithAssist(normalizedLP, primaryFn, { deadlineMs = 200 } = {}) {
    let done = false;
    const timer = new Promise((resolve) =>
        setTimeout(() => { if (!done) resolve(null); }, deadlineMs)
    );
    const primary = primaryFn(normalizedLP).catch(() => null);
    const fast = await Promise.race([primary, timer]);
    if (fast) { done = true; return fast; }

    const backup = await getFromBackupByLabelerProduct(normalizedLP);
    if (backup) { done = true; return mapBackupRow(backup, normalizedLP); }

    const late = await primary;
    return late || null;
}

/* ---------- RAM suggest index (tolerant + lean) ---------- */
export async function buildSuggestIndex({ limit = 250000 } = {}) {
    if (!backupDb) return;

    const WANT_SUBSTANCE = envTrue(process.env.NDC_SUGGEST_INCLUDE_SUBSTANCE, true);
    const WANT_STRENGTH = envTrue(process.env.NDC_SUGGEST_INCLUDE_STRENGTH, true);

    let rows = [];
    let hasSubstance = false;
    let hasStrength = false;

    // Try richest shape first
    try {
        rows = await backupDb.all(
            `SELECT lp, ndc10, brand, generic, substance, strength, ndc_digits
       FROM v_ndc_suggest
       LIMIT ?`,
            [limit]
        );
        hasSubstance = true;
        hasStrength = true;
    } catch {
        // Drop strength first
        try {
            rows = await backupDb.all(
                `SELECT lp, ndc10, brand, generic, substance, ndc_digits
         FROM v_ndc_suggest
         LIMIT ?`,
                [limit]
            );
            hasSubstance = true;
            hasStrength = false;
        } catch {
            // Drop substance too
            rows = await backupDb.all(
                `SELECT lp, ndc10, brand, generic, ndc_digits
         FROM v_ndc_suggest
         LIMIT ?`,
                [limit]
            );
            hasSubstance = false;
            hasStrength = false;
        }
    }

    // Respect env flags to keep payload small if desired
    const includeSubstance = hasSubstance && WANT_SUBSTANCE;
    const includeStrength = hasStrength && WANT_STRENGTH;

    suggestIndex = rows.map((r) => {
        const lp = String(r.lp || '');
        const ndc10 = r.ndc10 || null;
        const brand = r.brand || null;
        const generic = r.generic || null;

        const obj = {
            lp,
            ndc10,
            brand,
            generic,
            substance: includeSubstance ? (r.substance || null) : null,
            strength: includeStrength ? (r.strength || null) : null,

            // precomputed lowercase / digits for fast matching
            _lp: lp.toLowerCase(),
            _digits: String(r.ndc_digits || '').toLowerCase(),
            _brand: String(brand || '').toLowerCase(),
            _generic: String(generic || '').toLowerCase(),
            _sub: includeSubstance ? String(r.substance || '').toLowerCase() : '',
        };
        return obj;
    });

    globalThis.__NDC_SUGGEST_SIZE__ = suggestIndex.length;
    console.log('[sqlite-backup] suggest index loaded:', suggestIndex.length,
        `(substance:${includeSubstance}, strength:${includeStrength})`);
}

/* ---------- RAM-only suggestions (no DB I/O) ---------- */
export function querySuggestRAM(q, { limit = 20 } = {}) {
    if (!q) return [];
    const s = q.toLowerCase();
    const digits = q.replace(/\D/g, '');

    const out = [];
    const push = (r) => { if (out.length < limit) out.push(r); };

    // 1) labeler-product prefix
    for (const r of suggestIndex) {
        if (r._lp.startsWith(s)) { push(r); if (out.length >= limit) break; }
    }

    // 2) numeric 10/11 prefix
    if (out.length < limit && digits) {
        for (const r of suggestIndex) {
            if (r._digits.startsWith(digits)) { push(r); if (out.length >= limit) break; }
        }
    }

    // 3) name contains (brand/generic/substance if present)
    if (out.length < limit) {
        for (const r of suggestIndex) {
            if (r._brand.includes(s) || r._generic.includes(s) || (r._sub && r._sub.includes(s))) {
                push(r); if (out.length >= limit) break;
            }
        }
    }

    // Lean payload returned to the API
    return out.map(({ lp, ndc10, brand, generic, substance, strength }) => ({
        lp, ndc10, brand, generic, substance, strength
    }));
}
