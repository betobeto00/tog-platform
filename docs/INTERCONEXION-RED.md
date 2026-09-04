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

## Enlace entre PCs — dirección propuesta

La idea base: cuando se instala en la PC Base y se activa, la Base genera un
**código de enlace** (token) que el admin usa en las hijas para vincularlas.

1. **Instalar y activar en la PC Base** — normal, como hoy (licencia local).
2. **Generar código de enlace** en la Base (Config → Red): token breve, con
   expiración y de un solo uso por hija.
3. **En cada PC hija** (Primer Inicio → “Conectar a una PC Base”) el admin
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

## Qué NO es esto

- No es nube ni VPN externa: es red local / Intranet.
- No reemplaza el modo nube futuro (`IDataSource` → Postgres). Este diseño es
  para el escenario “varias cajas en el mismo local”.
- No es una decisión de implementación tomada: son las líneas gruesas. Antes de
  codificar se decide transporte (p.ej. HTTP local + TLS, o WebSocket) y el
  store de sesiones (hoy SQLite en la Base).

## Documentos relacionados

- `MODULOS.md` — catálogo de módulos y ediciones; el rol admin/manager asigna
  módulos y accesos a los usuarios.
- `ARQUITECTURA-MODULAR.md` — arquitectura de módulos; el login por módulo.
- `FACTURACION-STRIPE.md` — política anti-sobreingeniería (en espera hasta
  cliente que lo pida).