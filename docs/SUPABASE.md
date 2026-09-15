# Postgres / Supabase en TOG Platform

> Cómo corre la base de datos del backend de licencias. Decisión y contexto
> completo: `docs/DECISION_BASE_DE_DATOS.md` (raíz del workspace).

## Los dos modos

`src/db.js` elige el motor **al arrancar**:

| `DATABASE_URL` | Motor | Para qué |
|---|---|---|
| Definida | Postgres (Supabase) | **Producción**. Persistente |
| Ausente | SQLite (`data/tog-platform.db`, o `TOG_PLATFORM_DATA`) | **Dev y tests**. Descartable |

En Railway el filesystem es efímero: sin `DATABASE_URL` el backend funciona pero
**pierde todo en cada deploy** (empresas, licencias, pagos, usuarios, secretos 2FA).
Por eso en producción `DATABASE_URL` es obligatoria de facto — no hay un chequeo que
mate el proceso (los tests la omiten a propósito), así que verificá con
`railway variables` que esté seteada.

```bash
# Verificar qué motor está usando producción
railway variables | grep DATABASE_URL
```

## Esquema

- `src/schema.sql` es la única definición, escrita para funcionar en ambos motores
  (`INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`, `datetime('now')` → `NOW()`).
- Se aplica **en cada arranque** con `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- Como `CREATE TABLE IF NOT EXISTS` **no** agrega columnas a una tabla existente, toda
  columna nueva va además a `MIGRACIONES_POSTGRES` en `src/db.js`
  (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Ejemplo vigente: `empresas.vendedor_id`.

### Tablas de este backend

`empresas`, `licencias`, `device_fingerprint_audit`, `users`, `password_resets`,
`pagos`, `two_factor_auth`, `two_factor_backup_codes`, `two_factor_logs`.

Las tablas del sistema de vendedores (`vendedores`, `vendedor_clientes`,
`vendedor_comisiones`, …) son de la landing page y **no** se crean desde acá; el
backend sólo las usa en `src/vendedores.js` para vincular un cliente con su vendedor.
Si no existen (SQLite dev), `POST /api/empresas/:id/vendedor` responde `503`.

## Migraciones

`supabase/migrations/` se aplican a mano (`supabase db push` o el SQL Editor):

| Archivo | Contenido |
|---|---|
| `001_rls_policies.sql` | RLS en las 9 tablas del backend + las 5 de vendedores, políticas `TO service_role` y creación de las tablas de vendedores |
| `002_vendedores_auth.sql` | `vendedores.password_hash` (obligatorio para que el login de vendedores funcione) |

**Reglas de RLS**: el esquema `public` de Supabase es alcanzable con la **anon key**
(pública). Toda tabla nueva necesita `ENABLE ROW LEVEL SECURITY` y políticas
explícitas `TO service_role`. `src/db.js` verifica al arrancar y avisa por consola si
alguna tabla del backend quedó sin RLS. El backend nunca usa la anon key: conecta con
el connection string (rol owner) o con `service_role`.

## Transacciones

Usá `withTransaction(async (tx) => { ... })` de `src/db.js`, **nunca** `db.exec('BEGIN')`:
en Postgres el pool reparte cada query entre conexiones distintas, así que un `BEGIN`
suelto no abre nada y el `COMMIT` puede caer en otra conexión. `withTransaction`
reserva una conexión y expone `tx` con la misma API que `db`.

## Escribir queries portables

- Placeholders `$1, $2…` (SQLite los normaliza a `?` automáticamente).
- Nada de booleanos contra columnas `INTEGER`: `SET usado = TRUE` falla en Postgres
  ("column is of type integer but expression is of type boolean"). Usá `= 1`.
- `INSERT` que necesite el id: agregá `RETURNING id` (SQLite y Postgres lo soportan;
  `db.run()` devuelve `lastInsertRowid` en ambos modos).
- Ojo con `exec('BEGIN')`, `AUTOINCREMENT`, `datetime('now')` y `INSERT OR REPLACE`
  (este último no existe en Postgres).

## Certificar la rama Postgres sin tocar Supabase

Los 71 tests corren en SQLite por defecto. Para ejercitar Postgres de verdad, levantá
un Postgres efímero y corré la suite con `DATABASE_URL` (los tests se aíslan por
directorio temporal en SQLite, pero en Postgres comparten base: se resetea el esquema
entre archivos):

```bash
docker run -d --rm --name togpg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=togtest -p 55432:5432 postgres:16-alpine

export DATABASE_URL='postgresql://postgres:test@localhost:55432/togtest'
for f in src/*.test.js; do
  docker exec togpg psql -U postgres -d togtest -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  echo "== $f"; node --test "$f" | grep -E "^ℹ (tests|pass|fail)"
done

docker stop togpg
```

Resultado de la última corrida (2026-09-14): **73/73 en Postgres** (incluye los 2
tests Postgres-only de `vendedores.test.js`) y **71/71 en SQLite**.
