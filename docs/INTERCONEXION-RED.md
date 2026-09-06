# Interconexión por Red Local / Intranet — Visión de diseño

> 🕓 **Documento de planificación** — esto **no está implementado**. Define la
> dirección de la interconexión entre PCs del mismo cliente (misma empresa y
> licencia) para desarrollarla cuando corresponda. Se prioriza **simplicidad y
> seguridad mínima suficiente**, sin sobreingeniería (misma política que
> `FACTURACION-STRIPE.md`).

---

## Objetivo

El cliente instala el sistema en **una PC Base** (la que tiene la licencia
activa) y desde ahí se enlazan **PC hijas** (cajas, terminales) dentro de la
misma red local / Intranet. Sin internet obligatorio, sin servidor externo.

- **PC Base** — corre la licencia, la DB y el servicio de enlace. Actúa como
  autoridad de la red local.
- **PC hijas** — instalaciones del mismo `.exe`, sin licencia propia: se
  conectan a la Base para trabajar con los mismos datos.

## Reglas de licencia

| Escenario | Máx. PCs conectadas |
|-----------|---------------------|
| Licencia 1 PC / 1 caja | Solo la Base (sin hijas) |
| Licencia multi-PC | Desde 2 hasta 20 PCs (Base + hijas) |

La cantidad la define la licencia (`max_usuarios` / un nuevo campo tipo
`max_pcs`). Si una hija intenta conectarse y se supera el tope, la Base lo
rechaza.

## Sesión única por usuario

**Un usuario solo puede estar conectado una vez a la vez** en todo el grupo:
si `admin` está con sesión en la PC 1, no puede iniciar en la PC 2 (ni en
ninguna hija). La Base lleva el registro de sesiones activas y lo valida al
hacer login (local o remoto).

## Modelo operativo (cómo se ve en la práctica)

1. El cliente instala `TOG Admin` en su **PC Base** y activa su licencia
   normalmente (igual que hoy).
2. El admin de la empresa crea los **usuarios** (POS, cajeros, manager) y
   les asigna **módulos y permisos** desde `Configuración → Usuarios` (esto ya
   está implementado en tog-admin).
3. En la PC Base, en `Configuración → Red` (futuro), el admin genera un
   **código de enlace** (token breve, de un solo uso por hija).
4. En cada PC hija, el operador abre `TOG Admin` y en la pantalla de
   bloqueo / primer inicio elige "Conectar a una PC Base", ingresa la IP
   local de la Base y el código.
5. La hija queda enlazada a la Base. Cualquier login contra la Base valida:
   - Que el usuario no esté ya con sesión activa en otra PC.
   - Que la Base tenga cupo disponible (`max_pcs`).
   - Que el cliente tenga los permisos que correspondan.
6. La Base persiste todas las sesiones activas (SQLite) y expulsa a la
   anterior si alguien intenta reentrar.

## Enlace entre PCs — dirección propuesta

La idea base: cuando se instala en la PC Base y se activa, la Base genera un
**código de enlace** (token) que el admin usa en las hijas para vincularlas.

1. **Instalar y activar en la PC Base** — normal, como hoy (licencia local).
2. **Generar código de enlace** en la Base (Config → Red): token breve, con
   expiración y de un solo uso por hija.
3. **En cada PC hija** (Primer Inicio → "Conectar a una PC Base") el admin
   ingresa: dirección/IP de la Base + el código de enlace.
4. La hija **solicita unión** a la Base; la Base valida el token, registra la
   hija y le entrega un **certificado/credencial de par**.
5. A partir de ahí, la hija y la Base se hablan cifrado (TLS local o canal
   cifrado simétrico) y la hija **no** necesita licencia propia: la valida la
   Base contra la licencia activa.

### Anti-bypass (mínimo suficiente)

- La unión exige el **token de la Base** (no se puede inventar una hija).
- El canal se **cifra** y cada par usa una credencial única (no hay
  autenticación débil por IP sola).
- La Base **firma** las respuestas (reusa la clave privada de la licencia o
  un par de claves de red local) para que una hija no pueda modificar la
  licencia / módulos que se le sirven.
- El **tope de PCs** lo aplica la Base.
- La sesión única la aplica la Base (y las hijas consultan antes de abrir).

## Tabla de referencia para implementación futura

Pensada para活在 en SQLite de la Base cuando se implemente:

| Tabla | Propósito |
|-------|-----------|
| `pcs_enlazadas` | Hijas autorizadas (id, nombre, ip, cert_hash, last_seen) |
| `sesiones_activas` | user_id, pc_id, opened_at, last_heartbeat (para sesión única) |
| `codigos_enlace` | token de un solo uso con expiración |

## Decisiones pendientes (no se toman hasta implementación)

| Decisión | Opciones | Recomendación |
|----------|----------|---------------|
| Transporte Base↔hija | HTTP local + TLS · WebSocket · Named pipe | HTTP local + TLS (más simple) |
| Persistencia de sesión activa | SQLite en Base · archivo JSON · memoria | SQLite (ya hay DB) |
| Heartbeat | 30s · 60s · 5min | 60s |
| Anti-bypass de firewall | Pin de pairing inicial · TLS mutuo | TLS mutuo con cert por hija |

## Qué NO es esto

- No es nube ni VPN externa: es red local / Intranet.
- No reemplaza el modo nube futuro (`IDataSource` → Postgres). Este diseño es
  para el escenario "varias cajas en el mismo local".
- No es una decisión de implementación tomada: son las líneas gruesas. Antes de
  codificar se decide transporte (p.ej. HTTP local + TLS, o WebSocket) y el
  store de sesiones (hoy SQLite en la Base).

## Documentos relacionados

- `MODULOS.md` — catálogo de módulos y ediciones; el rol admin/manager asigna
  módulos y accesos a los usuarios.
- `ARQUITECTURA-MODULAR.md` — arquitectura de módulos; el login por módulo.
- `FACTURACION-STRIPE.md` — política anti-sobreingeniería (en espera hasta
  cliente que lo pida).

## Estado — spike funcional implementado (2026-09-05)

✅ **Primera fase implementada y testeada** (tog-admin + tog-platform):

- **Migración 032** en tog-admin: tablas `pcs_enlazadas`, `sesiones_activas`,
  `codigos_enlace` (SQLite de la Base).
- **PC Base**: servidor HTTP local `:3002` dentro del main process
  (`src/main/services/red-server.ts`, Node `http`, cero deps). Endpoints:
  `POST /api/red/vincular` (handshake con código de enlace de un solo uso,
  expiración 5 min), `POST /api/red/rpc` (despacho genérico de canales IPC
  hacia los mismos handlers de la app), `POST /api/red/logout`.
- **Sesión única**: `src/main/services/red-session.ts` — al hacer login
  (local o vía RPC) se registra la sesión con el `par_id`; si el usuario ya
  tiene sesión en OTRO par, el login se rechaza. Al cerrar la app hija o
  desloguear, la hija avisa a la Base (`red:logout` / `before-quit`) y se
  libera la sesión.
- **PC Hija**: mismo `.exe`. `SetupPage` (primer inicio, cuando no hay
  licencia local) pide IP de la Base + código de enlace + nombre de PC.
  `ipc-handlers.ts` en modo hija registra solo los canales locales
  (app:version, i18n, crash-report, update, red:*) y reenvía el resto por
  HTTP a la Base (`src/main/services/red-client.ts`).
- **Tope de PCs**: la licencia firmada acepta `max_pcs` (1–20, default 1 =
  solo la Base). La Base rechaza vincular más PCs que `max_pcs`.
  `tog-platform` emite el campo (endpoint manual y `signLicense`).
- **UI**: Config → Sistema → Red Local (generar código, listar PCs enlazadas,
  desvincular hija). i18n ES/EN. Permiso `red_manage` (solo admin).
- **Tests**: `red-session.test.ts` (sesión única) y `red-server.test.ts`
  (vincular/rpc/logout/tope, DB en memoria) en tog-admin; `max_pcs` en
  `server.test.js` de tog-platform.

### Pendiente para fases siguientes

- 🔒 **Transporte TLS local**: ✅ **implementado (5-Sep-2026)** — la Base
  genera un cert autofirmado al primer arranque (`services/red-cert.ts` en
  tog-admin) y expone HTTPS en `:3002`; la hija ancla al cert recibido en el
  handshake inicial (sin `rejectUnauthorized: false` global).
- ❤️ **Heartbeat automático** (60s): ✅ **implementado (5-Sep-2026)** —
  `useRedHeartbeat` en la hija + endpoint de heartbeat en la Base; la sesión
  huérfana (par sin heartbeat > 5 min) se libera. La liberación al
  cerrar/desloguear sigue como best-effort adicional.
- 🖥️ **UI completa de gestión de PCs** en Config (hoy solo handshake básico).
- 📦 Topología multi-sucursal y sync entre bases (Fase 7).

> Smoke test: dos copias del `.exe` en la misma red — activar licencia en la
> primera (Base), emitir licencia con `max_pcs >= 2` (o re-emitir la de
> prueba con `max_pcs`), generar código desde Config → Sistema → Red Local,
> vincular la segunda PC. Verificar datos compartidos y que el login del
> mismo usuario en dos PCs se rechaza.