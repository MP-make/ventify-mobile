import { catalogAttributeUpdate, catalogSizeInput } from '@/lib/product-attributes';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AppState,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { X, Package, Save } from 'lucide-react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import { useAuthSession } from '@/context/AuthContext';
import { useBusinessSettings, useOfflineStatus } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { checkIsOnlineLive } from '@/lib/online-guard';
import { normalizePresentation } from '@/lib/presentation-parity';
import type { BranchPriceConfig, PriceTier, ProductAttribute, ProductVariant } from '@/types';
import {
  isLocalFileUri,
  mergeSingleBranchStock,
  normalizePresentationBidirectional,
  normalizePriceTiers,
  sanitizeRemoteImageUrls,
  serializeBranchPrices,
  uploadProductImageToStorage,
} from '@/services/inventory-kardex-service';
import {
  MAX_GALLERY_IMAGES,
  generatePeruvianEan13,
  type ProductPresentation,
  type ProductFormData,
  type BranchPriceDraft,
  type ProductAttributeDraft,
} from './product-form/productFormTypes';
import { productFormStyles as styles } from './product-form/productFormStyles';
import { GallerySection } from './product-form/GallerySection';
import { BarcodeSection } from './product-form/BarcodeSection';
import { CategoryFiltersSection } from './product-form/CategoryFiltersSection';
import { UnitsTaxSection } from './product-form/UnitsTaxSection';
import { PricingSection } from './product-form/PricingSection';
import { PriceTiersSection } from './product-form/PriceTiersSection';
import { BranchPricingSection } from './product-form/BranchPricingSection';
import { InventorySection } from './product-form/InventorySection';
import { PresentationsSection } from './product-form/PresentationsSection';
import { VariantsSection } from './product-form/VariantsSection';
import { AttributesSection } from './product-form/AttributesSection';
import { PresentationFormSubModal } from './product-form/PresentationFormSubModal';
import { VariantFormSubModal } from './product-form/VariantFormSubModal';

export type { ProductPresentation, ProductFormData };
export { generatePeruvianEan13 };

interface ProductFormModalProps {
  visible: boolean;
  onClose: () => void;
  product?: any | null;
  onSave?: (productData: ProductFormData) => Promise<void> | void;
  branchId?: string;
  accountId?: string;
}

const BARCODE_SCANNER_CONFIG: any = {
  barcodeTypes: ['ean13', 'ean8', 'qr', 'code128', 'code39', 'upc_a', 'upc_e'],
};

export const ProductFormModal: React.FC<ProductFormModalProps> = React.memo(({
  visible,
  onClose,
  product,
  onSave,
  branchId = 'main',
  accountId: accountIdProp,
}) => {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { accountId: authAccountId } = useAuthSession();
  const effectiveAccountId = accountIdProp || authAccountId || '';
  const { branches, posSettings } = useBusinessSettings();
  const { isOnline: settingsIsOnline } = useOfflineStatus();
  const { canManageProducts, canViewMargins } = usePermissions();
  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;
  const compactLayout = windowWidth < 380;

  const lastScanTimestampRef = useRef<number>(0);
  const scanningTargetRef = useRef<'main' | number>('main');
  const wasVisibleRef = useRef(false);

  const [formSessionKey, setFormSessionKey] = useState(0);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Abarrotes');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState('');
  const [brand, setBrand] = useState('');
  const [sizeLabel, setSizeLabel] = useState('');
  const [extraBarcodes, setExtraBarcodes] = useState<string[]>([]);
  const [initialShowExtraBarcodes, setInitialShowExtraBarcodes] = useState(false);
  const [unitOfMeasure, setUnitOfMeasure] = useState<string>('NIU');
  const [allowDecimals, setAllowDecimals] = useState<boolean>(false);
  const [taxExemptionCode, setTaxExemptionCode] = useState<'10' | '20' | '30'>('10');
  const [priceStr, setPriceStr] = useState('');
  const [minPriceStr, setMinPriceStr] = useState('');
  const [costStr, setCostStr] = useState('');
  const [stockStr, setStockStr] = useState('0');
  const [minStockStr, setMinStockStr] = useState('3');
  const [presentations, setPresentations] = useState<ProductPresentation[]>([]);
  const [galleryImages, setGalleryImages] = useState<string[]>([]);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [stockByBranch, setStockByBranch] = useState<Record<string, number>>({});

  const [priceTiers, setPriceTiers] = useState<PriceTier[]>([]);
  const [branchPricesDraft, setBranchPricesDraft] = useState<Record<string, BranchPriceDraft>>({});
  const [initialBranchPricesExpanded, setInitialBranchPricesExpanded] = useState(false);

  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const variantsRef = useRef<ProductVariant[]>(variants);
  variantsRef.current = variants;

  const [attributesList, setAttributesList] = useState<ProductAttributeDraft[]>([]);

  // Sub-modales condicionalmente montados
  const [presModalState, setPresModalState] = useState<{
    open: boolean;
    editing: ProductPresentation | null;
  }>({ open: false, editing: null });

  const [variantModalState, setVariantModalState] = useState<{
    open: boolean;
    editing: ProductVariant | null;
  }>({ open: false, editing: null });

  // Cámara para escanear código
  const [scannerActive, setScannerActive] = useState(false);
  const [isAppActive, setIsAppActive] = useState(true);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraPermissionRef = useRef(cameraPermission);
  cameraPermissionRef.current = cameraPermission;
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (typeof AppState?.addEventListener !== 'function') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      setIsAppActive(nextState === 'active');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      return;
    }
    if (wasVisibleRef.current) return;
    wasVisibleRef.current = true;
    setUploadStatus(null);
    setFormSessionKey((k) => k + 1);

    if (product) {
      setName(product.name || '');
      setCategory(product.category || 'Abarrotes');
      setBarcode(product.barcode || '');
      setSku(product.sku || '');
      setBrand(product.brand || '');
      setSizeLabel(catalogSizeInput(product));
      const existingExtras = Array.isArray(product.barcodes)
        ? product.barcodes.filter((b: string) => b && b !== product.barcode)
        : [];
      setExtraBarcodes(existingExtras);
      setInitialShowExtraBarcodes(existingExtras.length > 0);
      const unit = product.unitOfMeasure || 'NIU';
      setUnitOfMeasure(unit);
      setAllowDecimals(
        product.allowDecimals !== undefined
          ? Boolean(product.allowDecimals)
          : ['KGM', 'kg', 'LTR', 'lt', 'g', 'm'].includes(unit)
      );
      const rawTax = String(product.taxExemptionCode || '10');
      setTaxExemptionCode(rawTax === '20' || rawTax === '30' ? rawTax : '10');
      setPriceStr(product.price !== undefined ? String(product.price) : '');
      setMinPriceStr(
        product.minSalePrice !== undefined
          ? String(product.minSalePrice)
          : product.price !== undefined
          ? String(product.price)
          : ''
      );
      setCostStr(
        product.cost !== undefined
          ? String(product.cost)
          : product.costPrice !== undefined
          ? String(product.costPrice)
          : ''
      );

      const currentStock =
        product.stock && typeof product.stock === 'object'
          ? product.stock[branchId] ?? Object.values(product.stock)[0] ?? 0
          : typeof product.stock === 'number'
          ? product.stock
          : 0;
      setStockStr(String(currentStock));
      setMinStockStr(
        product.minStock !== undefined && product.minStock !== null
          ? String(product.minStock)
          : '3'
      );
      setPresentations((product.presentations || []).map(normalizePresentationBidirectional));

      const initialGallery = sanitizeRemoteImageUrls(
        Array.isArray(product.galleryImages) && product.galleryImages.length > 0
          ? product.galleryImages
          : [product.imageUrl || product.thumbUrl || '']
      );
      setGalleryImages(initialGallery);

      if (product.stock && typeof product.stock === 'object') {
        setStockByBranch({ ...product.stock });
      } else {
        setStockByBranch({ [branchId]: typeof product.stock === 'number' ? product.stock : 0 });
      }

      setPriceTiers(normalizePriceTiers(product.priceTiers));

      const bpDraft: Record<string, BranchPriceDraft> = {};
      if (product.branchPrices && typeof product.branchPrices === 'object') {
        for (const [bId, cfg] of Object.entries<any>(product.branchPrices)) {
          if (!cfg) continue;
          bpDraft[bId] = {
            suggestedPrice: cfg.suggestedPrice !== undefined ? String(cfg.suggestedPrice) : '',
            costPrice: cfg.costPrice !== undefined ? String(cfg.costPrice) : '',
            minSalePrice: cfg.minSalePrice !== undefined ? String(cfg.minSalePrice) : '',
          };
        }
      }
      setBranchPricesDraft(bpDraft);
      setInitialBranchPricesExpanded(Object.keys(bpDraft).length > 0);

      setVariants(Array.isArray(product.variants) ? product.variants : []);
      const rawAttrs = Array.isArray(product.attributes)
        ? product.attributes
            .map((a: any) => ({
              key: String(a?.name ?? a?.key ?? '').trim(),
              value: String(a?.value ?? '').trim(),
            }))
            .filter((a: { key: string; value: string }) => a.key.length > 0)
        : product.attributes && typeof product.attributes === 'object'
        ? Object.entries(product.attributes).map(([k, v]) => ({
            key: k,
            value: String(v ?? ''),
          }))
        : [];
      setAttributesList(rawAttrs);
    } else {
      // Reset para nuevo producto
      setName('');
      setCategory('Abarrotes');
      setBarcode(generatePeruvianEan13());
      setSku('');
      setBrand('');
      setSizeLabel('');
      setExtraBarcodes([]);
      setInitialShowExtraBarcodes(false);
      setUnitOfMeasure('NIU');
      setAllowDecimals(false);
      setTaxExemptionCode('10');
      setPriceStr('');
      setMinPriceStr('');
      setCostStr('');
      setStockStr('0');
      setMinStockStr('3');
      setPresentations([]);
      setGalleryImages([]);
      setStockByBranch(branchId ? { [branchId]: 0 } : {});
      setPriceTiers([]);
      setBranchPricesDraft({});
      setInitialBranchPricesExpanded(false);
      setVariants([]);
      setAttributesList([]);
    }

    setScannerActive(false);
    setPresModalState({ open: false, editing: null });
    setVariantModalState({ open: false, editing: null });
  }, [visible, product, branchId]);

  // --------------------------------------------------------------------------
  // CALLBACKS ESTABLES PARA SECCIONES MEMOIZADAS
  // --------------------------------------------------------------------------
  const handleAppendImages = useCallback((uris: string[]) => {
    setGalleryImages((prev) => {
      const merged = [...prev];
      for (const uri of uris) {
        if (uri && !merged.includes(uri) && merged.length < MAX_GALLERY_IMAGES) {
          merged.push(uri);
        }
      }
      return merged;
    });
  }, []);

  const handleSetMainImage = useCallback((index: number) => {
    setGalleryImages((prev) => {
      if (index <= 0 || index >= prev.length) return prev;
      const target = prev[index];
      return [target, ...prev.filter((_, i) => i !== index)];
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleRemoveImage = useCallback((index: number) => {
    setGalleryImages((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleGenerateBarcode = useCallback(() => {
    setBarcode(generatePeruvianEan13());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleStartScanner = useCallback(
    async (target: 'main' | number = 'main') => {
      scanningTargetRef.current = target;
      if (!cameraPermissionRef.current?.granted) {
        const result = await requestCameraPermission();
        if (!result.granted) {
          Alert.alert('Permiso Requerido', 'Se necesita acceso a la cámara para escanear códigos de barras.');
          return;
        }
      }
      setScannerActive(true);
    },
    [requestCameraPermission]
  );

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    const now = Date.now();
    if (now - lastScanTimestampRef.current < 1000) return;
    lastScanTimestampRef.current = now;

    if (data) {
      const clean = data.trim();
      const target = scanningTargetRef.current;
      if (target === 'main') {
        setBarcode(clean);
      } else if (typeof target === 'number') {
        setExtraBarcodes((prev) => {
          const next = [...prev];
          next[target] = clean;
          return next;
        });
      }
      setScannerActive(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, []);

  const handleAddExtraBarcode = useCallback(() => {
    setExtraBarcodes((prev) => [...prev, '']);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleRemoveExtraBarcode = useCallback((index: number) => {
    setExtraBarcodes((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleUpdateExtraBarcode = useCallback((index: number, val: string) => {
    setExtraBarcodes((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  }, []);

  const handleGenerateExtraBarcode = useCallback((index: number) => {
    const ean = generatePeruvianEan13();
    setExtraBarcodes((prev) => {
      const next = [...prev];
      next[index] = ean;
      return next;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleSelectUnit = useCallback((code: string) => {
    setUnitOfMeasure(code);
    if (['KGM', 'LTR', 'g', 'm'].includes(code)) {
      setAllowDecimals(true);
    }
  }, []);

  const handleAddPriceTier = useCallback((minQty: number, tierPrice: number) => {
    setPriceTiers((prev) => {
      const filtered = prev.filter((t) => Number(t.minQuantity ?? t.minQty) !== minQty);
      return normalizePriceTiers([
        ...filtered,
        { minQuantity: minQty, minQty, unitPrice: tierPrice, price: tierPrice },
      ]);
    });
  }, []);

  const handleRemovePriceTier = useCallback((index: number) => {
    setPriceTiers((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleChangeBranchPriceField = useCallback(
    (bId: string, field: keyof BranchPriceDraft, value: string) => {
      setBranchPricesDraft((prev) => {
        const existing = prev[bId] || {
          suggestedPrice: '',
          costPrice: '',
          minSalePrice: '',
        };
        return {
          ...prev,
          [bId]: {
            ...existing,
            [field]: value,
          },
        };
      });
    },
    []
  );

  const handleChangeBranchStock = useCallback((bId: string, val: string) => {
    const num = parseFloat(val) || 0;
    setStockByBranch((prev) => ({ ...prev, [bId]: num }));
  }, []);

  const handleOpenNewPresentation = useCallback(() => {
    setPresModalState({ open: true, editing: null });
  }, []);

  const handleOpenEditPresentation = useCallback((pres: ProductPresentation) => {
    setPresModalState({ open: true, editing: pres });
  }, []);

  const handleClosePresModal = useCallback(() => {
    setPresModalState({ open: false, editing: null });
  }, []);

  const handleSubmitPresentation = useCallback(
    (updatedPres: ProductPresentation, isEditing: boolean) => {
      setPresentations((prev) =>
        isEditing
          ? prev.map((p) => (p.id === updatedPres.id ? updatedPres : p))
          : [...prev, updatedPres]
      );
      setPresModalState({ open: false, editing: null });
    },
    []
  );

  const handleRemovePresentation = useCallback((id: string) => {
    setPresentations((prev) => prev.filter((p) => p.id !== id));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const syncBranchStockFromVariants = useCallback(
    (nextVariants: ProductVariant[]) => {
      if (nextVariants.length === 0) return;
      const sum = nextVariants.reduce(
        (acc, v) => acc + (Number(v.stock?.[branchId] ?? 0) || 0),
        0
      );
      setStockStr(String(sum));
      setStockByBranch((prev) => ({ ...prev, [branchId]: sum }));
    },
    [branchId]
  );

  const handleOpenNewVariant = useCallback(() => {
    setVariantModalState({ open: true, editing: null });
  }, []);

  const handleOpenEditVariant = useCallback((v: ProductVariant) => {
    setVariantModalState({ open: true, editing: v });
  }, []);

  const handleCloseVariantModal = useCallback(() => {
    setVariantModalState({ open: false, editing: null });
  }, []);

  const handleSubmitVariant = useCallback(
    (nextVariant: ProductVariant, isEditing: boolean) => {
      const current = variantsRef.current;
      const nextList = isEditing
        ? current.map((v) => (v.id === nextVariant.id ? nextVariant : v))
        : [...current, nextVariant];
      setVariants(nextList);
      syncBranchStockFromVariants(nextList);
      setVariantModalState({ open: false, editing: null });
    },
    [syncBranchStockFromVariants]
  );

  const handleRemoveVariant = useCallback(
    (variantId: string) => {
      const nextList = variantsRef.current.filter((v) => v.id !== variantId);
      setVariants(nextList);
      syncBranchStockFromVariants(nextList);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [syncBranchStockFromVariants]
  );

  const handleAddAttribute = useCallback((k: string, v: string) => {
    setAttributesList((prev) => {
      const idx = prev.findIndex((item) => item.key.toLowerCase() === k.toLowerCase());
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { key: k, value: v };
        return next;
      }
      return [...prev, { key: k, value: v }];
    });
  }, []);

  const handleRemoveAttribute = useCallback((idx: number) => {
    setAttributesList((prev) => prev.filter((_, i) => i !== idx));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleSave = async () => {
    const priceVal = parseFloat(priceStr) || 0;
    const costVal = parseFloat(costStr) || 0;
    const minPriceVal = parseFloat(minPriceStr) || 0;

    if (!name.trim()) {
      Alert.alert('Campo Requerido', 'Por favor ingresa el nombre del producto.');
      return;
    }
    if (priceVal <= 0) {
      Alert.alert('Precio Inválido', 'El precio de venta debe ser mayor a S/ 0.00.');
      return;
    }
    if (minPriceVal > priceVal) {
      Alert.alert('Precio Mínimo Inválido', 'El precio mínimo no puede ser mayor al precio de venta.');
      return;
    }
    if (!canManageProducts) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para crear o modificar productos.');
      return;
    }

    const cleanExtraBarcodes = extraBarcodes
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && b !== barcode.trim());

    try {
      setIsSaving(true);
      setUploadStatus(null);

      // Subir imágenes locales a Firebase Storage antes de persistir en Firestore
      const localCount = galleryImages.filter((u) => isLocalFileUri(u)).length;
      if (localCount > 0 && !effectiveAccountId) {
        throw new Error('No se detectó accountId para subir imágenes a la nube.');
      }

      const resolvedGallery: string[] = new Array(galleryImages.length).fill('');
      const localIndices: number[] = [];
      for (let i = 0; i < galleryImages.length; i += 1) {
        const uri = galleryImages[i];
        if (isLocalFileUri(uri)) {
          localIndices.push(i);
        } else if (uri) {
          resolvedGallery[i] = uri;
        }
      }

      if (localIndices.length > 0) {
        const online = await checkIsOnlineLive(settingsIsOnline);
        if (!online) {
          throw new Error(
            'Sin conexión a internet. Quita las imágenes nuevas o conéctate para subir fotos del producto.'
          );
        }
        let completedUploads = 0;
        let nextPtr = 0;
        const workerCount = Math.min(3, localIndices.length);
        setUploadStatus(
          `Subiendo ${localIndices.length} ${localIndices.length === 1 ? 'imagen' : 'imágenes'}...`
        );
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (nextPtr < localIndices.length) {
              const targetIdx = localIndices[nextPtr++];
              const uri = galleryImages[targetIdx];
              const remoteUrl = await uploadProductImageToStorage(
                uri,
                effectiveAccountId,
                product?.id
              );
              resolvedGallery[targetIdx] = remoteUrl;
              completedUploads += 1;
              if (localIndices.length > 1) {
                setUploadStatus(`Subiendo imagen ${completedUploads} de ${localIndices.length}...`);
              }
            }
          })
        );
      }
      setUploadStatus(null);

      const safeGallery = sanitizeRemoteImageUrls(resolvedGallery);
      const finalImageUrl = safeGallery[0] || '';

      const singleBranchStockNum = parseFloat(stockStr) || 0;
      const mergedStockByBranch = mergeSingleBranchStock({
        existingStock: product?.stock,
        stockByBranch,
        singleBranchStock: singleBranchStockNum,
        branchId,
        isMultiBranch: Boolean(branches && branches.length > 1),
        variants,
      });

      const parsedMinStock = parseFloat(minStockStr);
      const safeMinStock =
        Number.isFinite(parsedMinStock) && parsedMinStock >= 0 ? parsedMinStock : 3;

      const numericBranchDraft: Record<string, BranchPriceConfig> = {};
      for (const [bId, draft] of Object.entries(branchPricesDraft)) {
        const sug = parseFloat(draft.suggestedPrice);
        const cst = parseFloat(draft.costPrice);
        const min = parseFloat(draft.minSalePrice);
        const entry: BranchPriceConfig = {};
        if (Number.isFinite(sug) && sug > 0) entry.suggestedPrice = sug;
        if (Number.isFinite(cst) && cst > 0) entry.costPrice = cst;
        if (Number.isFinite(min) && min > 0) entry.minSalePrice = min;
        if (Object.keys(entry).length > 0) {
          numericBranchDraft[bId] = entry;
        }
      }
      const serializedBranchPrices = serializeBranchPrices(numericBranchDraft, {
        baseSuggested: priceVal,
        baseCost: costVal,
        showMinSalePrice: true,
      });

      const attributesArray: ProductAttribute[] = [];
      for (const item of attributesList) {
        const attrName = item.key.trim();
        const attrValue = item.value.trim();
        if (attrName && attrValue) {
          attributesArray.push({ name: attrName, value: attrValue });
        }
      }

      const payload: ProductFormData = {
        id: product?.id,
        name: name.trim(),
        category: category.trim() || 'General',
        barcode: barcode.trim(),
        barcodes: cleanExtraBarcodes,
        sku: sku.trim() || barcode.trim() || `SKU-${Date.now().toString().slice(-6)}`,
        ...catalogAttributeUpdate(product, enableCatalogFilters, brand, sizeLabel),
        unitOfMeasure,
        allowDecimals,
        taxExemptionCode,
        price: priceVal,
        minSalePrice: minPriceVal > 0 ? minPriceVal : priceVal,
        cost: costVal,
        stock: mergedStockByBranch[branchId] ?? singleBranchStockNum,
        minStock: safeMinStock,
        presentations: presentations.map((p) =>
          normalizePresentationBidirectional(normalizePresentation(p))
        ),
        variants,
        priceTiers: normalizePriceTiers(priceTiers),
        branchPrices: serializedBranchPrices,
        attributes: attributesArray,
        imageUrl: finalImageUrl,
        thumbUrl: finalImageUrl,
        galleryImages: safeGallery,
        stockByBranch: mergedStockByBranch,
      };

      if (onSave) {
        await onSave(payload);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err: any) {
      setUploadStatus(null);
      Alert.alert('Error al guardar', err?.message || 'No se pudo guardar el producto.');
    } finally {
      setIsSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Cabecera */}
        <View style={[styles.header, { paddingTop: Math.max(insets.top + 8, 16) }]}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerIconWrapper}>
              <Package size={20} color={ui.primary} />
            </View>
            <View style={styles.headerCopy}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {product ? 'Editar Producto' : 'Nuevo Producto'}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {product ? product.name : 'Configuración de catálogo y precios'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeBtn}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cerrar formulario de producto"
          >
            <X size={20} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Visor de Escáner Integrado para Código de Barras */}
        {scannerActive && isAppActive ? (
          <View style={styles.scannerWrapper}>
            <CameraView
              style={styles.cameraView}
              barcodeScannerSettings={BARCODE_SCANNER_CONFIG}
              onBarcodeScanned={handleBarcodeScanned}
            >
              <View style={styles.cameraOverlay}>
                <View style={styles.scanTargetBox} />
                <Text style={styles.scanInstruction}>Apunta al código de barras del producto</Text>
                <TouchableOpacity
                  style={styles.cancelScanBtn}
                  onPress={() => setScannerActive(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar cámara"
                >
                  <Text style={styles.cancelScanText}>Cerrar Cámara</Text>
                </TouchableOpacity>
              </View>
            </CameraView>
          </View>
        ) : null}

        <ScrollView
          style={styles.scrollContent}
          contentContainerStyle={styles.scrollInner}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          <SectionHeading title="Información del producto" subtitle="Identidad y clasificación del artículo." />
          <View style={styles.formGroup}>
            <Text style={styles.label}>
              Nombre del Producto <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              accessibilityLabel="Nombre del producto, obligatorio"
              placeholder="Ej. Gaseosa Inca Kola 500ml"
              placeholderTextColor={ui.textMuted}
            />
          </View>

          <GallerySection
            galleryImages={galleryImages}
            onAppendImages={handleAppendImages}
            onSetMainImage={handleSetMainImage}
            onRemoveImage={handleRemoveImage}
          />

          <BarcodeSection
            barcode={barcode}
            extraBarcodes={extraBarcodes}
            compactLayout={compactLayout}
            initialShowExtraBarcodes={initialShowExtraBarcodes}
            formSessionKey={formSessionKey}
            onChangeBarcode={setBarcode}
            onGenerateBarcode={handleGenerateBarcode}
            onStartScanner={handleStartScanner}
            onAddExtraBarcode={handleAddExtraBarcode}
            onRemoveExtraBarcode={handleRemoveExtraBarcode}
            onUpdateExtraBarcode={handleUpdateExtraBarcode}
            onGenerateExtraBarcode={handleGenerateExtraBarcode}
          />

          <CategoryFiltersSection
            sku={sku}
            category={category}
            brand={brand}
            sizeLabel={sizeLabel}
            enableCatalogFilters={enableCatalogFilters}
            compactLayout={compactLayout}
            onChangeSku={setSku}
            onChangeCategory={setCategory}
            onChangeBrand={setBrand}
            onChangeSizeLabel={setSizeLabel}
          />

          <UnitsTaxSection
            unitOfMeasure={unitOfMeasure}
            allowDecimals={allowDecimals}
            taxExemptionCode={taxExemptionCode}
            onSelectUnit={handleSelectUnit}
            onToggleDecimals={setAllowDecimals}
            onSelectTaxCode={setTaxExemptionCode}
          />

          <SectionHeading title="Precios" subtitle="Venta, costo, escalas y margen estimado." />

          <PricingSection
            priceStr={priceStr}
            minPriceStr={minPriceStr}
            costStr={costStr}
            canViewMargins={canViewMargins}
            compactLayout={compactLayout}
            onChangePrice={setPriceStr}
            onChangeMinPrice={setMinPriceStr}
            onChangeCost={setCostStr}
          />

          <PriceTiersSection
            priceTiers={priceTiers}
            formSessionKey={formSessionKey}
            onAddTier={handleAddPriceTier}
            onRemoveTier={handleRemovePriceTier}
          />

          <BranchPricingSection
            branches={branches}
            branchPricesDraft={branchPricesDraft}
            initialExpanded={initialBranchPricesExpanded}
            formSessionKey={formSessionKey}
            onChangeField={handleChangeBranchPriceField}
          />

          <SectionHeading title="Inventario" subtitle="Existencias actuales y alerta de reposición." />

          <InventorySection
            branches={branches}
            branchId={branchId}
            unitOfMeasure={unitOfMeasure}
            allowDecimals={allowDecimals}
            hasVariants={variants.length > 0}
            stockStr={stockStr}
            minStockStr={minStockStr}
            stockByBranch={stockByBranch}
            compactLayout={compactLayout}
            onChangeStock={setStockStr}
            onChangeMinStock={setMinStockStr}
            onChangeBranchStock={handleChangeBranchStock}
          />

          <PresentationsSection
            presentations={presentations}
            unitOfMeasure={unitOfMeasure}
            onOpenNew={handleOpenNewPresentation}
            onOpenEdit={handleOpenEditPresentation}
            onRemove={handleRemovePresentation}
          />

          <VariantsSection
            variants={variants}
            branchId={branchId}
            onOpenNew={handleOpenNewVariant}
            onOpenEdit={handleOpenEditVariant}
            onRemove={handleRemoveVariant}
          />

          <AttributesSection
            attributesList={attributesList}
            formSessionKey={formSessionKey}
            onAddAttribute={handleAddAttribute}
            onRemoveAttribute={handleRemoveAttribute}
          />

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* Footer con Botones de Acción */}
        <View
          style={[
            styles.footer,
            compactLayout && styles.footerCompact,
            { paddingBottom: Math.max(16, insets.bottom) },
          ]}
        >
          <TouchableOpacity
            style={[styles.cancelFooterBtn, compactLayout && styles.footerButtonCompact]}
            onPress={onClose}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel="Cancelar y cerrar"
          >
            <Text style={styles.cancelFooterText}>Cancelar</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.saveFooterBtn,
              compactLayout && styles.footerButtonCompact,
              isSaving && styles.btnDisabled,
            ]}
            onPress={handleSave}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel={product ? 'Guardar cambios del producto' : 'Crear producto'}
          >
            {isSaving ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <ActivityIndicator color={ui.surface} size="small" />
                {uploadStatus ? (
                  <Text style={styles.saveFooterText}>{uploadStatus}</Text>
                ) : null}
              </View>
            ) : (
              <>
                <Save size={18} color={ui.surface} />
                <Text style={styles.saveFooterText}>
                  {product ? 'Guardar Cambios' : 'Crear Producto'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Modal Secundario para Crear / Editar Presentación (Condicionalmente montado) */}
        {presModalState.open && (
          <PresentationFormSubModal
            visible={presModalState.open}
            editingPresentation={presModalState.editing}
            compactLayout={compactLayout}
            onClose={handleClosePresModal}
            onSubmit={handleSubmitPresentation}
          />
        )}

        {/* Modal Secundario para Crear / Editar Variante (Condicionalmente montado) */}
        {variantModalState.open && (
          <VariantFormSubModal
            visible={variantModalState.open}
            editingVariant={variantModalState.editing}
            branchId={branchId}
            allowDecimals={allowDecimals}
            compactLayout={compactLayout}
            onClose={handleCloseVariantModal}
            onSubmit={handleSubmitVariant}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
});

export default ProductFormModal;
