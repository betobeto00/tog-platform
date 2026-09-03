# TOG Platform

> Repositorio del ecosistema TOG Platform: **visión y arquitectura** (`docs/`) **+ backend de licencias** (`src/`, Node + SQLite).
> Producto y diseño técnico para OmniMargen.

---

## ¿Qué es TOG Platform?

TOG Platform es la visión de un **sistema modular activable por licencia** para empresas de la cadena productiva agrícola/industrial. Cubre los eslabones:

```
Productor → Procesador → Comercializador → Distribuidor → Postventa
                                          └─ Cliente final
```

Cada eslabón es un **módulo** que se activa/desactiva según lo que el cliente necesita. La activación es por licencia firmada (offline-first), no por instalador. Un solo `.exe` trae todos los módulos compilados.

## Productos del ecosistema

| Producto | Repo | Estado |
|----------|------|--------|
| **TOG Admin** (módulo Comercializador) | [`betobeto00/tog-admin`](https://github.com/betobeto00/tog-admin) | ✅ v1.0.8 |
| **Landing OmniMargen** | [`betobeto00/landing-page`](https://github.com/betobeto00/landing-page) | ✅ Producción |
| **TOG Platform** (este repo) | [`betobeto00/tog-platform`](https://github.com/betobeto00/tog-platform) | ⚙️ Backend MVP + docs |

## Documentación

Toda la documentación vive en [`docs/`](./docs/).

| Doc | Propósito |
|-----|-----------|
| [`MODULOS.md`](./docs/MODULOS.md) | Catálogo de módulos (Productor, Procesador, Comercializador, Distribuidor, Postventa). Ediciones (Starter, Professional, Enterprise, Custom). Modelo de licenciamiento. Pricing de referencia. Roadmap por módulo. |
| [`ARQUITECTURA-MODULAR.md`](./docs/ARQUITECTURA-MODULAR.md) | Diseño técnico del `ModuleManifest`, `ModuleContext`, `ModuleLoader`, EventBus entre módulos. Plan de migración del monolito actual a la arquitectura modular. Dualidad instalador/nube via `IDataSource`. |
| [`FACTURACION-STRIPE.md`](./docs/FACTURACION-STRIPE.md) | Integración Stripe↔licencia. Backend de licencias (Node + Postgres + Stripe). Webhooks idempotentes. Grace period de 14 días. Modelo offline-first. Seguridad RSA. |
| [`CONVERSACION-2025-09-01.md`](./docs/CONVERSACION-2025-09-01.md) | Bitácora de la sesión de diseño (limpieza del repo, visión de módulos, modelo de licenciamiento). |
| [`CONVERSACION-2026-09-02.md`](./docs/CONVERSACION-2026-09-02.md) | Bitácora de la sesión de implementación (módulo Distribuidor, backend verificado, identidad internacional, sync de licencia). |

## Modelo de licenciamiento (resumen)

Una licencia es un JSON firmado RSA:

```json
{
  "empresa": "AgroMaíz C.A.",
  "pais": "VE",
  "documento": "J-12345678-9",
  "issued_at": "2025-01-15",
  "expires_at": "2026-01-15",
  "modules": ["core", "comercializador", "distribuidor"],
  "max_usuarios": 5,
  "max_sucursales": 1,
  "edition": "professional",
  "signature": "base64-rsa-signature"
}
```

**Offline-first.** La licencia siempre es local. La sincronización online (Stripe) aporta renovaciones automáticas y sync entre PCs.

**Mercado internacional.** El mercado no es solo Venezuela: la empresa se identifica por **país (ISO 3166-1 alpha-2) + documento de registro/tributario libre** (RIF, EIN, RFC, NIT, CUIT, CNPJ, VAT…). El mismo número en países distintos son empresas distintas.

**Activación de un módulo nuevo:**
1. Roberto paga (Stripe o transferencia).
2. Tu backend actualiza la empresa y firma nueva licencia.
3. Roberto abre TOG Admin → Config → Licencia → "Sincronizar".
4. Módulo activo. Sin reinstalar. Sin reiniciar Windows.

## Entrega: instalador vs. nube

| Modo | Hoy | Mañana |
|------|-----|--------|
| **Instalador** | ✅ Único `.exe`, módulos activables por licencia | Sigue igual |
| **Nube** | ⏭️ No | Mismo código, `IDataSource` apunta a Postgres central |

Cuando llegue el momento de la nube, **no hay reescritura**: solo se cambia la implementación de `IDataSource` (SQLite → Postgres). El resto del código no sabe dónde corre.

## Estado del proyecto

```
[██░░░░░░░░░░░░░░░░░░] ~10%  ← TOG Admin existe (Comercializador)
```

```
[░░░░░░░░░░░░░░░░░░░░] 0%    ← Distribuidor (diseño)
[░░░░░░░░░░░░░░░░░░░░] 0%    ← Productor (diseño)
[░░░░░░░░░░░░░░░░░░░░] 0%    ← Procesador (diseño)
[░░░░░░░░░░░░░░░░░░░░] 0%    ← Postventa (diseño)
```

## Roadmap inmediato

| Sprint | Acción |
|--------|--------|
| ✅ 0 | Limpieza del repo TOG Admin (token GH residual, permisos backend) |
| ✅ 1 | Backend de licencias en este repo (SQLite + firma RSA) — ver sección siguiente |
| ✅ 1 | Sincronización licencia local ↔ backend (canal pre-auth `license:sync` en Config y bloqueo) |
| ✅ 5 | Módulo Distribuidor MVP en tog-admin (CRUD clientes; pedidos en construcción) |
| 🟡 2 | Stripe Checkout MVP implementado en el backend — falta QA con claves reales y portal del cliente |
| 🟡 3 | Webhooks de Stripe + grace period |
| 🟡 4 | Customer Portal + panel admin web mínimo |

## Backend de licencias (implementación en este repo)

El repo ya **no es solo documentación**: también contiene el backend MVP (Node + SQLite, cero dependencias runtime).

```bash
npm start          # servidor en http://localhost:3001 (requiere la clave privada: LICENSE_PRIVATE_KEY_PATH)
npm test           # suite de integración (node:test)
npm run test:sign  # autotest de firma RSA
```

Variables de entorno (ver [`.env.example`](./.env.example)): `PORT`, `ADMIN_API_KEY`, `LICENSE_PRIVATE_KEY_PATH`, `TOG_PLATFORM_DATA`.

**Endpoints:**

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/api/health` | — | Estado (DB + clave de firma) |
| `POST` | `/api/empresas` | `X-Admin-Key` | Alta de empresa: `{ nombre, pais?, documento, email_contacto }` → genera `api_key` |
| `GET` | `/api/admin/empresas` | `X-Admin-Key` | Listado de empresas |
| `POST` | `/api/empresas/:id/licencias` | `X-Admin-Key` | Emisión manual de licencia firmada `{ cliente, expira, modules? }` |
| `GET` | `/api/empresas/:id/licencia` | `X-Api-Key` | Licencia activa para el botón “Sincronizar” de la app |
| `POST` | `/api/checkout-session` | `X-Api-Key` | Suscripción de un módulo vía Stripe Checkout (`{ modulo }`). Requiere `STRIPE_SECRET_KEY` + `STRIPE_PRICE_<MODULO>` |
| `POST` | `/api/webhook/stripe` | firma | Eventos idempotentes: activa la licencia al pagar (`checkout.session.completed`) |

Ver detalle completo en [`docs/MODULOS.md`](./docs/MODULOS.md#7-roadmap-por-m%C3%B3dulo).

## Contacto

- Marca: **OmniMargen**
- Autor: Roberto (betobeto00)
- Repos relacionados: [tog-admin](https://github.com/betobeto00/tog-admin), [landing-page](https://github.com/betobeto00/landing-page)

---

> Documentación viva. Los ADRs (Architecture Decision Records) se agregarán en `docs/adr/` cuando se tome cada decisión arquitectónica formal.