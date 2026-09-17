import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.TOG_PLATFORM_DATA || join(__dirname, '..', 'data')

let pool = null
let sqliteDb = null
// En producción (Railway) SIEMPRE debe estar DATABASE_URL apuntando a Postgres
// (Supabase): sin ella el backend cae a SQLite en un disco efímero y pierde los
// datos en cada deploy. SQLite queda sólo para dev y tests.
export const isPostgres = !!process.env.DATABASE_URL

// Columnas/tablas agregadas después del esquema inicial (ver docs/SUPABASE.md).
const MIGRACIONES_POSTGRES = [
  // FASE 5: vínculo de la empresa con el vendedor que la trajo (ID humano OMV-XXXXX).
  'ALTER TABLE empresas ADD COLUMN IF NOT EXISTS vendedor_id TEXT',
  // Separación de device_fingerprint (OmniServ Android) y desktop_machine_id (TOG Admin desktop).
  'ALTER TABLE empresas ADD COLUMN IF NOT EXISTS desktop_machine_id TEXT',
]

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

  // Migraciones idempotentes de columnas nuevas. En Postgres `CREATE TABLE IF
  // NOT EXISTS` no toca una tabla que ya existe, así que toda columna agregada
  // después del esquema inicial tiene que aparecer acá. En SQLite (dev/test) no
  // hace falta: la DB se crea desde schema.sql.
  for (const sql of MIGRACIONES_POSTGRES) {
    await pool.query(sql)
  }

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

// Ejecuta contra Postgres. Se parametriza el ejecutor para poder crear un
// adaptador "scoped" sobre un único cliente del pool (ver withTransaction).
function createPostgresAdapter(query) {
  return {
    prepare(sql) {
      return {
        get(...args) {
          return query(sql, args).then((r) => r.rows[0] ?? null)
        },
        all(...args) {
          return query(sql, args).then((r) => r.rows)
        },
        run(...args) {
          return query(sql, args).then((r) => ({
            changes: r.rowCount,
            lastInsertRowid: r.rows[0]?.id ?? null,
          }))
        },
      }
    },
    exec(sql) {
      return query(sql, [])
    },
  }
}

const postgresQuery = (sql, args) => pool.query(sql, args)

function createSqliteAdapter() {
  return {
    prepare(sql) {
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
      sqliteDb.exec(sql)
    },
    close() {
      try {
        sqliteDb.close()
      } catch {}
    },
  }
}

export const db = isPostgres
  ? { ...createPostgresAdapter(postgresQuery), close: () => pool.end() }
  : createSqliteAdapter()

export function closeDatabase() {
  return db.close()
}

/**
 * Corre `fn` dentro de una transacción real.
 *
 * Por qué existe: en Postgres el pool reparte cada `query` entre conexiones
 * distintas, así que hacer `db.exec('BEGIN')` y después `db.prepare(...)` NO
 * ejecuta nada dentro de esa transacción (y el COMMIT puede caer en una conexión
 * sin transacción). Acá se reserva una conexión y todas las queries van por ella.
 * En SQLite la transacción es de la conexión única, así que basta BEGIN/COMMIT.
 *
 * Recibe `(tx)` — un adaptador con la misma API que `db` — y devuelve lo que
 * devuelva `fn`. Si `fn` lanza, hace ROLLBACK y propaga el error.
 */
export async function withTransaction(fn) {
  if (isPostgres) {
    const client = await pool.connect()
    const tx = createPostgresAdapter((sql, args) => client.query(sql, args))
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {}
      throw err
    } finally {
      client.release()
    }
  }

  sqliteDb.exec('BEGIN')
  try {
    const result = await fn(db)
    sqliteDb.exec('COMMIT')
    return result
  } catch (err) {
    try {
      sqliteDb.exec('ROLLBACK')
    } catch {}
    throw err
  }
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
