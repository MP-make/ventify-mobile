"use client";

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { useProducts } from '@/hooks/products/use-products';
import { useMobileCart } from '../contexts/mobile-cart-context';
import { Product } from '@/types/product';
import { WeightQuantityModal } from '../components/weight-quantity-modal';
import { Search, Plus, Package, Scale } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function MobileCatalogPage() {
  const { products, loading } = useProducts();
  const { addItem, totalAmount, itemCount } = useMobileCart();

  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Todas');
  const [weighingProduct, setWeighingProduct] = useState<Product | null>(null);

  // Categorías únicas con conteo
  const categoryStats = useMemo(() => {
    const counts: Record<string, number> = { Todas: products.length };
    products.forEach((p) => {
      const cat = p.category?.trim() || 'Sin Categoría';
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [products]);

  const categories = useMemo(() => Object.keys(categoryStats), [categoryStats]);

  // Filtrado de productos por búsqueda y categoría
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchCat =
        selectedCategory === 'Todas' ||
        (selectedCategory === 'Sin Categoría' ? !p.category : p.category === selectedCategory);

      if (!matchCat) return false;
      if (!q) return true;

      const nameMatch = p.name?.toLowerCase().includes(q);
      const barcodeMatch = p.barcode?.toLowerCase().includes(q);
      const skuMatch = p.sku?.toLowerCase().includes(q);
      return nameMatch || barcodeMatch || skuMatch;
    });
  }, [products, search, selectedCategory]);

  const handleProductTap = (product: Product) => {
    const isWeighable =
      product.allowDecimals ||
      product.unitOfMeasure === 'kg' ||
      (product as any).unit === 'kg' ||
      (product as any).unit === 'kilo';

    if (isWeighable) {
      setWeighingProduct(product);
    } else {
      addItem(product, 1);
    }
  };

  return (
    <div className="flex flex-col min-h-full bg-white select-none">
      {/* 1. BUSCADOR STICKY SUPERIOR */}
      <div className="p-3 bg-white sticky top-12 z-30 border-b border-neutral-100">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-neutral-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, código o SKU..."
            className="pl-9 h-10 rounded-xl bg-neutral-50 border-neutral-200 text-xs focus:bg-white"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-2.5 text-xs font-bold text-neutral-400"
            >
              ✕
            </button>
          )}
        </div>

        {/* 2. PILLS HORIZONTALES DE CATEGORÍAS */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pt-2.5 pb-0.5">
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                  isSelected
                    ? 'text-white shadow-xs'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
                style={
                  isSelected
                    ? { backgroundColor: 'var(--brand-primary, #047857)' }
                    : undefined
                }
              >
                {cat} ({categoryStats[cat] || 0})
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. GRID TÁCTIL DE 2 COLUMNAS */}
      <div className="flex-1 p-3">
        {loading ? (
          <div className="grid grid-cols-2 gap-2.5">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-44 rounded-2xl bg-neutral-100 animate-pulse" />
            ))}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="py-16 text-center text-neutral-400">
            <Package className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="text-xs font-semibold text-neutral-600">No se encontraron productos</p>
            <p className="text-[11px] text-neutral-400 mt-0.5">Prueba con otro término o categoría</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {filteredProducts.map((product) => {
              const price = product.price || product.suggestedPrice || 0;
              const stockValues = Object.values(product.stock || {});
              const stock = stockValues.length > 0 ? stockValues[0] : 0;
              const isWeighable =
                product.allowDecimals ||
                product.unitOfMeasure === 'kg' ||
                (product as any).unit === 'kg' ||
                (product as any).unit === 'kilo';
              const unitLabel = product.unitOfMeasure || (product as any).unit || 'uds';

              return (
                <div
                  key={product.id}
                  onClick={() => handleProductTap(product)}
                  className="bg-white border border-neutral-200/80 rounded-2xl p-2.5 flex flex-col justify-between shadow-xs hover:border-neutral-300 active:scale-97 transition-all cursor-pointer relative overflow-hidden"
                >
                  {/* Badge de balanza si es por peso */}
                  {isWeighable && (
                    <span className="absolute top-2 left-2 z-10 bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shadow-xs">
                      <Scale className="w-2.5 h-2.5" />
                      KG
                    </span>
                  )}

                  {/* Imagen */}
                  <div className="w-full h-24 rounded-xl bg-neutral-50 mb-2 overflow-hidden flex items-center justify-center border border-neutral-100">
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Package className="w-8 h-8 text-neutral-300" />
                    )}
                  </div>

                  {/* Nombre y Stock */}
                  <div className="mb-2">
                    <h3 className="text-xs font-bold text-neutral-900 line-clamp-2 leading-tight">
                      {product.name}
                    </h3>
                    <p className="text-[10px] text-neutral-400 mt-0.5">
                      {stock > 0 ? (
                        <span className="text-neutral-500 font-medium">
                          {stock} {unitLabel}
                        </span>
                      ) : (
                        <span className="text-rose-500 font-semibold">Sin stock</span>
                      )}
                    </p>
                  </div>

                  {/* Precio y Botón rápido + */}
                  <div className="flex items-center justify-between pt-1 border-t border-neutral-100">
                    <span className="text-xs font-extrabold text-neutral-900">
                      S/ {price.toFixed(2)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleProductTap(product);
                      }}
                      className="w-7 h-7 rounded-lg text-white flex items-center justify-center shadow-xs active:scale-90 transition-transform"
                      style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
                      aria-label="Agregar producto"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. BARRA DE ACCIÓN INFERIOR (Hacia Checkout) */}
      {itemCount > 0 && (
        <div className="sticky bottom-16 inset-x-0 p-3 bg-white/95 backdrop-blur-md border-t border-neutral-200 shadow-md">
          <Link href="/mobile/checkout" className="block">
            <Button
              className="w-full h-12 text-sm font-semibold rounded-xl text-white shadow-md flex items-center justify-between px-4 active:scale-98 transition-transform"
              style={{ backgroundColor: 'var(--brand-primary, #047857)' }}
            >
              <span>{itemCount} {itemCount === 1 ? 'producto' : 'productos'}</span>
              <div className="flex items-center gap-1.5 font-bold">
                <span>S/ {totalAmount.toFixed(2)} ➔ Ir a Pagar</span>
              </div>
            </Button>
          </Link>
        </div>
      )}

      {/* Modal de pesaje para productos por kg */}
      <WeightQuantityModal
        product={weighingProduct}
        isOpen={!!weighingProduct}
        onClose={() => setWeighingProduct(null)}
        onConfirm={(prod, qty) => addItem(prod, qty)}
      />
    </div>
  );
}
