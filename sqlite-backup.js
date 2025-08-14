// sqlite-backup.js
import fs from 'fs';
import Database from 'better-sqlite3';

let db = null;
let stmtByLP = null;
let suggestIndex = []; // in-memory for autocomplete

function ident(s) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error('Bad ident ' + s); return s; }

export function initSqliteBackup() {
    const path = process.env.NDC_SQLITE_PATH;                // /data/ndc/fdandc.sqlite
    const table = ident(process.env.NDC_SQLITE_TABLE || 'merged_ndc_data');
    const col = ident(process.env.NDC_SQLITE_NDCPACKAGE_COL || 'NDCPACKAGECODE');

    if (!path || !fs.existsSync(path)) {
        console.warn('[sqlite] not found:', path);
        return;
    }
    db = new Database(path, { readonly: true, fileMustExist: true });
    try { db.pragma('journal_mode = WAL'); } catch { }
    console.log('[sqlite] opened', path);

    // Prepared lookup by your existing key: labeler-product (no leading zeros) → derived from dashed 10-digit
    const sql = `
    SELECT *
    FROM ${table}
    WHERE (
      CAST(substr(${col},1,instr(${col},'-')-1) AS INT) || '-' ||
      CAST(substr(${col}, instr(${col},'-')+1,
        instr(substr(${col}, instr(${col},'-')+1), '-') - 1
      ) AS INT)
    ) = ?
    LIMIT 1`;
    stmtByLP = db.prepare(sql);
}

export function getFromBackupByLabelerProduct(lp) {
    if (!db || !stmtByLP) return null;
    try { return stmtByLP.get(lp) || null; } catch { return null; }
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

        // These are fine to be null; primary can still fill them later
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
    let timed = new Promise((resolve) => {
        let done = false;
        primaryFn(normalizedLP)
            .then(v => { if (!done) resolve({ ok: true, v }); })
            .catch(() => { if (!done) resolve({ ok: false }); });
        setTimeout(() => { done = true; resolve({ ok: false }); }, deadlineMs);
    });

    const r = await timed;
    if (r.ok && r.v) return r.v;

    const backup = getFromBackupByLabelerProduct(normalizedLP);
    if (backup) return mapBackupRow(backup, normalizedLP);

    // If primary eventually succeeds, still return it; otherwise null
    try { const late = await primaryFn(normalizedLP); if (late) return late; } catch { }
    return null;
}

/** Build an in-memory suggest index from the view v_ndc_suggest (created earlier). */
export function buildSuggestIndex({ limit = 250000 } = {}) {
    if (!db) return;
    const rows = db.prepare(`
    SELECT lp, ndc10, brand, generic, substance, ndc_digits
    FROM v_ndc_suggest
    LIMIT ?
  `).all(limit);

    suggestIndex = rows.map(r => ({
        lp: String(r.lp || ''),
        ndc10: r.ndc10 || null,
        brand: r.brand || null,
        generic: r.generic || null,
        substance: r.substance || null,
        _lp: String(r.lp || '').toLowerCase(),
        _brand: (r.brand || '').toLowerCase(),
        _generic: (r.generic || '').toLowerCase(),
        _sub: (r.substance || '').toLowerCase(),
        _digits: (r.ndc10 || '').replace(/\D/g, '') || (r.ndc_digits || ''),
    }));
    console.log('[sqlite] suggest index loaded:', suggestIndex.length);
}

/** RAM query for suggestions; no DB I/O per keystroke. */
export function querySuggestRAM(q, { limit = 20 } = {}) {
    if (!q) return [];
    const s = q.toLowerCase();
    const digits = q.replace(/\D/g, '');
    const out = [];
    const push = (r) => { if (out.length < limit) out.push(r); };

    // 1) labeler-product prefix
    for (const r of suggestIndex) { if (r._lp.startsWith(s)) { push(r); if (out.length >= limit) break; } }
    // 2) numeric prefix (10/11-digit)
    if (out.length < limit && digits) {
        for (const r of suggestIndex) { if (r._digits.startsWith(digits)) { push(r); if (out.length >= limit) break; } }
    }
    // 3) names contains
    if (out.length < limit) {
        for (const r of suggestIndex) {
            if (r._brand.includes(s) || r._generic.includes(s) || r._sub.includes(s)) { push(r); if (out.length >= limit) break; }
        }
    }
    // lean payload
    return out.map(({ lp, ndc10, brand, generic, substance }) => ({ lp, ndc10, brand, generic, substance }));
}
