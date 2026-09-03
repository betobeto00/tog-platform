import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.TOG_PLATFORM_DATA || join(__dirname, '..', 'data')

mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(join(DATA_DIR, 'tog-platform.db'))

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`)

// Aplicar esquema (CREATE TABLE IF NOT EXISTS, idempotente)
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
db.exec(schema)

export function closeDatabase() {
  try {
    db.close()
  } catch {
    // ya cerrada
  }
}

export function getActiveLicense(empresaId) {
  const now = new Date().toISOString().split('T')[0]
  return db
    .prepare(
      `SELECT * FROM licencias
       WHERE empresa_id = ? AND revoked_at IS NULL AND expires_at >= ?
       ORDER BY issued_at DESC LIMIT 1`
    )
    .get(empresaId, now)
}