# Rendimiento móvil — Ventify POS 2.0.1

Fecha: 12 de noviembre de 2026. Android versionCode: 3.

## Cambios

La primera consulta de catálogo pide 80 documentos; después se mantiene un único listener de la cuenta completa. Se eliminó el par anterior de consulta completa + listener completo. La sincronización conserva el catálogo completo: no se impuso un límite que ocultara productos, variantes o presentaciones. El snapshot completo aún se descarga por red; el procesamiento, no la transferencia completa del listener, se divide en tareas de hasta 100 documentos.

La caché persistente usa claves por usuario, cuenta y sucursal. Guarda JSON en fragmentos de 150 productos y publica un manifiesto al terminar. Las escrituras están serializadas por clave y eliminan generaciones reemplazadas; las lecturas comprueban formato, integridad y caducidad. Se puede mostrar el primer fragmento mientras se rehidrata el resto. El primer snapshot confirmado por el servidor reconcilia el catálogo, incluyendo productos borrados mientras la app estaba cerrada. Un snapshot parcial de la caché de Firestore no se presenta como catálogo completo.

Los índices de códigos, categorías, existencias, valuación y alertas se actualizan por documento modificado. Los metadatos de búsqueda se precalientan dentro de los lotes y se reutilizan por referencia de producto. Las pantallas no reconstruyen esos metadatos al escribir; la búsqueda de POS, inventario y transferencias espera 150 ms sin nuevas teclas. Se conservó FlashList y se eliminaron recorridos repetidos por categoría. La lista previa permanece visible durante la sincronización; los indicadores de carga, errores y reintento son locales. Los KPI y conteos parciales no se muestran como resultados definitivos.

Las fuentes de identidad independientes se leen en paralelo y se comparte la resolución simultánea de un mismo usuario. La lectura forzada de claims y las comprobaciones de acceso se conservan. Cada ajuste del negocio usa un listener para el valor inicial y los cambios, eliminando sus consultas iniciales duplicadas. La configuración de cobro está aislada por usuario/cuenta: confirmar una venta o entrega espera los medios de pago y comprobantes, sin bloquear la navegación ni las cotizaciones. Los datos del negocio expuestos pertenecen a la cuenta actual.

## Verificación

- TypeScript correcto.
- Suite móvil: 160 pruebas correctas en 26 archivos.
- Compilación Android release correcta: 1 minuto 37 segundos.
- Firma APK v2 verificada; paquete `pe.com.ventify.pos`, versión 2.0.1/build 3.
- Revisión independiente de scope, caché, primer snapshot, cambios y borrados sin hallazgos P1 pendientes.
- Se preservaron los cambios de paridad existentes. No se modificó ni desplegó el backend durante este trabajo.

## Medición reproducible

Ejecutar `npm test -- src/lib/__tests__/catalog-performance.test.ts src/lib/__tests__/catalog-filters.measure.test.ts --maxWorkers=1`.

Se hicieron tres corridas después de terminar la compilación, con fixtures de 1.500, 8.000 y 20.000 productos. El benchmark usa los índices reales de códigos, inventario y categorías, junto con el precalentamiento de búsqueda. Con 20.000 productos, el mayor bloque síncrono medido pasó de 135,58–156,93 ms a 4,54–6,48 ms. La espera de una tarea del event loop pasó de 153,25–173,66 ms a 17,77–19,24 ms. Una actualización aislada de stock pasó de 106,51–154,14 ms a 0,16–0,18 ms en esta fixture.

El trabajo total del benchmark de carga aumenta al ceder el hilo entre lotes: 153,11–173,54 ms antes, 526,71–537,11 ms después. Se acepta este coste para reducir pausas largas y permitir interacción; no representa una descarga de red más rápida. La caché y el lote inicial permiten mostrar productos antes de terminar toda la sincronización.

Estas cifras son sintéticas en Node. No incluyen red de Firestore, costes internos del SDK, render completo de React Native, parseo del bundle ni dispositivo físico. No se afirma un tiempo de apertura en teléfonos: no había un dispositivo Android conectado ni un AVD configurado. Las pruebas no contienen umbrales de tiempo frágiles.

## Uso y límites

La primera sincronización satisfactoria crea la caché completa. Las aperturas posteriores pueden mostrar esos datos mientras se actualizan. La consulta de stock/permisos al confirmar operaciones sigue usando los flujos transaccionales existentes; la caché de productos no concede acceso ni cambia las validaciones.

Mientras no haya primera confirmación del servidor, un código desconocido mantiene el fallback remoto para no ocultar productos nuevos que no estén en la caché. Ese fallback puede consultar el catálogo completo para códigos anidados de variantes/presentaciones; no se eliminó a costa de perder compatibilidad. Tras confirmar el catálogo completo se usa el índice local.

Los cambios siguen locales, sin commit ni push en esta tarea. Se conserva el APK anterior y se genera un artefacto distinto para esta versión.

APK: `releases/ventify-performance-2.0.1-2026-11-12.apk`.
SHA-256: `3a0f436262fed48e5c74c02bc69b393731f4e65dfcd2910c0dec0e04e36b1204`.
