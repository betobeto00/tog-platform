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
| 3 | **Comercializador** | ✅ Parcial (`tog-admin`) | Inventario, compras, ventas, cotizaciones, caja, POS | Core |
| 4 | **Distribuidor** | 🟡 Diseño | Clientes, rutas, flotas, pedidos, remitos, despachos, listas de precio, crédito | Core + Comercializador |
| 5 | **Postventa** | 🟡 Diseño | Tickets de soporte, devoluciones, garantías, notas de crédito | Core + Comercializador |

**Leyenda**: ✅ existe · 🟡 en diseño · ⚪ no iniciado

> Cada módulo, una vez activo, **agrega pantallas, IPC handlers, permisos y (eventualmente) tablas** al Core. No reemplaza nada.

---

## 3. Modelo de licenciamiento

### 3.1 Estructura de una licencia

Una licencia es un JSON firmado RSA (la clave pública ya está embebida en `license.ts`) con esta forma:

```json
{
  "empresa": "AgroMaíz C.A.",
  "rif": "J-12345678-9",
  "issued_at": "2025-01-15",
  "expires_at": "2026-01-15",
  "modules": ["core", "comercializador", "distribuidor"],
  "max_usuarios": 5,
  "max_sucursales": 1,
  "edition": "professional",
  "signature": "base64-rsa-signature"
}
```

El **Core** siempre está implícito. Si el cliente desactiva "Comercializador", el módulo sigue instalado pero el Sidebar y los handlers se ocultan.

### 3.2 Tipos de edición

| Edición | Módulos incluidos | Target |
|---------|-------------------|--------|
| **Starter** | Core + Comercializador | Mostrador pequeño (papelería, ferretería, abasto) |
| **Professional** | Core + Comercializador + Distribuidor | Distribuidor mediano |
| **Enterprise** | Core + todos los módulos disponibles | Cadena completa (Productor → Postventa) |
| **Custom** | Módulos a elección del cliente | Casos atípicos (negociación directa) |

Las ediciones son **bundles comerciales**. Internamente, la licencia sigue siendo un array `modules`. Esto te permite:
- Vender un bundle con descuento.
- Permitir que un cliente compre módulos sueltos sin cambiar de edición.
- Hacer upsell: "estás en Professional, te faltan Productor y Procesador para tener la cadena completa".

### 3.3 Cómo se entrega una licencia nueva / activación de módulo

**Hoy (offline, manual)**: tú generas la clave firmada (script `tools/sign-license.ts` en el repo del Core) y la envías por correo/WhatsApp. Roberto la pega en `Configuración → Licencia → Cargar clave`, reinicia, módulo activo.

**Mañana (online, automático)**: Roberto paga con tarjeta vía Stripe Checkout. El webhook de Stripe llega a tu backend, el backend actualiza el estado de la empresa y le entrega la nueva clave. Detalle en `FACTURACION-STRIPE.md`.

### 3.4 Offline-first, online-cuando-puede

La licencia **siempre** es un archivo firmado local. El Core puede funcionar 100% sin internet. La conexión a tu backend solo aporta:
- Renovaciones automáticas (sin que Roberto tenga que pegar clave nueva cada año).
- Sincronización entre PCs del mismo Roberto.
- Analítica de uso para ti (qué módulos se usan, cuánto).

Si Roberto está offline 100%, el modelo degradado es: **tú le mandas la clave por WhatsApp**, él la pega, sigue funcionando. Nunca bloqueas al cliente por falta de internet.

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

### Inmediato (mes 0–2): habilitar el catálogo
- [ ] Estandarizar `window.api.modules` desde la licencia activa.
- [ ] Sidebar filtra items según módulos.
- [ ] Config → Licencia muestra catálogo de módulos disponibles (algunos en gris "No adquirido").
- [ ] Backend admin web (Vercel + Postgres) con CRUD de empresas y licencias.

### Corto plazo (mes 2–6): Distribuidor + Stripe
- [ ] Módulo Distribuidor: tabla `clientes`, `pedidos`, `remitos`, `rutas`, `listas_precio`.
- [ ] Integración Stripe Checkout + webhooks.
- [ ] Renovación automática online.

### Medio plazo (mes 6–12): Productor + Procesador
- [ ] Módulo Productor: siembras, cosechas, costos de campo.
- [ ] Módulo Procesador: recetas/BOM, mermas, transformación.
- [ ] Trazabilidad lote-origen (Lote de maíz → lote de hojuela → remito → cliente final).

### Largo plazo (mes 12+): Nube + Postventa + multi-País
- [ ] Modo nube con Postgres + autenticación central.
- [ ] Módulo Postventa.
- [ ] Multi-moneda, multi-idioma, fiscal por país.

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