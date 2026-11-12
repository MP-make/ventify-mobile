# Corrección de paridad móvil/web

Referencia inicial: móvil f70b230, web 7b7fea50 con cambios locales conservados.

## Contrato de aceptación

Cada operación debe tomar la misma decisión de permisos y producir cambios equivalentes en ventas, stock físico/reservado/variante, deuda, depósitos y sesión. Las diferencias de presentación o hardware no modifican ese contrato. No se ejecutan operaciones contra datos reales durante la verificación.

## Trabajo por área

- [x] Ventas/caja: SALE-01/02, CASH-01/02/03/04, crédito/prepago y devolución parcial.
- [x] Inventario: INV-01/02/03/04, CAT-01, CACHE-01 y recepción web idempotente.
- [x] CRM/reportes: CRM-01/02/03/04, REP-01/02, REQ-01 y nómina.
- [x] Acceso: AUTH-01/02/03, aislamiento del estado local por cuenta y búsqueda POS remota.
- [x] Integración: contratos entre agentes, pruebas de regresión y revisión independiente.
- [x] Verificación: tipos, suite móvil, verificaciones web aplicables y compilación Android.

## Documentos existentes

La aplicación debe poder leer formatos históricos mediante normalización explícita. No se ejecutará una migración masiva ni una reparación irreversible de datos del negocio sin un inventario y un resultado revisable. Los campos omitidos en una edición parcial se conservan.

## Registro de validación

Resultado final del código integrado (12 de noviembre de 2026):

- Móvil: TypeScript correcto; 141 pruebas correctas en 21 archivos.
- Web: lint y TypeScript correctos; 1.851 pruebas correctas y 10 omitidas en 199 archivos (198 correctos, uno omitido).
- Smoke web con proyecto emulado `demo-ventify-pos`: 33 pruebas de reglas/integración y 7 de finalización correctas.
- Compilación web de producción correcta. Compilación Android correcta (`assembleRelease`, 57 segundos).
- Revisiones independientes GPT-6 Luna: inventario, CRM, ventas/caja, métodos de pago y contratos de servidor. Se corrigieron los hallazgos reproducibles con pruebas de regresión.

La verificación usa fixtures y emuladores. No demuestra por sí sola paridad en una instalación desplegada: los cambios de servidor deben publicarse junto con el cliente que los utiliza.

## Casos adicionales encontrados durante la revisión

- Las líneas de un mismo producto con distintas variantes o presentaciones se agregan antes de modificar existencias; no pueden sobrescribir las otras líneas.
- La cancelación consulta el documento actual, libera una sola vez y conserva el inventario de otras reservas. Reconoce pedidos históricos móviles que apartaban stock al crearse.
- Las presentaciones antiguas con `factor` se normalizan a `conversionFactor`; las reservas conservan el ID real del producto y sus selecciones.
- Editar nombre/precio conserva todas las tallas y los atributos de catálogo ocultos.
- La sesión local se limpia al cambiar de usuario y el portal de vendedor vuelve a consultar sus datos al cambiar de cuenta.
- Las solicitudes y cotizaciones deben convertirse con el ID de una venta confirmada. Cargar un carrito no equivale a registrar una venta.

## Integración del servidor

Además del cliente móvil, el árbol web contiene correcciones en finalización/devolución de ventas, solicitudes canónicas y recepción atómica de transferencias. El APK debe utilizar ese servidor actualizado. No se publicó un despliegue ni se modificaron registros del negocio durante este trabajo.

Los cambios web preexistentes del usuario se conservaron. Antes de intervenir se guardó una copia en `/tmp/ventify-parity-web-before`; únicamente se ajustó deliberadamente el manejador de recepción de transferencias entre esos archivos preexistentes.


## Revisión del 12 de noviembre de 2026

- Métodos de pago: el DTO conserva el identificador/nombre configurado; pagos mixtos usan los IDs reales de cada parte. Las colas históricas normalizan los alias cash/card/digital antes de llamar al servidor.
- Comisiones y recargos: cálculo por método y por parte con el mismo redondeo de la web; el selector muestra el importe real a cobrar. El efectivo entregado y su vuelto se conservan separados del importe cobrado.
- Cancelación con devolución previa: se bloquea la anulación completa para evitar reponer dos veces el stock o el dinero; el historial permite devolver las líneas restantes según la disponibilidad de la función web.
- Créditos: se distingue saldo prepagado de deuda mediante creditMode; la anulación revierte solo la parte a crédito y cancela el saldo pendiente de su cuenta por cobrar vinculada.
- Devolución del servidor: restaura existencias y variantes en stockBranchId, agrupa el Kardex por producto y sucursal y deduplica los índices al repetir la operación.
- Reservas/pedidos: cancelación con adelanto retenido o devolución por porcentaje/método, en una transacción con liberación de stock y actualización del depósito/caja. Los pedidos históricos sin documento de depósito disponen de devolución manual equivalente.
- Permisos de historial: la anulación directa se muestra a administradores/propietarios, conforme a las reglas de escritura; la devolución por servidor respeta el mismo indicador de función y los permisos de la web.

### Entrega y límites de verificación

- Web: lint y typecheck correctos; 1.851 pruebas correctas y 10 omitidas; smoke emulado: 33 pruebas de reglas y 7 de finalización correctas. Compilación de producción correcta.
- Móvil: 141 pruebas correctas y comprobación de tipos correcta. APK compilado: `releases/ventify-parity-2026-11-12.apk`.
- No hay dispositivo Android conectado para una validación manual instalada. Las pruebas automáticas no reemplazan la comprobación de flujos con una cuenta de prueba en el servidor actualizado.
- Estos cambios están locales; no se publicó un servidor ni se subieron estos cambios a los repositorios durante esta corrección. El APK depende de publicar también las correcciones web de API/servicios.


## Trazabilidad del alcance auditado

- SALE-01/02: lectura antes de escritura, agrupación de líneas y DTO de venta con vendedor/selecciones/impuestos.
- INV-01/02/03/04: edición parcial conservadora, ciclo de transferencias y sucursal real en compras.
- CRM-01/02/03/04: deuda vinculada, stock reservado en el momento correspondiente, documentos históricos, entrega y depósitos por categoría.
- REP-01/02: reporte canónico del servidor e historial paginado con filtros previos a la consulta.
- AUTH-01/02/03: cuentas/planes activos, revocación en vivo y portal específico de vendedores.
- CAT-01 y CACHE-01: catálogo completo, búsqueda remota al escanear y caché/carrito por identidad/cuenta/sucursal.
- CASH-01/02/03/04: sesión original offline, devolución parcial con servidor, cierre que detecta modificaciones y montos cobrados separados del dinero entregado.
- REQ-01: solicitudes canónicas y conversión confirmada, equivalente a la web.
- WEB-01: recepción de transferencias atómica con stock, estado y Kardex en la misma transacción.

El arqueo distingue adelantos de venta comercial y conserva los medios físicos al cambiar el método de devolución. Una consulta fallida de movimientos impide cerrar la caja con datos incompletos. No hay migración automática masiva de documentos históricos.

APK de prueba: `ventify-parity-2026-11-12.apk` (30978839 bytes). SHA-256: `bccd3afd57f15b717d58f4f7186dedca71694ac58433921dfa65c52955d47db3`. Firma APK v2 e integridad del paquete verificadas.
