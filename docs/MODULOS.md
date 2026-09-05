# TOG Platform — Catálogo de Módulos y Activación por Licencia

> Documento de **visión de producto**. Define los módulos que componen TOG Platform, cómo se activan por licencia y cómo se relacionan entre sí. La implementación técnica vive en `ARQUITECTURA-MODULAR.md`; el flujo de pago en `FACTURACION-STRIPE.md`.

---

## 1. La idea

Hoy **TOG Admin** cubre la cara de **Comercialización al mayor y detal** dentro de la cadena:

```
Productor → Procesador → Comercializador → Distribuidor → Cliente final
                                          └─ Postventa
```

La visión de **TOG Platform** es que cada eslabón sea un **módulo activable por licencia** sobre una sola base instalable. El cliente compra los módulos que necesita; el día que necesite otro (por ejemplo pasar de "Productor" a "Productor + Distribuidor"), tú activas el módulo sin reinstalar nada.

---

## 2. El catálogo de módulos

| # | Módulo | Estado | Cubre | Depende de |
|---|--------|--------|-------|-----------|
| 0 | **Core (base)** | ✅ Existe (`tog-admin`) | UI shell, auth, licencia, IPC, persistencia local, auto-update | — |
| 1 | **Productor** | 🟡 Diseño | Siembra, costos de campo, estimación de cosecha, logística de acopio | Core |
| 2 | **Procesador** | 🟡 Diseño | Recepción de materia prima, recetas/BOM, transformación, mermas, lote de salida | Core + Productor (opcional) |
| 3 | **Comercializador** | ✅ Parcial (`tog-admin`) | Inventario (catálogo con producto/servicio, subcategorías, marca e imagen), compras, ventas (incl. **crédito/fiado** con cuentas por cobrar y abonos), cotizaciones, caja, POS | Core |
| 4 | **Distribuidor** | ✅ MVP v1 — clientes + pedidos CRUD (`tog-admin`, 2026-09; migraciones 015/016, gating por licencia, tests) | Clientes (documento de registro internacional: RIF, RFC, EIN…), pedidos con numeración y estados. El **crédito a clientes vive en Comercializador** (migración 021): el POS vende fiado y valida `limite_credito` cuando se vincula a un cliente de este módulo. Pendientes: remitos, listas de precio, rutas, flotas y despachos | Core + Comercializador |
| 5 | **Postventa** | 🟡 Diseño | Tickets de soporte, devoluciones, garantías, notas de crédito | Core + Comercializador |
| 6 | **Administración** | 🟡 Diseño | **Submódulo Contable** (libros: compras, ventas, inventario, mayor, diario; retenciones de ley según el país del cliente), reportes de gestión | Core + Comercializador |
| 7 | **Recursos Humanos** | 🟡 Diseño | Empleados, roles, nómina básica, asistencia (alcance a definir al implementar) | Core |
| 8 | **Restaurant** | ✅ MVP v1 (migración 024, gating por licencia y permisos, tests) | Mesas (CRUD + estado libre/ocupada), comanda por mesa (productos del catálogo con precio autocompletado + ítems manuales), pantalla de cocina (en preparación/listo/servido), **cobro de mesa** que factura solo ítems servidos/listos reutilizando `createVenta` (stock, combos, fiado, caja) | Core + Comercializador |

**Leyenda**: ✅ existe · 🟡 en diseño · ⚪ no iniciado

> Cada módulo, una vez activo, **agrega pantallas, IPC handlers, permisos y (eventualmente) tablas** al Core. No reemplaza nada.

---

## 3. Modelo de licenciamiento

### 3.1 Estructura de una licencia

Una licencia es un JSON firmado RSA (la clave pública ya está embebida en `license.ts`) con esta forma:

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

> ⚠️ **Estado real (4-Sep-2026):** el JSON de arriba es la **visión de producto** (identidad empresa = `pais` ISO 3166-1 + `documento` de registro libre). El backend emite licencias firmadas con esta identidad (ver `src/server.js` / `src/sign.js`); la app las valida con la clave pública embebida (`tog-admin` → `src/main/services/license-crypto.ts`) y el gating de módulos es real (`useActiveModules` + permisos). El formato exacto de la licencia que guarda la app está en `tog-admin/docs/LICENCIAMIENTO.md`.

El **Core** siempre está implícito. Si el cliente desactiva "Comercializador", el módulo sigue instalado pero el Sidebar y los handlers se ocultan.

### 3.2 Tipos de edición

| Edición | Módulos incluidos | Target |
|---------|-------------------|--------|
| **Starter** | Core + Comercializador | Mostrador pequeño (retail, servicios, abasto) |
| **Professional** | Core + Comercializador + Distribuidor | Distribuidor mediano |
| **Enterprise** | Core + todos los módulos disponibles | Cadena completa (Productor → Postventa) |
| **Custom** | Módulos a elección del cliente | Casos atípicos (negociación directa) |

Las ediciones son **bundles comerciales**. Internamente, la licencia sigue siendo un array `modules`. Esto te permite:
- Vender un bundle con descuento.
- Permitir que un cliente compre módulos sueltos sin cambiar de edición.
- Hacer upsell: "estás en Professional, te faltan Productor y Procesador para tener la cadena completa".

### 3.3 Cómo se entrega una licencia nueva / activación de módulo

**Hoy (v1 manual)** — dos caminos, ambos con validación RSA local:
1. **Offline**: tú emites la clave firmada (endpoint `POST /api/empresas/:id/licencias` de este backend, o `scripts/generate-license.js` en tog-admin) y la envías por WhatsApp/correo; Roberto la importa desde la pantalla de bloqueo o desde Configuración.
2. **Online (Sincronizar)**: Roberto abre TOG Admin → Config → Licencia → **Sincronizar** (URL + ID de empresa + API Key) y la app descarga la licencia activa. Probado de punta a punta (ver `README.md` y `tog-admin/docs/QA-SYNC.md`).

**En espera (online automático con pago)**: Roberto paga con tarjeta vía Stripe Checkout; el webhook reactiva/renueva la licencia automáticamente. Código implementado y testeado en este repo (`src/stripe.js`, webhooks, grace period), **pausado** hasta que un cliente quiera pagar online. Detalle en `FACTURACION-STRIPE.md`.

### 3.4 Offline-first, online-cuando-puede

La licencia **siempre** es un archivo firmado local. El Core puede funcionar 100% sin internet. La conexión a tu backend solo aporta:
- Renovaciones automáticas (sin que Roberto tenga que pegar clave nueva cada año).
- Sincronización entre PCs del mismo Roberto.
- Analítica de uso para ti (qué módulos se usan, cuánto).

Si Roberto está offline 100%, el modelo degradado es: **tú le mandas la clave por WhatsApp**, él la pega, sigue funcionando. Nunca bloqueas al cliente por falta de internet.

---

### 3.5 Módulo al iniciar sesión

Idea planificada (no implementada): al hacer login, el usuario **escoge el módulo al que va a entrar** (POS, Distribución, Producción, Administración, Recursos Humanos, Postventa, Restaurant…). Mientras la licencia activa todos los módulos que el usuario puede usar, el login le permite aterrizar directo en el área que le toca. Esto **no** implica módulos separados por usuario: el admin asigna qué módulos y accesos ve cada usuario (ver `INTERCONEXION-RED.md` para el rol manager).

### 3.6 Multi-PC por red local (implementado — spike funcional)

La licencia define el número de PCs conectadas: **1 PC/1 caja** (solo la Base, `max_pcs=1` por default) o **multi-PC de 2 a 20** (Base + hijas, `max_pcs` en la licencia firmada). **Un usuario solo puede estar con sesión activa en una PC a la vez**: `services/red-session.ts` en tog-admin registra `sesiones_activas(usuario_id UNIQUE, par_id, sesion_token)` y rechaza el login si el mismo usuario está activo en otro `par_id`.

Implementación backend de licencias (tog-platform):

- `POST /api/empresas/:id/licencias` acepta `max_pcs` (1–20) en el body y lo incluye firmado en la licencia. Validación en `signLicense` (`src/sign.js`): enteros en rango 1–20; un valor fuera de rango → 400.
- Licencia emitida por Stripe (`emitirLicencia` en `src/server.js`) **no** setea `max_pcs` explícitamente (queda implícito = 1, solo la Base). Si en el futuro un plan de Stripe requiere multi-PC, se debe pasar `max_pcs` por ahí también.
- `src/server.test.js` cubre el caso (rango válido + fuera de rango).

Implementación en tog-admin (migración 031): `pcs_enlazadas`, `sesiones_activas`, `codigos_enlace`. Servicios `red-{config,server,client,session}.ts`. Módulo `red/handlers.ts`. `SetupPage` para PC Hija. UI en Config → Sistema → Red Local.

**Pendiente para producción**: TLS local con cert autofirmado generado al primer arranque de la Base y heartbeat 60 s para expulsar sesiones huérfanas. Detalle completo en `docs/INTERCONEXION-RED.md`.

---

## 4. Cómo se activan los módulos en runtime

Sin reinstalar. Sin descargar otro `.exe`. Sin técnico en sitio.

```
1. Roberto paga (Stripe Checkout o transferencia manual)
         ↓
2. Tu backend actualiza su registro de empresa y firma nueva licencia
         ↓
3a. Online:  Roberto abre TOG Admin → Config → Licencia → "Sincronizar"
            El Core descarga su nueva licencia, valida firma, aplica.
3b. Offline: Tú generas clave → la mandas → Roberto la pega → Core valida.
         ↓
5. Core expone window.api.modules = { comercializador: true, distribuidor: false, ... }
         ↓
6. Sidebar, Router, IPC handlers filtran lo no permitido
         ↓
7. Reinicio (solo del proceso, no de Windows). 5 segundos.
```

El nuevo `.exe` solo se descarga cuando **tú publicas una nueva versión del Core** (cambio mayor de UI, fix crítico, etc.). Eso es independiente de los módulos.

---

## 5. Modelo de entrega: Instalador vs. Nube

### 5.1 Instalador (hoy, único)

- Un solo `TOG-Admin-Setup-x.y.z.exe` (~100–150 MB).
- Trae todos los módulos compilados (el bundle completo).
- Al instalar, solo activa los que la licencia permita.
- Datos en SQLite local (`%APPDATA%/TOG Admin/`).
- Actualización OTA vía electron-updater.
- Sin internet = funciona, excepto sincronización de licencia.

**Ventaja para Roberto**: cero curva de aprendizaje de infra. Instala, listo.
**Ventaja para ti**: cero costo de servidor para el cliente básico. Tú solo pagas hosting para el panel admin web (Vercel free tier aguanta).

### 5.2 Nube (futuro, nice-to-have)

Misma UI, misma licencia, mismos módulos. La diferencia: el proceso Node corre en un contenedor tuyo (Fly.io, Railway, tu propio VPS) y Roberto accede por navegador o por la app Electron apuntando a `https://app.tog-platform.com`.

- Datos en Postgres central (no SQLite local).
- Múltiples usuarios concurrentes.
- Roberto puede entrar desde cualquier PC sin instalar nada.

**Ventaja para Roberto**: cero instalación, acceso desde tablet del almacén, del celular.
**Ventaja para ti**: revenue recurrente más alto (pagas hosting, cobras más), datos centralizados que te dan analítica y upsell.

### 5.3 Cómo construir ambos con un solo código

El Core expone una interfaz `IDataSource` (SQLite hoy, Postgres mañana). El Core expone una interfaz `IAuthProvider` (local hoy, OAuth mañana). El resto del código no sabe dónde corre.

Migración gradual:
1. Core sigue 100% local (hoy).
2. Añades `IDataSource` con implementación `PostgresDataSource` opcional (mañana).
3. El mismo instalador, según licencia, arranca en modo local o modo cloud-client.
4. Los módulos son **idénticos** en ambos modos.

---

## 6. Estrategia de pricing sugerida (referencia, no compromiso)

| Concepto | Precio sugerido |
|----------|-----------------|
| Core + Comercializador (Starter) | $30/mes por empresa + $5/usuario extra |
| Distribuidor (addon) | $25/mes |
| Productor (addon) | $25/mes |
| Procesador (addon) | $30/mes (más complejo, recetas) |
| Postventa (addon) | $15/mes |
| Bundle Professional (Core+Comerc+Distrib) | $70/mes (vs. $80) |
| Bundle Enterprise (todos) | $140/mes (vs. $145) |
| Cloud (sustituye instalador local) | +$50/mes |
| Implementación inicial | $200 one-time (incluye capacitación) |

Estos números son una **referencia para el roadmap**, no la tabla de precios final. El precio real se ajusta con base en feedback de los primeros clientes.

---

## 7. Roadmap por módulo

### Inmediato (mes 0–2): habilitar el catálogo — ✅ hecho (2-Sep-2026; Comercializador ampliado el 4-Sep-2026)
- [x] Catálogo de módulos desde la licencia activa (`src/shared/modules.ts` + `useActiveModules` en tog-admin).
- [x] Sidebar/Router/IPC filtran según módulos de la licencia y permisos.
- [x] Config → Licencia muestra el catálogo y estado de módulos.
- [x] Backend (este repo, SQLite) con CRUD de empresas (`pais` + `documento`) y emisión de licencias firmadas.

### Corto plazo (mes 2–6): Distribuidor + Stripe
- [x] Módulo Distribuidor: tablas `clientes`, `pedidos`, `pedido_detalles`, `remitos`, `listas_precio` (migraciones 015/016).
- [x] CRUD de clientes y pedidos (numeración secuencial, estados) con tests.
- [x] Venta a crédito/fiado en Comercializador: método de pago `fiado` en el POS + página **Créditos** con saldos y abonos (migraciones 020–022 en `tog-admin`; validación de `limite_credito` del cliente cuando la licencia incluye Distribuidor).
- [ ] Remitos y listas de precio con UI; rutas/flotas/despachos.
- [x] Integración Stripe Checkout + webhooks + grace period — ⏸️ **EN ESPERA** de cliente que pague online.
- [ ] Renovación automática online (idem, EN ESPERA).

### Medio plazo (mes 6–12): Productor + Procesador
- [ ] Módulo Productor: siembras, cosechas, costos de campo.
- [ ] Módulo Procesador: recetas/BOM, mermas, transformación.
- [ ] Trazabilidad lote-origen (Lote de maíz → lote de hojuela → remito → cliente final).

### Largo plazo (mes 12+): Nube + Postventa + multi-País + módulos transversales
- [ ] Modo nube con Postgres + autenticación central.
- [ ] Módulo Postventa.
- [ ] Módulo Administración: submódulo **contable** completo (libros: compras, ventas, inventario, mayor, diario; **retenciones de ley según el país del cliente**), reportes de gestión.
- [ ] Módulo Recursos Humanos (empleados, nómina básica, asistencia).
- [x] Módulo Restaurant (mesas, comanda, cocina) — **MVP v1 (4-Sep-2026)**: ver `tog-admin/docs/DISENO-MODULO-RESTAURANTE.md` y `tog-admin/docs/FEATURES.md` (RST1–RST5). Pendientes v2: cuentas divididas, enrutado de comandas a una impresora térmica dedicada (la impresión de comanda ya existe vía el flujo estándar), propinas, áreas del salón.
- [x] Interconexión por red local/Intranet entre PC Base y PC hijas — **spike funcional mergeado (5-Sep-2026)**: ver `tog-admin/docs/ARCHITECTURE.md` sección "Módulo Red Local" + `INTERCONEXION-RED.md`. Pendiente para producción: TLS local + heartbeat 60 s.
- [x] Multi-moneda + símbolo + tasa de cambio (5-Sep-2026) — vive en `configuracion` de tog-admin.
- [ ] Fiscal por país (SENIAT, SUNAT, etc.) — hooks previstos en el Core; proyectos separados.

---

## 8. Lo que NO está en alcance (al menos en v1)

- No es un SaaS multi-tenant hoy. Un Core = una empresa. La nube lo resolverá.
- No hay marketplace de módulos de terceros. Solo módulos propios.
- No hay app móvil nativa. La nube + webview cubre ese caso más adelante.
- No hay facturación electrónica integrada (SENIAT, SUNAT, etc.). Es un proyecto separado; el Comercializador tiene hooks para conectarse a un proveedor externo cuando exista.

---

## 9. Documentos relacionados

- `ARQUITECTURA-MODULAR.md` — cómo se monta el `ModuleLoader`, el contrato Core↔módulos, el sistema de permisos por módulo.
- `FACTURACION-STRIPE.md` — sincronización licencia↔pago, webhooks, modelo offline-first.
- `auto-license-stripe.md` — borrador original del flujo Stripe (referencia).
- `INFORME-ERP.md` — auditoría arquitectónica del estado actual de TOG Admin.