// sqlite-backup.js  (no better-sqlite3; uses sqlite + sqlite3)
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

let backupDb = null;
let suggestIndex = [];

// optional: allow trimming columns to save RAM
const INCLUDE_SUBSTANCE = !/^false$/i.test(process.env.NDC_SUGGEST_INCLUDE_SUBSTANCE || 'true');
const INCLUDE_STRENGTH = !/^false$/i.test(process.env.NDC_SUGGEST_INCLUDE_STRENGTH || 'true');

const ident = (s) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error('Bad ident ' + s);
    return s;
};

export async function initSqliteBackup() {
    const path = process.env.NDC_SQLITE_PATH;
    const table = ident(process.env.NDC_SQLITE_TABLE || 'merged_ndc_data');
    if (!path) {
        console.warn('[sqlite-backup] NDC_SQLITE_PATH not set');
        return;
    }
    backupDb = await open({ filename: path, driver: sqlite3.Database });
    // sanity: ensure main table exists (don’t throw; just warn if not)
    const t = await backupDb.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
    if (!t) {
        console.warn(`[sqlite-backup] table not found: ${table} (backup available but primary table missing)`);
    }
    console.log('[sqlite-backup] opened', path);
}

export async function getFromBackupByLabelerProduct(lp) {
    if (!backupDb) return null;
    const table = ident(process.env.NDC_SQLITE_TABLE || 'merged_ndc_data');
    const col = ident(process.env.NDC_SQLITE_NDCPACKAGE_COL || 'NDCPACKAGECODE');

    // Derive "labeler-product" (strip leading zeros on first two segments) from dashed 10-digit NDC
    const sql = `
    SELECT *
    FROM ${table}
    WHERE (
      CAST(substr(${col},1,instr(${col},'-')-1) AS INT) || '-' ||
      CAST(substr(${col}, instr(${col},'-')+1,
        instr(substr(${col}, instr(${col},'-')+1), '-') - 1
      ) AS INT)
    ) = ?
    LIMIT 1
  `;
    try {
        return await backupDb.get(sql, lp);
    } catch (e) {
        console.warn('[sqlite-backup] backup lookup failed:', e?.message || e);
        return null;
    }
}

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

        // leave these for primary resolver to enrich
        discontinuedStatus: null,
        shortageStatus: null,
        refrigerate: null,
        niosh_code: null,
        gpi: null,
        rxcui: null,

        _source: 'sqlite-backup',
    };
}

/** Assist preload: try primary briefly; if slow/miss, return SQLite immediately. */
export async function getNdcWithAssist(normalizedLP, primaryFn, { deadlineMs = 200 } = {}) {
    let done = false;
    const timer = new Promise((resolve) => setTimeout(() => { if (!done) resolve(null); }, deadlineMs));
    const primary = primaryFn(normalizedLP).catch(() => null);
    const fast = await Promise.race([primary, timer]);
    if (fast) { done = true; return fast; }

    const backup = await getFromBackupByLabelerProduct(normalizedLP);
    if (backup) { done = true; return mapBackupRow(backup, normalizedLP); }

    const late = await primary;
    return late || null;
}

/** Try a SELECT for v_ndc_suggest with progressively fewer columns until one works. */
async function tryLoadSuggest(limit) {
    if (!backupDb) return [];

    const baseCols = ['lp', 'ndc10', 'brand', 'generic', 'ndc_digits'];
    const withStrength = INCLUDE_STRENGTH ? ['strength'] : [];
    const withSub = INCLUDE_SUBSTANCE ? ['substance'] : [];

    const attempts = [
        [...baseCols, ...withStrength, ...withSub],
        [...baseCols, ...withStrength],     // maybe no substance
        [...baseCols, ...withSub],          // maybe no strength
        [...baseCols],                      // minimal
    ];

    for (const cols of attempts) {
        const select = cols.join(', ');
        try {
            const rows = await backupDb.all(
                `SELECT ${select} FROM v_ndc_suggest LIMIT ?`, limit
            );
            return rows.map(r => {
                const out = {
                    lp: String(r.lp || ''),
                    ndc10: r.ndc10 || null,
                    brand: r.brand || null,
                    generic: r.generic || null,
                    // prefer supplied digits; otherwise derive from ndc10
                    _digits: String(r.ndc_digits || (r.ndc10 || '').replace(/\D/g, '')).toLowerCase(),
                    _lp: String(r.lp || '').toLowerCase(),
                    _brand: String(r.brand || '').toLowerCase(),
                    _generic: String(r.generic || '').toLowerCase(),
                };
                if ('substance' in r) {
                    out.substance = r.substance || null;
                    out._sub = String(r.substance || '').toLowerCase();
                }
                if ('strength' in r) {
                    out.strength = r.strength || null;
                }
                return out;
            });
        } catch (e) {
            // try the next narrower select
            continue;
        }
    }
    console.warn('[sqlite-backup] could not load v_ndc_suggest (all variants failed)');
    return [];
}

/** Build an in-memory suggest index from v_ndc_suggest (created earlier). */
export async function buildSuggestIndex({ limit = 250000 } = {}) {
    if (!backupDb) return;
    // ensure the view exists; if not, don’t throw
    const v = await backupDb.get(
        `SELECT name FROM sqlite_master WHERE (type='view' OR type='table') AND name='v_ndc_suggest'`
    );
    if (!v) {
        suggestIndex = [];
        globalThis.__NDC_SUGGEST_SIZE__ = 0;
        console.warn('[sqlite-backup] v_ndc_suggest not found; suggestions disabled');
        return;
    }

    const rows = await tryLoadSuggest(limit);
    // lean array already, but defensively slice to limit
    suggestIndex = rows.slice(0, limit);

    globalThis.__NDC_SUGGEST_SIZE__ = suggestIndex.length;
    console.log('[sqlite-backup] suggest index loaded:', suggestIndex.length);
}

/** RAM-only suggestions; no DB I/O per keystroke. */
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
    // 2) numeric 10/11-digit prefix
    if (out.length < limit && digits) {
        for (const r of suggestIndex) {
            if (r._digits.startsWith(digits)) { push(r); if (out.length >= limit) break; }
        }
    }
    // 3) names contains (brand/generic/substance if present)
    if (out.length < limit) {
        for (const r of suggestIndex) {
            if (r._brand.includes(s) || r._generic.includes(s) || (r._sub && r._sub.includes(s))) {
                push(r); if (out.length >= limit) break;
            }
        }
    }

    // lean payload
    return out.map(({ lp, ndc10, brand, generic, substance, strength }) =>
        ({ lp, ndc10, brand, generic, substance, strength })
    );
}
