# Ventify POS Mobile v2.0 — App Nativa Android & iOS

Aplicación móvil **100% nativa** para **Android** e **iOS** del ecosistema **Ventify SaaS POS**, construida con **React Native 0.76 + Expo SDK 52 (New Architecture: Fabric + TurboModules/JSI + Hermes)** y sincronizada a nivel transaccional con el núcleo de [`ventify`](file:///home/arcay/ventify).

---

## Arquitectura Nativa y Rendimiento

A diferencia de la versión preliminar v1.0 basada en WebView/Capacitor (archivada en `legacy/capacitor-v1/` y en la rama `legacy-capacitor-v1`), **Ventify Mobile v2.0** ejecuta vistas nativas reales (`android.view.View` y `UIView`) compiladas a bytecode AOT con **Hermes**:

- **Renderizado Nativo (New Architecture / Fabric)**: Cero WebView, transiciones a 60/120 FPS y listas recicladas de alto rendimiento con `@shopify/flash-list` para catálogos de +10,000 SKUs en dispositivos de gama media/baja.
- **Escáner de Cámara por Hardware (`expo-camera` / `CameraView`)**: Detección nativa de códigos `EAN-13`, `EAN-8`, `Code-128`, `UPC-A`, `QR`, con control de linterna (`torch`), modo continuo y vibración háptica (`expo-haptics`).
- **Integridad Contable 100% Compatible con Ventify Web**:
  - Transacciones atómicas en Firestore (`runTransaction`) en [`src/services/sale-service.ts`](file:///home/arcay/.gemini/antigravity/scratch/ventify-mobile/src/services/sale-service.ts).
  - Registro oficial de movimientos de caja en **`cash_register_movements`** y actualización de **`cash_register_sessions/active_${branchId}`** para cuadre exacto en el **Cierre Z** tanto en web como en móvil.
  - Trazabilidad completa de inventario en el **Kardex (`inventory_movements`)** con `previousStock`, `newStock`, factor de conversión de presentaciones y motivo.
  - Soporte completo para **Presentaciones** (Unidad, Pack, Caja), **Variantes** (Talla/Color), **Precios por Sucursal**, **Piso de Precio (`minSalePrice`)** y **Venta por Peso / Fracción (kg, g, lt)**.
- **Resiliencia Offline (`src/services/offline-sync-service.ts`)**:
  - Cola persistente local con `offlineId` idempotente, detección automática de red con `@react-native-community/netinfo`, deduplicación y bandeja de cuarentena ante conflictos.
- **Impresión Térmica Bluetooth (ESC/POS 58mm / 80mm) y Tickets PDF**:
  - Constructor binario ESC/POS ([`src/lib/printing/escpos-builder.ts`](file:///home/arcay/.gemini/antigravity/scratch/ventify-mobile/src/lib/printing/escpos-builder.ts)) con soporte de 58mm y 80mm, corte automático de papel (`GS V`), apertura de gaveta de dinero (`ESC p`) y QR tributario SUNAT.
  - Impresión PDF nativa y envío directo de comprobantes por **WhatsApp** mediante `expo-print` y `expo-sharing`.

---

## Módulos Incluidos

1. **Punto de Venta (POS) — `app/(tabs)/index.tsx` & `src/components/CheckoutModal.tsx`**:
   - Escáner nativo embebido y en pantalla completa.
   - Búsqueda O(1) por código de barras principal, códigos alternativos, SKU, presentaciones y variantes.
   - Modal de **Venta por Peso** (con cálculo inverso por importe en Soles) y **Venta Rápida** (concepto libre).
   - **Ventas en Pausa (Hold Carts)** persistentes.
   - **Gestor de Cotizaciones (`QuotesManagerModal.tsx`)**: Conversión directa de cotización al carrito POS en 1 toque y envío de proforma PDF por WhatsApp.
   - **Modo Pistola Lectora Inalámbrica para PC (`CompanionScannerModal.tsx`)**: Vinculación por QR con Ventify Web para transmitir códigos de barras en milisegundos al mostrador PC.
   - **Checkout Completo**: Nota de Venta, Boleta Electrónica SUNAT (`03`), Factura Electrónica SUNAT (`01`) y Cotización.
   - Consulta en vivo de **DNI (RENIEC)** y **RUC (SUNAT)** con validación oficial módulo 11.
   - Cobro en **Efectivo** (atajos de billetes S/ 10, 20, 50, 100, 200), **Yape**, **Plin**, **Tarjeta**, **Transferencia**, **Pago Mixto (Split Payment)** y **Fiado (Crédito)**.
2. **Inventario, Kardex, Transferencias y Abastecimiento — `app/(tabs)/catalog.tsx`**:
   - KPIs de inventario en tiempo real por sucursal.
   - Creación/edición de productos con generador automático de código de barras peruano (`775...`), presentaciones y cálculo de margen.
   - Ajuste rápido de stock con motivo auditado en el **Kardex (`inventory_movements`)**.
   - **Transferencias de Mercadería entre Sucursales** (`transfers`).
   - **Proveedores y Órdenes de Compra (`SuppliersPurchaseModal.tsx`)**: Directorio de proveedores con autocompletado RUC SUNAT, creación de órdenes de compra (`purchase_orders`) y recepción atómica de mercadería con recálculo de **Costo Promedio Ponderado (`costPrice`)** y Kardex.
3. **Centro de Operaciones (Caja Z, Clientes/Fiados, Reservas y Personal) — `app/(tabs)/operations.tsx`**:
   - **Control de Caja y Cierre Z**: Apertura de turno, registro de ingresos/egresos de caja chica, arqueo en vivo y Cierre Z con impresión térmica.
   - **Clientes y Fiados (CRM)**: Directorio de clientes, control de línea de crédito, alertas de deuda y registro de abonos parciales/totales (`fiado_payments`).
   - **Pedidos y Reservas**: Separación de stock (`reservedStock`), control de anticipos y entrega/liberación.
   - **Equipo, Planillas y Solicitudes de Venta (`PayrollUsersModal.tsx`)**: Gestión de usuarios/roles, registro de sueldos/adelantos/comisiones (`payroll_movements`) con descuento en caja abierta y bandeja de aprobación de solicitudes de venta (`sale_requests`).
4. **Historial, Facturación SUNAT, Estado de Resultados (P&L) y Venty IA — `app/(tabs)/history.tsx`**:
   - Reportes financieros (Ventas totales, Ganancia estimada, Ticket promedio, Efectivo vs Digital).
   - **Estado de Resultados Ejecutivo P&L (`FinancialPnlModal.tsx`)**: Cascada contable completa (Ingresos Netos, Costo de Mercadería Vendida COGS, Utilidad Bruta, Gastos Operativos + Planillas, Utilidad Neta Real), ranking de productos más rentables, rendimiento por vendedor y exportación a PDF.
   - Reimpresión térmica Bluetooth, envío de ticket PDF por WhatsApp y **Anulación / Devolución de Venta** con reversión atómica de stock y Kardex.
   - **Asistente Venty IA**: Consultas ejecutivas en lenguaje natural sobre el estado del negocio en tiempo real.
5. **Ajustes de Terminal y Seguridad — `app/(tabs)/settings.tsx`**:
   - Configuración de impresora térmica Bluetooth (58mm/80mm), monitor de cola offline, cambio de sucursal activa, datos de empresa/Yape/Plin y **Bloqueo Rápido por PIN de 4 dígitos** (`expo-secure-store`).

---

## Comandos de Desarrollo y Compilación Nativa

```bash
# 1. Instalar dependencias
npm install --legacy-peer-deps

# 2. Iniciar servidor de desarrollo Metro (Expo)
npm start

# 3. Compilar y ejecutar binario nativo en Android
npm run android

# 4. Compilar y ejecutar binario nativo en iOS (requiere macOS + Xcode)
npm run ios

# 5. Verificar tipos TypeScript
npm run typecheck

# 6. Ejecutar suite de pruebas unitarias y de lógica de negocio
npm test
```
