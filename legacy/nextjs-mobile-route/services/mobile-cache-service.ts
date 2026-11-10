"use client";

import { Product } from '@/types/product';

const DB_NAME = 'ventify_mobile_pos_db';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products_cache';

class MobileCacheService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private memoryCache: Map<string, Product> = new Map();

  private getDB(): Promise<IDBDatabase> {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return Promise.reject(new Error('IndexedDB no soportado'));
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event: any) => {
          const db = event.target.result as IDBDatabase;
          if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
            const store = db.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
            store.createIndex('barcode', 'barcode', { unique: false });
            store.createIndex('sku', 'sku', { unique: false });
            store.createIndex('category', 'category', { unique: false });
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    return this.dbPromise;
  }

  /**
   * Guarda o actualiza catálogo completo en IndexedDB y memoria
   */
  async cacheProducts(products: Product[]): Promise<void> {
    for (const p of products) {
      this.memoryCache.set(p.id, p);
    }

    try {
      const db = await this.getDB();
      const tx = db.transaction(STORE_PRODUCTS, 'readwrite');
      const store = tx.objectStore(STORE_PRODUCTS);
      for (const product of products) {
        store.put(product);
      }
    } catch (err) {
      console.warn('[MobileCache] Error guardando en IndexedDB:', err);
    }
  }

  /**
   * Obtiene todos los productos cacheados (primero memoria, luego IndexedDB)
   */
  async getAllProducts(): Promise<Product[]> {
    if (this.memoryCache.size > 0) {
      return Array.from(this.memoryCache.values());
    }

    try {
      const db = await this.getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_PRODUCTS, 'readonly');
        const store = tx.objectStore(STORE_PRODUCTS);
        const req = store.getAll();
        req.onsuccess = () => {
          const result: Product[] = req.result || [];
          for (const p of result) {
            this.memoryCache.set(p.id, p);
          }
          resolve(result);
        };
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  /**
   * Busca producto por código de barras o SKU en memoria con latencia < 5ms
   */
  findByBarcodeOrSku(code: string): Product | undefined {
    if (!code) return undefined;
    const clean = code.trim().toLowerCase();
    const withoutLeadingZeroes = clean.replace(/^0+/, '') || clean;

    for (const p of this.memoryCache.values()) {
      const pBarcode = (p.barcode || '').trim().toLowerCase();
      const pSku = (p.sku || '').trim().toLowerCase();

      if (pBarcode === clean || pBarcode === withoutLeadingZeroes) return p;
      if (pSku === clean || pSku === withoutLeadingZeroes) return p;

      // Verificar array de códigos alternativos si existen
      if (Array.isArray(p.barcodes)) {
        for (const alt of p.barcodes) {
          const altClean = (alt || '').trim().toLowerCase();
          if (altClean === clean || altClean === withoutLeadingZeroes) return p;
        }
      }
    }

    return undefined;
  }
}

export const mobileCacheService = new MobileCacheService();
