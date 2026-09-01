# TOG Platform — Arquitectura Modular

> Documento técnico. Define cómo el Core carga módulos activados por licencia, cómo se comunican los módulos entre sí, cómo el Sidebar/Route/IPC reaccionan, y qué cambios concretos requiere el código actual de TOG Admin.

---

## 1. Principios de diseño

1. **El Core es obligatorio y nunca se desactiva.** Los módulos son **aditivos**.
2. **Un módulo = un paquete de capacidades**: rutas, páginas, IPC handlers, permisos, (eventualmente) migraciones de DB, seeds.
3. **El Core expone un `ModuleAPI` estable.** Los módulos consumen ese API. Los módulos no se importan entre sí directamente; se hablan vía `events`.
4. **La licencia decide qué se monta.** Si un módulo no está activo, su código no se carga, sus rutas no existen, sus handlers no responden.
5. **Sin acoplamiento al transporte.** Un módulo no sabe si está respondiendo a IPC, REST, WebSocket o un test. Solo expone funciones puras.

---

## 2. Estructura de carpetas propuesta

```
tog-admin/
├── src/
│   ├── main/
│   │   ├── core/                       # Antes: src/main/
│   │   │   ├── index.ts
│   │   │   ├── preload.ts
│   │   │   ├── ipc-handlers.ts         # Solo handlers de Core
│   │   │   ├── db/
│   │   │   ├── services/               # license, auth, updater
│   │   │   └── modules/                # NUEVO: módulo loader
│   │   │       ├── loader.ts
│   │   │       ├── registry.ts
│   │   │       └── module-api.ts
│   │   └── modules/                    # NUEVO: módulos activables
│   │       ├── comercializador/
│   │       │   ├── index.ts            # entry: registra capabilities
│   │       │   ├── handlers.ts         # IPC handlers propios
│   │       │   ├── service.ts          # lógica de dominio pura
│   │       │   ├── routes.ts           # rutas React
│   │       │   ├── pages/
│   │       │   └── permissions.ts      # permisos específicos del módulo
│   │       ├── distribuidor/
│   │       │   └── ...
│   │       └── ...
│   ├── renderer/
│   │   ├── core/
│   │   │   ├── App.tsx
│   │   │   ├── routes.ts               # rutas de Core
│   │   │   ├── components/
│   │   │   ├── stores/
│   │   │   └── pages/
│   │   └── modules/                    # NUEVO: espejado de main/modules
│   │       └── comercializador/
│   │           └── pages/POSPage.tsx
│   └── shared/
│       ├── module-api.ts               # contrato compartido main↔renderer
│       └── modules.ts                  # tipos: ModuleManifest, ModuleId, etc.
└── ...
```

> Los módulos **viven dentro del mismo repo** mientras sean pocos. Cuando un módulo sea vendible de forma independiente (terceros, otros productos), se extrae a su propio paquete npm y se importa desde el Core.

---

## 3. El `ModuleManifest`

Cada módulo declara un manifiesto. Es **el único contrato** entre el Core y el módulo.

```ts
// src/shared/modules.ts

export type ModuleId = 'comercializador' | 'distribuidor' | 'productor' | 'procesador' | 'postventa'

export interface ModuleManifest {
  id: ModuleId
  name: string                   // 'Comercializador'
  version: string                // semver del módulo
  description: string

  /** Qué módulo del Core se necesita para que este funcione */
  requires: ModuleId[]           // ej: ['comercializador']

  /** Permisos que este módulo registra (se suman al catálogo de permisos) */
  permissions: PermissionDef[]

  /** IPC handlers que registra (canal + handler) */
  ipcChannels: { channel: string; handler: IpcHandler }[]

  /** Rutas de React que registra */
  routes: { path: string; element: ReactNode; requires: PermissionKey[] }[]

  /** Items que aparecen en el Sidebar */
  sidebar: { labelKey: string; path: string; icon: string; requires: PermissionKey[] }[]

  /** Migraciones SQL que aporta (se aplican si el módulo se activa por primera vez) */
  migrations: string[]           // ej: ['003_distribuidor_clientes.sql']

  /** Hook de inicialización (ej: registrar tablas en memoria) */
  onInit?(ctx: ModuleContext): Promise<void>

  /** Hook de destrucción (al desactivar) */
  onDestroy?(ctx: ModuleContext): Promise<void>
}
```

---

## 4. El `ModuleContext` (lo que el Core le da al módulo)

```ts
// src/main/modules/module-api.ts

export interface ModuleContext {
  /** Acceso tipado a la base de datos (Drizzle, repo o SQL crudo según fase) */
  db: IDataSource

  /** Sistema de eventos pub/sub entre módulos */
  events: EventBus

  /** Logger estructurado con prefijo del módulo */
  log: Logger

  /** Configuración leída de la licencia activa */
  license: ActiveLicense

  /** API para registrar IPC handlers propios del módulo */
  registerIpc(channel: string, handler: IpcHandler): void

  /** API para registrar rutas en el renderer */
  registerRoute(route: ModuleRoute): void

  /** API para registrar items en el Sidebar */
  registerSidebarItem(item: SidebarItem): void

  /** API para leer/escribir configuración por módulo */
  config: ModuleConfigStorage

  /** Hooks del ciclo de vida del Core */
  hooks: {
    onAppReady: HookFn
    onLicenseChange: HookFn
    onShutdown: HookFn
  }
}
```

---

## 5. El `ModuleLoader`

```ts
// src/main/modules/loader.ts (esqueleto)

export async function loadActiveModules(license: ActiveLicense): Promise<LoadedModule[]> {
  const registry = await getModuleRegistry()
  const loaded: LoadedModule[] = []

  for (const moduleId of license.modules) {
    const manifest = registry.get(moduleId)
    if (!manifest) {
      log.warn(`[Modules] Módulo '${moduleId}' no encontrado en registry`)
      continue
    }

    // Validar dependencias
    for (const dep of manifest.requires) {
      if (!license.modules.includes(dep)) {
        throw new Error(`Módulo '${moduleId}' requiere '${dep}' no activo`)
      }
    }

    const ctx = createModuleContext(moduleId)
    await manifest.onInit?.(ctx)
    loaded.push({ manifest, ctx })
    log.info(`[Modules] ${moduleId} v${manifest.version} cargado`)
  }

  return loaded
}
```

El loader se llama **una sola vez al arranque**, después de validar la licencia.

---

## 6. Cómo reacciona el Sidebar y el Router

```tsx
// src/renderer/core/App.tsx (esqueleto)

function App() {
  const activeModules = useActiveModules()  // lee de window.api.modules

  return (
    <HashRouter>
      <Routes>
        {/* Rutas del Core, siempre presentes */}
        <Route path="/" element={<DashboardPage />} />
        <Route path="/config" element={<ConfigPage />} />

        {/* Rutas inyectadas por módulos activos */}
        {activeModules.flatMap(m =>
          m.manifest.routes.map(r => (
            <Route key={`${m.id}:${r.path}`} path={r.path} element={r.element} />
          ))
        )}
      </Routes>
    </HashRouter>
  )
}
```

El Sidebar lee el mismo `activeModules` y filtra items por permisos.

---

## 7. Permisos por módulo

El catálogo de permisos ya existe (`src/shared/permissions.ts`, 28 permisos en 7 categorías). El cambio: cada **módulo declara los suyos** y el Core los agrega al catálogo al activarlo.

```ts
// Ejemplo: módulo Distribuidor
export const permissions: PermissionDef[] = [
  { key: 'distribuidor.clientes.view',  category: 'distribuidor', name: 'Ver clientes' },
  { key: 'distribuidor.clientes.edit',  category: 'distribuidor', name: 'Editar clientes' },
  { key: 'distribuidor.pedidos.create', category: 'distribuidor', name: 'Crear pedidos' },
  { key: 'distribuidor.rutas.manage',   category: 'distribuidor', name: 'Gestionar rutas' },
  ...
]
```

**Bug crítico a corregir en el camino**: hoy `permissions.ts` está en el backend pero **no se invoca** en los IPC handlers. Cualquier cliente IPC bypasea permisos. Mientras esto siga así, modularizar permisos no tiene sentido.

Acción inmediata: hacer que `requirePermission('key')` envuelva cada handler de venta/caja/productos, y que cada módulo lo haga con sus propias keys.

---

## 8. Datos: el problema de las migraciones por módulo

Cada módulo puede necesitar sus propias tablas (`distribuidor_clientes`, `distribuidor_pedidos`, etc.). Opciones:

| Opción | Pro | Contra |
|--------|-----|--------|
| **A. Cada módulo trae sus migraciones** y el runner las aplica al activarlo | Limpio, módulo autocontenido | Si dos módulos modifican la misma tabla, caos |
| **B. Todas las migraciones viven en el Core** y se aplican siempre; los módulos solo "leen" tablas que ya existen | Simple, sin coordinación | Tablas vacías ocupan espacio; un módulo inactivo tiene su esquema en DB |
| **C. Híbrido**: Core tiene las tablas comunes (`clientes`, `productos`, `ventas`); módulos específicos añaden las suyas | Balance | Sigue requiriendo coordinación para extensiones |

**Recomendación**: Opción **B para v1**, pasar a **C** cuando haya 3+ módulos con tablas propias.

Mientras tanto, las "tablas de Distribuidor" (`clientes`, `pedidos`, `remitos`) **se crean siempre** en la migración inicial. Solo se **consultan** desde el módulo Distribuidor.

---

## 9. Eventos entre módulos (acoplamiento débil)

Los módulos **no se importan entre sí**. Si Comercializador necesita reaccionar a "se creó un pedido" de Distribuidor, lo hace vía un event bus.

```ts
// main/modules/module-api.ts
export interface EventBus {
  emit(event: DomainEvent): Promise<void>
  on<T>(eventType: string, handler: (payload: T) => Promise<void>): void
}

// Ejemplo: Distribuidor emite, Comercializador escucha
// Distribuidor:
events.emit({ type: 'distribuidor.pedido.creado', payload: { pedidoId, clienteId, items } })

// Comercializador (en su onInit):
events.on('distribuidor.pedido.creado', async ({ pedidoId }) => {
  await comercializadorService.reservarStock(pedidoId)
})
```

Eventos típicos:
- `distribuidor.pedido.creado` → Comercializador descuenta stock
- `comercializador.venta.creada` → Postventa abre ticket
- `productor.cosecha.registrada` → Procesador crea lote de materia prima

---

## 10. Plan de migración del código actual

### Fase 1 (corto plazo): sentar las bases
1. Mover `src/main/ipc-handlers.ts` (1578 líneas) a `src/main/core/ipc-handlers.ts` y partirlo por dominio:
   - `core/ipc-handlers/auth.ts`
   - `core/ipc-handlers/config.ts`
   - `core/ipc-handlers/license.ts`
2. Crear `src/main/core/modules/` con `loader.ts`, `module-api.ts`, `registry.ts`.
3. Definir `ModuleManifest`, `ModuleContext`, `EventBus` en `src/shared/modules.ts`.
4. **Conectar `requirePermission` a TODOS los handlers actuales** (bug crítico de seguridad).
5. Exponer `window.api.modules = { comercializador: true, ... }` desde el preload.
6. Hacer que `App.tsx` y `Sidebar` lean de `window.api.modules`.

### Fase 2: convertir Comercializador en módulo
1. Mover páginas POS, Inventario, Compras, Ventas, Caja, Cotizaciones, Reportes a `src/renderer/modules/comercializador/pages/`.
2. Mover sus handlers IPC a `src/main/modules/comercializador/handlers.ts`.
3. Crear `src/main/modules/comercializador/service.ts` (lógica pura extraída de los handlers).
4. Crear `src/main/modules/comercializador/manifest.ts` con sus permisos.
6. Smoke test: app arranca, todo funciona igual que antes.

### Fase 3: añadir Distribuidor
1. Diseñar tablas `clientes`, `pedidos`, `remitos`, `rutas_distribucion` (ya plan en INFORME-ERP).
2. Crear `src/main/modules/distribuidor/` con su manifest, handlers, service, pages.
3. La licencia activa Distribuidor → Roberto ve nuevas opciones en Sidebar.

### Fase 4+: Productor, Procesador, Postventa
Siguiendo el mismo patrón.

---

## 11. Dualidad Instalador / Nube

Cuando llegue el momento de ofrecer la versión nube, el cambio es **mínimo** si la arquitectura modular está bien hecha:

```ts
// Hoy: el Core arranca localmente
// Mañana: el Core arranca apuntando a un backend tuyo

interface IDataSource {
  query<T>(sql: string, params?: any[]): Promise<T[]>
  execute(sql: string, params?: any[]): Promise<void>
  transaction(fn: () => Promise<void>): Promise<void>
}

// src/main/core/db/sqlite-source.ts       ← hoy
// src/main/core/db/postgres-source.ts     ← mañana

const dataSource = process.env.TOG_MODE === 'cloud'
  ? new PostgresDataSource(env.DATABASE_URL)
  : new SqliteDataSource(userDataPath)
```

El resto del código (servicios de módulos, handlers IPC, UI) **no sabe** cuál usa. Solo el `IDataSource` cambia.

Para el caso nube:
- Los módulos exponen su `service` (lógica pura) que el backend monta como rutas REST/GraphQL.
- La UI nube es el mismo React, apuntando a esas rutas.
- La licencia se valida online contra el mismo backend que emite las claves.

---

## 12. Resumen ejecutivo

| Decisión | Estado | Detalle |
|----------|--------|---------|
| Un solo `.exe` con todos los módulos | ✅ Diseñado | Activación por licencia, no por instalador |
| Activación por licencia firmada | ✅ Diseñado | RSA + JSON, offline-first |
| Sync online con backend propio | 🟡 Diseño | Vercel + Postgres + Stripe (ver FACTURACION-STRIPE) |
| Módulos como paquetes dentro del repo | 🟡 Diseño | Extraer a npm propio solo cuando haya 3º party |
| Tablas comunes siempre creadas | 🟡 Decidido (v1) | Migrar a "tablas del módulo" si crece |
| Comunicación entre módulos vía eventos | 🟡 Diseñado | Event bus en `ModuleContext` |
| Modo nube = mismo código, `IDataSource` distinto | 🟡 Diseñado | Sin reescritura cuando se active |
| **Bug crítico a corregir YA** | 🔴 Pendiente | `requirePermission` debe envolver TODOS los IPC handlers |

---

## 13. Documentos relacionados

- `MODULOS.md` — visión de producto, catálogo, pricing, roadmap por módulo.
- `FACTURACION-STRIPE.md` — sincronización licencia↔pago.
- `INFORME-ERP.md` — auditoría técnica del estado actual.
- `auto-license-stripe.md` — borrador original del flujo Stripe.