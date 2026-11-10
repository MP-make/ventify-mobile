/**
 * Ventify Mobile - Services Index
 * 
 * Punto de entrada unificado para todos los servicios transaccionales,
 * de hardware y de negocio de Ventify Mobile (Expo SDK 52).
 */

export * from './sale-service';
export * from './offline-sync-service';
export * from './cash-register-service';
export * from './inventory-kardex-service';
export * from './crm-operations-service';
export * from './thermal-printer-service';
export * from './notification-service';
export {
  parseScannerQrCode,
  connectScannerSession,
  sendScannedCodeToDesktop,
  subscribeToScannerSession,
  disconnectScannerSession,
} from './companion-scanner-service';
export {
  getSuppliers,
  saveSupplier,
  deleteSupplier,
  getPurchaseOrders,
  createPurchaseOrder,
  receivePurchaseOrder,
} from './suppliers-po-service';
export * from './enterprise-ops-service';
export {
  generatePnlReport,
  exportPnlReportPDF,
} from './pnl-report-service';
