# Bitácora de Conversación — 2025-09-01

> Documento que captura el hilo completo de la sesión: estado de Git, limpieza de secretos, visión de producto TOG Platform, decisiones de licenciamiento, arquitectura modular, integración Stripe y plan de acción.

---

## 1. Punto de partida

El usuario tenía un problema menor en Git:
- Un solo branch (`master`).
- VS Code mostraba "Publish Branch" aunque la rama ya estaba sincronizada con `origin/master`.

**Diagnóstico**: el aviso era caché. `git push` respondía "Everything up-to-date" y el upstream ya estaba vinculado (`origin/master`). Recargar VS Code (`Ctrl+Shift+P` → "Reload Window") resolvió el aviso.

---

## 2. Limpieza del `GH_TOKEN`

**Hallazgo crítico** (vía exploración del repo): en el `.env` local aparecía un Personal Access Token de GitHub literal:

```
GH_TOKEN=ghp_REDACTED_POR_PUSH_PROTECTION
```

**Verificación de la auditoría** (`docs/INFORME-ERP.md` ítem #8): el reporte marcaba esto como "🔴 Crítica seguridad, rotar inmediatamente".

**Decisión del usuario**: "El GH_TOKEN es cosmético, no se usa para nada. El GitHub ya no existe. Puedes eliminar eso. Las actualizaciones son por electron con el tag de repo público."

**Verificación técnica**: confirmada. `src/main/services/updater.ts` **NO** lee ni usa `GH_TOKEN`/`GITHUB_TOKEN`. El `package.json` apunta a un repo público (`betobeto00/tog-admin`), `electron-updater` consume `releases.atom` sin autenticación. El token del `.env` era residual.

**Acciones realizadas**:
1. Eliminado `.env` del entorno local (nunca estuvo en git, `.gitignore` ya lo bloqueaba).
2. `docs/UPDATER_NOTES.md` reescrito: refleja que el repo es público, sin tokens, `updater.ts` no consume tokens. Se conservó el flujo para repos privados como referencia histórica.
3. `docs/INFORME-ERP.md` actualizado: el ítem crítico #1 marcado como "🟢 Resuelto".

---

## 3. La idea: sistema modular por eslabones de la cadena productiva

El usuario planteó una visión:

> "Quiero hacer un sistema por módulos que se activan o desactivan en función de lo que el cliente dice: Por ejemplo un cliente que siembra maíz, procesa maíz, lo convierte en hojuelas de maíz, empaqueta, distribuye, comercializa al mayor y detal y tiene un servicio de Postventa. TOG Admin es apenas la parte de Comercializa. Y medio medio porque no está adaptado a esto."

**Pregunta clave**: ¿TOG Admin se pudiera integrar como si fuera un módulo de esta idea?

**Auditoría técnica completa** delegada a subagente (`explore`, thoroughness="very thorough"). Resultado:

- TOG Admin **NO** es un CRUD genérico; es un POS Electron monolítico con lógica de dominio escondida en los IPC handlers (`ipc-handlers.ts`, 1578 líneas).
- El modelo de datos (venta, compra, caja, stock, cotización) **es casi exactamente** lo que necesita un módulo de Comercialización.
- **Pero**: acoplado a Electron + SQLite monolítico, sin service layer, sin DI, sin tests del main process, con permisos del backend **desconectados** de los handlers.

**Veredicto**: viable como base conceptual, **NO** como drop-in. Requiere refactor de 6–10 semanas + extensión de 12–16 semanas para el vertical maíz→hojuelas.

---

## 4. La pregunta del instalador

El usuario formuló una pregunta de negocio crucial:

> "¿Al final yo tendría varios instaladores por módulo o desde el Instalador de TOG Admin.exe habilito los módulos end to end? [...] Si alguien tiene el módulo del primer eslabón Productor y quiere expandirse y me llaman: Roberto necesitamos ampliarnos porque vamos a distribuir nuestro producto. ¿Le envío un instalador y actualizo el sistema o le envío una licencia por correo que habilita el módulo?"

**Tres opciones evaluadas**:

| Opción | Resumen | Veredicto |
|--------|---------|-----------|
| **A. Un instalador, módulos por licencia** | Un `.exe` que trae todos los módulos compilados. Activación = cambio de licencia + reinicio. | ✅ Viable |
| **B. Un instalador por módulo** | Un `.exe` base + un `.exe` por cada módulo. Pesadilla operativa. | ❌ Descartado |
| **C. A + delta OTA + marketplace local** | Un `.exe`, activación online opcional con panel admin, sync offline-first. | ✅ **Elegida** |

**Decisión del usuario**: "Me gusta la opción C."

**Flujo cuando Roberto llama**:
1. Roberto paga (Stripe o transferencia).
2. Tu backend actualiza su registro de empresa y firma nueva licencia.
3. Online: Roberto abre TOG Admin → Config → Licencia → "Sincronizar". Módulo activo.
4. Offline: tú le mandas la clave por WhatsApp. Él la pega. Módulo activo.

**Mismo `.exe`, misma instalación, mismos datos. Sin reinstalar.**

---

## 5. Repos: 2, no 3

El usuario tiene dos repos existentes:
- `betobeto00/landing-page` (landing de OmniMargen, su marca).
- `betobeto00/tog-admin` (producto actual).

**Pregunta**: ¿repos separados para la documentación de visión modular?

**Análisis presentado**:

| Repo | Ventajas | Desventajas |
|------|----------|-------------|
| Único (todo en TOG Admin) | Una sola fuente, una CI, docs cerca del código | Mezcla marca/producto, info de negocio expuesta |
| 3 separados (landing + platform + admin) | Máxima separación | Overhead sin producto aún |
| **2 separados** (landing + platform que contiene visión, tog-admin con código) | Separa "marca" de "producto", permite roadmap de módulos sin filtrar código | Requiere disciplina de sincronización |

**Decisión**: 2 repos. La visión macro (módulos, licencia, arquitectura) va a `tog-platform` (docs-only). `tog-admin` sigue siendo código del primer producto.

```
betobeto00/landing-page      ← marketing OmniMargen
betobeto00/tog-platform      ← visión: módulos, licencia, ADRs
betobeto00/tog-admin         ← código producto (referencia a tog-platform)
```

---

## 6. Los tres documentos de visión

### 6.1 `MODULOS.md` — visión de producto

Catálogo de módulos para la cadena maíz→hojuelas→distribución→postventa:

| # | Módulo | Estado |
|---|--------|--------|
| 0 | **Core (base)** | ✅ Existe (`tog-admin`) |
| 1 | **Productor** | 🟡 Diseño |
| 2 | **Procesador** | 🟡 Diseño |
| 3 | **Comercializador** | ✅ Parcial (`tog-admin`) |
| 4 | **Distribuidor** | 🟡 Diseño |
| 5 | **Postventa** | 🟡 Diseño |

**Modelo de licenciamiento**:
- Licencia = JSON firmado RSA con `{ empresa, rif, issued_at, expires_at, modules[], max_usuarios, max_sucursales, edition, signature }`.
- Ediciones como bundles: Starter, Professional, Enterprise, Custom.
- **Offline-first, online-cuando-puede**: la licencia siempre es un archivo firmado local. La conexión solo aporta renovaciones automáticas, sync entre PCs y analítica.

**Pricing de referencia** (no compromiso):

| Concepto | Precio sugerido |
|----------|-----------------|
| Starter | $30/mes + $5/usuario extra |
| Distribuidor (addon) | $25/mes |
| Productor (addon) | $25/mes |
| Procesador (addon) | $30/mes |
| Postventa (addon) | $15/mes |
| Bundle Professional | $70/mes |
| Bundle Enterprise | $140/mes |
| Cloud (sustituye instalador) | +$50/mes |

### 6.2 `ARQUITECTURA-MODULAR.md` — arquitectura técnica

- **5 principios de diseño**: Core obligatorio, módulos aditivos, `ModuleAPI` estable, sin imports entre módulos (event bus), sin acoplamiento al transporte.
- **`ModuleManifest`**: contrato único Core↔módulo (id, version, requires[], permissions[], ipcChannels[], routes[], sidebar[], migrations[], onInit, onDestroy).
- **`ModuleContext`**: lo que el Core le da al módulo (db, events, log, license, registerIpc, registerRoute, registerSidebarItem, config, hooks).
- **`ModuleLoader`**: lee licencia, monta módulos válidos, valida dependencias.
- **Event bus** entre módulos (`distribuidor.pedido.creado → comercializador descuenta stock`).
- **Migraciones**: opción B para v1 (todas las tablas viven en el Core, los módulos solo consultan). Pasar a opción C cuando haya 3+ módulos con tablas propias.
- **Dualidad instalador/nube**: `IDataSource` con implementaciones `SqliteDataSource` y `PostgresDataSource`. Mismo código, mismo UI.
- **Plan de migración en 4 fases**:
  1. Partir `ipc-handlers.ts` + sentar bases del ModuleLoader.
  2. Convertir Comercializador en módulo.
  3. Añadir Distribuidor.
  4. Productor, Procesador, Postventa.

### 6.3 `FACTURACION-STRIPE.md` — integración Stripe↔licencia

- **Stack del backend**: Node + Express + Postgres + Stripe. Costo mensual al inicio: $0 hasta ~50 clientes activos.
- **Principios**:
  1. Licencia siempre local y offline-first.
  2. Stripe nunca toca la app de escritorio.
  3. Backend es la única fuente de verdad sobre el estado de la suscripción.
  4. Grace period generoso.
- **Flujo Roberto compra módulo** (online y offline).
- **Modelo de datos del backend**: `empresas`, `licencias`, `suscripciones`, `webhook_events` (con idempotencia por `stripe_event_id`).
- **Webhooks de Stripe**: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
- **Grace period de 14 días** en modo lectura ante fallo de pago (configurable, no hardcoded).
- **Firma RSA**: backend firma con clave privada (en variables de entorno), app valida con clave pública embebida.
- **Roadmap MVP Stripe**: 10 semanas (backend + sincronización + checkout + webhook + grace period + portal + panel admin).

---

## 7. Decisiones de producto cerradas

1. **Un solo `.exe`** con todos los módulos. Activación por licencia, no por instalador.
2. **Offline-first**. Roberto puede operar sin internet.
3. **Stripe** para pagos automáticos (con fallback manual/transferencia, ciudadano de primera).
4. **Grace period de 14 días** en modo lectura ante fallo de pago.
5. **2 repos**: `tog-platform` (visión), `tog-admin` (código).
6. **`FACTURACION-STRIPE.md`** hereda y amplía `auto-license-stripe.md` (borrador original se conserva como referencia histórica).

---

## 8. Acciones inmediatas identificadas

| # | Acción | Estado |
|---|--------|--------|
| 1 | Rotar/eliminar `GH_TOKEN` | ✅ Resuelto (esta sesión) |
| 2 | Conectar `requirePermission` a TODOS los IPC handlers | 🔴 Pendiente (próximo paso) |
| 3 | Crear repo `tog-platform` con los 3 docs de visión | 🔴 Pendiente (próximo paso) |

**Acción #2 es crítica**: hoy cualquier cliente IPC bypasea los permisos del backend. La auditoría mapeó **73 handlers sin protección** de 81 totales. Solo 8 son públicos (`app:version`, `i18n:*`, `crash-report:save`, `auth:login`, `license:status`, `license:validate`).

**Permisos nuevos propuestos** (4):
- `usuarios_change_own_password` — para que un cajero pueda cambiar su clave sin tener `usuarios_access` completo.
- `quotes_edit` — separar crear de editar cotizaciones.
- `quotes_delete` — borrar cotizaciones es destructivo, no debe compartir permiso con crear.
- `license_manage` — manipular licencia es del dueño del negocio, no de un cajero.

---

## 9. Lo que NO está en alcance (al menos en v1)

- No es SaaS multi-tenant hoy. Un Core = una empresa. La nube lo resolverá.
- No hay marketplace de módulos de terceros.
- No hay app móvil nativa. La nube + webview cubre ese caso.
- No hay facturación electrónica integrada (SENIAT, SUNAT, etc.).

---

## 10. Lo que sigue

1. **Esta sesión (en curso)**:
   - [x] Acción 1: Documentar conversación (este archivo).
   - [ ] Acción 2: Conectar permisos a todos los IPC handlers.
   - [ ] Acción 3: Crear repo `tog-platform` con los 3 docs y push a GitHub.

2. **Próximas sesiones**:
   - Partir `ipc-handlers.ts` en archivos por dominio.
   - Crear `ModuleLoader` y `ModuleManifest` (Fase 1 de migración).
   - Mock del backend de licencias en local para que Roberto pueda probar sin Stripe real.
   - Integración Stripe Checkout para Distribuidor (sprint 2 del roadmap).

---

## 11. Referencias cruzadas

- `INFORME-ERP.md` — auditoría técnica inicial.
- `MODULOS.md` — visión de producto, catálogo, pricing, roadmap por módulo.
- `ARQUITECTURA-MODULAR.md` — cómo se monta el ModuleLoader, contrato Core↔módulos.
- `FACTURACION-STRIPE.md` — sincronización licencia↔pago, webhooks, modelo offline-first.
- `auto-license-stripe.md` — borrador original del flujo Stripe (referencia histórica).
- `UPDATER_NOTES.md` — notas sobre auto-actualización (actualizado: repo público, sin tokens).