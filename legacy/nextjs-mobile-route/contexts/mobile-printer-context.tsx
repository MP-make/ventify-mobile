"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { EscPosBuilder, EscPosReceiptData } from '@/lib/printing/escpos-builder';
import { useToast } from '@/hooks/use-toast';

interface MobilePrinterSettings {
  paperWidth: 58 | 80;
  autoCut: boolean;
  openDrawer: boolean;
  deviceName?: string;
}

interface MobilePrinterContextType {
  isConnected: boolean;
  isConnecting: boolean;
  deviceName: string | null;
  paperWidth: 58 | 80;
  setPaperWidth: (width: 58 | 80) => void;
  connectBluetooth: () => Promise<boolean>;
  disconnect: () => void;
  printReceipt: (receiptData: EscPosReceiptData) => Promise<boolean>;
  printTestTicket: () => Promise<boolean>;
}

const MobilePrinterContext = createContext<MobilePrinterContextType | null>(null);

const PRINTER_STORAGE_KEY = 'ventify_mobile_bluetooth_printer';

export function MobilePrinterProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [paperWidth, setPaperWidthState] = useState<58 | 80>(80);
  const [bluetoothDevice, setBluetoothDevice] = useState<any>(null);
  const [characteristic, setCharacteristic] = useState<any>(null);

  const { toast } = useToast();

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PRINTER_STORAGE_KEY);
      if (saved) {
        const parsed: MobilePrinterSettings = JSON.parse(saved);
        if (parsed.paperWidth) setPaperWidthState(parsed.paperWidth);
        if (parsed.deviceName) setDeviceName(parsed.deviceName);
      }
    } catch {
      // Ignorar si no hay configuración
    }
  }, []);

  const setPaperWidth = useCallback((width: 58 | 80) => {
    setPaperWidthState(width);
    try {
      const current = localStorage.getItem(PRINTER_STORAGE_KEY);
      const data = current ? JSON.parse(current) : {};
      localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify({ ...data, paperWidth: width }));
    } catch {
      // Ignore
    }
  }, []);

  const connectBluetooth = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !(navigator as any).bluetooth) {
      toast({
        title: "Bluetooth no disponible",
        description: "El navegador o dispositivo no soporta Web Bluetooth API.",
        variant: "destructive",
      });
      return false;
    }

    try {
      setIsConnecting(true);
      // Filtros para impresoras térmicas BLE estándar
      const device = await (navigator as any).bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          '000018f0-0000-1000-8000-00805f9b34fb', // Standard Serial/Printer
          'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Posnet / Xprinter BLE
          '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC Transparent Service
          '0000ae00-0000-1000-8000-00805f9b34fb', // Zjiang / MPT-II
          '0000ff00-0000-1000-8000-00805f9b34fb',
        ],
      });

      const server = await device.gatt?.connect();
      if (!server) throw new Error("No se pudo conectar al servidor GATT.");

      let targetChar: any = null;

      // Buscar servicios conocidos
      const services = await server.getPrimaryServices();
      for (const service of services) {
        const chars = await service.getCharacteristics();
        for (const char of chars) {
          if (char.properties.write || char.properties.writeWithoutResponse) {
            targetChar = char;
            break;
          }
        }
        if (targetChar) break;
      }

      if (!targetChar) {
        throw new Error("No se encontró canal de escritura ESC/POS en el dispositivo.");
      }

      setBluetoothDevice(device);
      setCharacteristic(targetChar);
      setIsConnected(true);
      setDeviceName(device.name || "Ticketera Bluetooth");

      device.addEventListener('gattserverdisconnected', () => {
        setIsConnected(false);
        setCharacteristic(null);
      });

      try {
        localStorage.setItem(
          PRINTER_STORAGE_KEY,
          JSON.stringify({ paperWidth, autoCut: true, openDrawer: false, deviceName: device.name })
        );
      } catch {
        // Ignore
      }

      toast({
        title: "Impresora Conectada",
        description: `Vinculada con éxito a ${device.name || 'Ticketera'}.`,
      });
      return true;
    } catch (err: any) {
      if (err.name !== 'NotFoundError') {
        toast({
          title: "Error de conexión Bluetooth",
          description: err.message || "No se pudo vincular la ticketera.",
          variant: "destructive",
        });
      }
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [paperWidth, toast]);

  const disconnect = useCallback(() => {
    if (bluetoothDevice && bluetoothDevice.gatt?.connected) {
      bluetoothDevice.gatt.disconnect();
    }
    setIsConnected(false);
    setCharacteristic(null);
  }, [bluetoothDevice]);

  const sendRawEscPos = useCallback(async (buffer: Uint8Array): Promise<boolean> => {
    if (!characteristic) {
      return false;
    }

    try {
      // Chunking para BLE (MTU seguro: 512 bytes por fragmento)
      const CHUNK_SIZE = 512;
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length));
        if (characteristic.writeValueWithoutResponse) {
          await characteristic.writeValueWithoutResponse(chunk);
        } else {
          await characteristic.writeValue(chunk);
        }
        // Pequeño retardo entre fragmentos para no saturar el buffer de la impresora
        await new Promise((r) => setTimeout(r, 20));
      }
      return true;
    } catch (err: any) {
      console.error("[MobilePrinter] Error enviando bytes ESC/POS:", err);
      toast({
        title: "Error de impresión",
        description: "No se pudieron enviar los datos a la ticketera.",
        variant: "destructive",
      });
      return false;
    }
  }, [characteristic, toast]);

  const printReceipt = useCallback(async (receiptData: EscPosReceiptData): Promise<boolean> => {
    try {
      const buffer = EscPosBuilder.buildReceipt(receiptData, {
        paperWidth,
        autoCut: true,
        openDrawer: false,
      });

      if (!isConnected || !characteristic) {
        // Si no está conectada por Bluetooth nativo, intenta conectar o alerta
        const connected = await connectBluetooth();
        if (!connected) return false;
      }

      return await sendRawEscPos(buffer);
    } catch (err: any) {
      console.error("[MobilePrinter] Error al generar recibo:", err);
      return false;
    }
  }, [paperWidth, isConnected, characteristic, connectBluetooth, sendRawEscPos]);

  const printTestTicket = useCallback(async (): Promise<boolean> => {
    const testData: EscPosReceiptData = {
      businessName: "VENTIFY POS MÓVIL",
      description: "PRUEBA DE IMPRESIÓN DIRECTA",
      address: "Conexión Bluetooth ESC/POS",
      documentTitle: "TICKET DE PRUEBA",
      documentNumber: "TEST-0001",
      date: new Date().toLocaleDateString('es-PE'),
      time: new Date().toLocaleTimeString('es-PE'),
      paymentMethod: "Bluetooth SPP/BLE",
      items: [
        { name: "Prueba Protocolo ESC/POS", quantity: 1, price: 0.00, total: 0.00 },
        { name: `Ancho configurado: ${paperWidth}mm`, quantity: 1, price: 0.00, total: 0.00 },
      ],
      subtotal: 0.00,
      total: 0.00,
      footerNote: "¡Tu ticketera térmica móvil funciona correctamente!",
    };

    const success = await printReceipt(testData);
    if (success) {
      toast({
        title: "Ticket impreso",
        description: "El ticket de prueba se envió a la impresora.",
      });
    }
    return success;
  }, [paperWidth, printReceipt, toast]);

  return (
    <MobilePrinterContext.Provider
      value={{
        isConnected,
        isConnecting,
        deviceName,
        paperWidth,
        setPaperWidth,
        connectBluetooth,
        disconnect,
        printReceipt,
        printTestTicket,
      }}
    >
      {children}
    </MobilePrinterContext.Provider>
  );
}

export function useMobilePrinter() {
  const context = useContext(MobilePrinterContext);
  if (!context) {
    throw new Error('useMobilePrinter must be used within a MobilePrinterProvider');
  }
  return context;
}
