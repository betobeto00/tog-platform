import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.TOG_PLATFORM_DATA || join(__dirname, '..', 'data')

let pool = null
let sqliteDb = null
const isPostgres = !!process.env.DATABASE_URL

// Tablas del backend. Se usan para verificar RLS en Postgres (Supabase).
const TABLAS_ECOSISTEMA = [
  'empresas',
  'licencias',
  'users',
  'password_resets',
  'pagos',
  'device_fingerprint_audit',
  'two_factor_auth',
  'two_factor_backup_codes',
  'two_factor_logs',
]

if (isPostgres) {
  const pg = await import('pg')
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false,
  })
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/datetime\('now'\)/g, 'NOW()')
  await pool.query(schema)

  // Aviso de seguridad: en Supabase el esquema `public` es alcanzable con la
  // anon key. Si RLS está deshabilitado en nuestras tablas, los datos (incluidos
  // los secretos 2FA) quedan expuestos a quien tenga esa key pública.
  try {
    const { rows } = await pool.query(
      `SELECT c.relname AS tabla
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY($1)
          AND NOT c.relrowsecurity`,
      [TABLAS_ECOSISTEMA],
    )
    if (rows.length > 0) {
      console.warn(`⚠️  RLS deshabilitado en: ${rows.map((r) => r.tabla).join(', ')}`)
      console.warn('   Esquema `public` + anon key = datos expuestos. Ejecuta')
      console.warn('   supabase/migrations/001_rls_policies.sql (ver docs/FACTURACION-CRIXTO.md).')
    }
  } catch (err) {
    console.warn(`⚠️  No se pudo verificar RLS: ${err?.message || err}`)
  }
} else {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(DATA_DIR, { recursive: true })
  sqliteDb = new DatabaseSync(join(DATA_DIR, 'tog-platform.db'))
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
  sqliteDb.exec(schema)
}

// NOW() para Postgres, datetime('now') para SQLite
export const NOW = isPostgres ? 'NOW()' : "datetime('now')"

export const db = {
  prepare(sql) {
    if (pool) {
      return {
        get(...args) {
          return pool.query(sql, args).then((r) => r.rows[0] ?? null)
        },
        all(...args) {
          return pool.query(sql, args).then((r) => r.rows)
        },
        run(...args) {
          return pool.query(sql, args).then((r) => ({
            changes: r.rowCount,
            lastInsertRowid: r.rows[0]?.id ?? null,
          }))
        },
      }
    }
    const normalized = sql.replace(/\$\d+/g, '?')
    return {
      get(...args) {
        return sqliteDb.prepare(normalized).get(...args) ?? null
      },
      all(...args) {
        return sqliteDb.prepare(normalized).all(...args)
      },
      run(...args) {
        const info = sqliteDb.prepare(normalized).run(...args)
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
      },
    }
  },
  exec(sql) {
    if (pool) return pool.query(sql)
    sqliteDb.exec(sql)
  },
  close() {
    if (pool) return pool.end()
    try { sqliteDb.close() } catch {}
  },
}

export function closeDatabase() {
  return db.close()
}

export async function getActiveLicense(empresaId) {
  const now = new Date().toISOString().split('T')[0]
  const result = await db.prepare(
    `SELECT * FROM licencias
     WHERE empresa_id = $1 AND revoked_at IS NULL AND expires_at >= $2
     ORDER BY issued_at DESC LIMIT 1`
  ).get(empresaId, now)
  return result ?? null
}
