# Misión y Visión — Ecosistema OmniMargen

> Fuente de verdad de la identidad del ecosistema. Todo texto público (landing,
> docs, manuales) debe reflejar esta visión: **un ecosistema modular** que
> acompaña al negocio desde la producción hasta la postventa, no un software
> vertical para un solo rubro.

---

## Misión

Impulsar a las empresas de todos los tamaños y sectores con un ecosistema de
software modular que se adapta a la operación real de cada negocio — desde la
producción hasta la postventa — para que cada cliente arme su propio sistema
con los módulos que necesita, sin pagar por lo que no usa y sin reescribir
nada cuando crece.

## Visión

Un solo producto instalable, infinitas configuraciones. Que cualquier empresa
descargue la aplicación, active solo los módulos que necesita hoy y sume más
a medida que su operación crece, cubriendo toda la cadena:

```
Productor → Procesador → Comercializador → Distribuidor → Postventa
                                        └─ Cliente final
```

La licencia activa módulos (no features sueltas): el cliente elige qué parte
de la cadena cubrir y lo cambia sin reinstalar ni migrar.

## Cómo se materializa

- **Un solo instalador** para todos los módulos; la licencia (firmada RSA,
  offline-first) activa los que corresponden.
- **Módulos como piezas intercambiables**: Productor, Procesador,
  Comercializador, Distribuidor, Postventa. El cliente combina los que
  necesita.
- **Identidad internacional**: país (ISO 3166-1) + documento de registro libre.
- **Sin dependencia de la nube por defecto**: los datos viven en la PC del
  cliente; la nube es una opción futura mediante `IDataSource`, no un requisito.

## Qué NO es el ecosistema

- No es un POS solo para papelerías, copiados o imprentas. El punto de venta
  es el **módulo Comercializador**, que sirve a cualquier negocio de mostrador.
- No es una colección de apps separadas: es un solo producto configurable.
- No es infraestructura especulativa: cada módulo se construye cuando hay un
  cliente que lo necesita (ver `MODULOS.md` y `FACTURACION-STRIPE.md`).