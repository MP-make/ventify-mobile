import { registerPlugin, Capacitor } from '@capacitor/core';

export interface BluetoothPrinterDevice {
  name: string;
  address: string;
}

interface ThermalPrinterPluginInterface {
  getPairedPrinters(): Promise<{ enabled: boolean; devices: BluetoothPrinterDevice[] }>;
  printRaw(options: { address: string; base64Data: string }): Promise<{ success: boolean }>;
}

const NativeThermalPrinter = registerPlugin<ThermalPrinterPluginInterface>('ThermalPrinter');

export const isNativePrinterAvailable = (): boolean => {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
};

/**
 * Convierte un Uint8Array a cadena Base64
 */
export const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

/**
 * Obtiene la lista de impresoras térmicas Bluetooth vinculadas en Android
 */
export const getPairedThermalPrinters = async (): Promise<{
  enabled: boolean;
  devices: BluetoothPrinterDevice[];
}> => {
  if (!isNativePrinterAvailable()) {
    return { enabled: false, devices: [] };
  }
  try {
    const res = await NativeThermalPrinter.getPairedPrinters();
    return res;
  } catch (err: any) {
    console.error('[ThermalPrinterService] getPairedPrinters error:', err);
    throw err;
  }
};

/**
 * Envía un buffer binario ESC/POS directamente a la impresora seleccionada por Bluetooth SPP
 */
export const printThermalRaw = async (
  printerAddress: string,
  bytes: Uint8Array
): Promise<boolean> => {
  if (!isNativePrinterAvailable()) {
    console.warn('[ThermalPrinterService] printThermalRaw no disponible en entorno web');
    return false;
  }

  const base64Data = uint8ArrayToBase64(bytes);
  try {
    const res = await NativeThermalPrinter.printRaw({
      address: printerAddress,
      base64Data,
    });
    return res?.success ?? false;
  } catch (err: any) {
    console.error('[ThermalPrinterService] printThermalRaw error:', err);
    throw err;
  }
};
