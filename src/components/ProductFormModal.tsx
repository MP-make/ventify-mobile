import { normalizePresentation, presentationFactor } from '@/lib/presentation-parity';
import { catalogAttributeUpdate, catalogSizeInput } from '@/lib/product-attributes';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Switch,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import {
  X,
  Camera,
  Shuffle,
  Plus,
  Trash2,
  Check,
  Package,
  Layers,
  Percent,
  Save,
  Barcode,
  ChevronDown,
  ChevronUp,
  Tag,
  Ruler,
  Edit2,
  ImagePlus,
  Star,
} from 'lucide-react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { DEFAULT_CATALOG_BRANDS } from '@/lib/catalog-filters';
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

export interface ProductPresentation {
  id: string;
  name: string;
  conversionFactor: number;
  quantity?: number;
  factor?: number;
  price: number;
  barcode?: string;
  active?: boolean;
}

export interface ProductFormData {
  id?: string;
  name: string;
  category: string;
  barcode: string;
  barcodes?: string[];
  sku: string;
  brand?: string;
  sizeLabel?: string;
  sizes?: string[];
  unitOfMeasure: 'NIU' | 'KGM' | 'LTR' | 'BX' | string;
  allowDecimals?: boolean;
  taxExemptionCode?: '10' | '20' | '30' | string;
  price: number;
  minSalePrice: number;
  cost: number;
  stock: number;
  minStock: number;
  presentations: ProductPresentation[];
  variants?: ProductVariant[];
  priceTiers?: PriceTier[];
  branchPrices?: Record<string, BranchPriceConfig>;
  attributes?: ProductAttribute[];
  imageUrl?: string;
  thumbUrl?: string;
  galleryImages?: string[];
  stockByBranch?: Record<string, number>;
}

interface ProductFormModalProps {
  visible: boolean;
  onClose: () => void;
  product?: any | null;
  onSave?: (productData: ProductFormData) => Promise<void> | void;
  branchId?: string;
  accountId?: string;
}

/**
 * Calcula el dígito verificador y genera un código EAN-13 válido oficial de Perú (prefijo 775)
 */
export function generatePeruvianEan13(): string {
  const prefix = '775';
  let random9 = '';
  for (let i = 0; i < 9; i++) {
    random9 += Math.floor(Math.random() * 10).toString();
  }
  const code12 = prefix + random9;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code12[i], 10);
    // Posición impar (1-based: 1, 3, 5... -> 0-based: 0, 2, 4...) peso 1
    // Posición par (1-based: 2, 4, 6... -> 0-based: 1, 3, 5...) peso 3
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return code12 + checkDigit.toString();
}

const COMMON_CATEGORIES = [
  'Abarrotes',
  'Bebidas',
  'Snacks',
  'Lácteos',
  'Golosinas',
  'Limpieza',
  'Cuidado Personal',
  'Panadería',
  'Frutas y Verduras',
  'Otros',
];

const UNITS: { code: string; label: string; desc: string }[] = [
  { code: 'NIU', label: 'Unidad (NIU)', desc: 'Pieza individual' },
  { code: 'KGM', label: 'Kilo (KGM)', desc: 'Venta por peso' },
  { code: 'LTR', label: 'Litro (LTR)', desc: 'Líquidos a granel' },
  { code: 'BX', label: 'Caja (BX)', desc: 'Embalaje por caja' },
  { code: 'g', label: 'Gramo (g)', desc: 'Fracción peso menor' },
  { code: 'm', label: 'Metro (m)', desc: 'Venta por longitud' },
];

const TAX_CODES: { code: '10' | '20' | '30'; label: string; desc: string }[] = [
  { code: '10', label: 'Gravado IGV (18%)', desc: 'SUNAT 10' },
  { code: '20', label: 'Exonerado (0%)', desc: 'SUNAT 20' },
  { code: '30', label: 'Inafecto (0%)', desc: 'SUNAT 30' },
];

const VARIANT_COLORS = [
  '#111827',
  '#315BE8',
  '#BF3545',
  '#087F5B',
  '#A65E09',
  '#7545D9',
  '#FFFFFF',
];

const MAX_GALLERY_IMAGES = 6;

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
  const { accountId: authAccountId } = useAuth();
  const effectiveAccountId = accountIdProp || authAccountId || '';
  const { branches, posSettings } = useSettings();
  const { canManageProducts, canViewMargins } = usePermissions();
  const enableCatalogFilters = !!posSettings?.enableCatalogFilters;
  const compactLayout = windowWidth < 380;
  const lastScanTimestampRef = useRef<number>(0);

  const [name, setName] = useState('');
  const [category, setCategory] = useState('Abarrotes');
  const [barcode, setBarcode] = useState('');
  const [sku, setSku] = useState('');
  const [brand, setBrand] = useState('');
  const [sizeLabel, setSizeLabel] = useState('');
  const [extraBarcodes, setExtraBarcodes] = useState<string[]>([]);
  const [showExtraBarcodes, setShowExtraBarcodes] = useState(false);
  const [scanningTarget, setScanningTarget] = useState<'main' | number>('main');
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

  // Precios por volumen, precios por sucursal, variantes y atributos
  const [priceTiers, setPriceTiers] = useState<PriceTier[]>([]);
  const [tierMinQtyStr, setTierMinQtyStr] = useState('');
  const [tierPriceStr, setTierPriceStr] = useState('');
  const [branchPricesDraft, setBranchPricesDraft] = useState<
    Record<string, { suggestedPrice: string; costPrice: string; minSalePrice: string }>
  >({});
  const [showBranchPricesSection, setShowBranchPricesSection] = useState(false);

  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [varName, setVarName] = useState('');
  const [varSize, setVarSize] = useState('');
  const [varColorHex, setVarColorHex] = useState('#111827');
  const [varSku, setVarSku] = useState('');
  const [varBarcode, setVarBarcode] = useState('');
  const [varPriceAdjStr, setVarPriceAdjStr] = useState('');
  const [varStockStr, setVarStockStr] = useState('0');

  const [attributesList, setAttributesList] = useState<Array<{ key: string; value: string }>>([]);
  const [attrKeyInput, setAttrKeyInput] = useState('');
  const [attrValInput, setAttrValInput] = useState('');

  // Sub-modal de presentación (crear o editar)
  const [presModalOpen, setPresModalOpen] = useState(false);
  const [editingPresId, setEditingPresId] = useState<string | null>(null);
  const [presName, setPresName] = useState('');
  const [presFactor, setPresFactor] = useState('');
  const [presPrice, setPresPrice] = useState('');
  const [presBarcode, setPresBarcode] = useState('');

  // Cámara para escanear código
  const [scannerActive, setScannerActive] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isSaving, setIsSaving] = useState(false);

  const appendGalleryUris = (uris: string[]) => {
    setGalleryImages((prev) => {
      const merged = [...prev];
      for (const uri of uris) {
        if (uri && !merged.includes(uri) && merged.length < MAX_GALLERY_IMAGES) {
          merged.push(uri);
        }
      }
      return merged;
    });
  };

  const handlePickImage = async () => {
    try {
      const remaining = Math.max(1, MAX_GALLERY_IMAGES - galleryImages.length);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 0.75,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        appendGalleryUris(result.assets.map((a) => a.uri));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      Alert.alert('Error', 'No se pudo seleccionar la imagen de la galería.');
    }
  };

  const handleTakePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permiso requerido', 'Activa el permiso de cámara para tomar fotos del producto.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.75,
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        appendGalleryUris([result.assets[0].uri]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      Alert.alert('Error', 'No se pudo capturar la foto.');
    }
  };

  const handleSetMainImage = (index: number) => {
    setGalleryImages((prev) => {
      if (index <= 0 || index >= prev.length) return prev;
      const target = prev[index];
      return [target, ...prev.filter((_, i) => i !== index)];
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemoveImage = (index: number) => {
    setGalleryImages((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  useEffect(() => {
    if (visible) {
      setUploadStatus(null);
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
        setShowExtraBarcodes(existingExtras.length > 0);
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
        setTierMinQtyStr('');
        setTierPriceStr('');

        const bpDraft: Record<string, { suggestedPrice: string; costPrice: string; minSalePrice: string }> = {};
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
        setShowBranchPricesSection(Object.keys(bpDraft).length > 0);

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
        setAttrKeyInput('');
        setAttrValInput('');
      } else {
        // Reset para nuevo producto
        setName('');
        setCategory('Abarrotes');
        setBarcode(generatePeruvianEan13());
        setSku('');
        setBrand('');
        setSizeLabel('');
        setExtraBarcodes([]);
        setShowExtraBarcodes(false);
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
        setTierMinQtyStr('');
        setTierPriceStr('');
        setBranchPricesDraft({});
        setShowBranchPricesSection(false);
        setVariants([]);
        setAttributesList([]);
        setAttrKeyInput('');
        setAttrValInput('');
      }
      setScannerActive(false);
      setPresModalOpen(false);
      setEditingPresId(null);
      setVariantModalOpen(false);
      setEditingVariantId(null);
    }
  }, [visible, product, branchId, branches]);

  // Cálculos de márgenes
  const priceVal = parseFloat(priceStr) || 0;
  const costVal = parseFloat(costStr) || 0;
  const minPriceVal = parseFloat(minPriceStr) || 0;

  const marginCalculation = useMemo(() => {
    if (priceVal <= 0) return { profit: 0, pct: 0, status: 'empty' };
    const profit = priceVal - costVal;
    const pct = costVal > 0 ? (profit / costVal) * 100 : 100;
    let status: 'healthy' | 'moderate' | 'loss' = 'healthy';
    if (profit < 0) status = 'loss';
    else if (pct < 15) status = 'moderate';
    return { profit, pct, status };
  }, [priceVal, costVal]);

  const handleGenerateBarcode = () => {
    const ean = generatePeruvianEan13();
    setBarcode(ean);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleStartScanner = async (target: 'main' | number = 'main') => {
    setScanningTarget(target);
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Permiso Requerido', 'Se necesita acceso a la cámara para escanear códigos de barras.');
        return;
      }
    }
    setScannerActive(true);
  };

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    const now = Date.now();
    if (now - lastScanTimestampRef.current < 1000) return;
    lastScanTimestampRef.current = now;

    if (data) {
      const clean = data.trim();
      if (scanningTarget === 'main') {
        setBarcode(clean);
      } else if (typeof scanningTarget === 'number') {
        setExtraBarcodes((prev) => {
          const next = [...prev];
          next[scanningTarget] = clean;
          return next;
        });
      }
      setScannerActive(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [scanningTarget]);

  const handleAddExtraBarcode = () => {
    setExtraBarcodes((prev) => [...prev, '']);
    setShowExtraBarcodes(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemoveExtraBarcode = (index: number) => {
    setExtraBarcodes((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleUpdateExtraBarcode = (index: number, val: string) => {
    setExtraBarcodes((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  const handleGenerateExtraBarcode = (index: number) => {
    const ean = generatePeruvianEan13();
    handleUpdateExtraBarcode(index, ean);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleOpenNewPresentation = () => {
    setEditingPresId(null);
    setPresName('');
    setPresFactor('');
    setPresPrice('');
    setPresBarcode('');
    setPresModalOpen(true);
  };

  const handleOpenEditPresentation = (pres: ProductPresentation) => {
    setEditingPresId(pres.id);
    setPresName(pres.name || '');
    setPresFactor(String(presentationFactor(pres)));
    setPresPrice(String(pres.price ?? ''));
    setPresBarcode(pres.barcode || '');
    setPresModalOpen(true);
  };

  const handleAddPresentation = () => {
    const factorNum = parseFloat(presFactor);
    const priceNum = parseFloat(presPrice);
    if (!presName.trim() || isNaN(factorNum) || factorNum <= 1 || isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Datos Inválidos', 'Ingresa un nombre, factor de unidades mayor a 1 y precio válido.');
      return;
    }

    const updatedPres = normalizePresentationBidirectional({
      id: editingPresId || `pres_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: presName.trim(),
      conversionFactor: factorNum,
      quantity: factorNum,
      price: priceNum,
      barcode: presBarcode.trim() || undefined,
      active: true,
    });

    setPresentations((prev) =>
      editingPresId
        ? prev.map((p) => (p.id === editingPresId ? updatedPres : p))
        : [...prev, updatedPres]
    );
    setEditingPresId(null);
    setPresName('');
    setPresFactor('');
    setPresPrice('');
    setPresBarcode('');
    setPresModalOpen(false);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemovePresentation = (id: string) => {
    setPresentations((prev) => prev.filter((p) => p.id !== id));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleAddPriceTier = () => {
    const minQty = parseFloat(tierMinQtyStr);
    const tierPrice = parseFloat(tierPriceStr);
    if (!Number.isFinite(minQty) || minQty < 2 || !Number.isFinite(tierPrice) || tierPrice <= 0) {
      Alert.alert('Escala inválida', 'Ingresa cantidad mínima (>= 2) y precio unitario mayor a S/ 0.00.');
      return;
    }
    setPriceTiers((prev) => {
      const filtered = prev.filter((t) => Number(t.minQuantity ?? t.minQty) !== minQty);
      return normalizePriceTiers([...filtered, { minQuantity: minQty, minQty, unitPrice: tierPrice, price: tierPrice }]);
    });
    setTierMinQtyStr('');
    setTierPriceStr('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemovePriceTier = (index: number) => {
    setPriceTiers((prev) => prev.filter((_, i) => i !== index));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const syncBranchStockFromVariants = (nextVariants: ProductVariant[]) => {
    if (nextVariants.length === 0) return;
    const sum = nextVariants.reduce((acc, v) => acc + (Number(v.stock?.[branchId] ?? 0) || 0), 0);
    setStockStr(String(sum));
    setStockByBranch((prev) => ({ ...prev, [branchId]: sum }));
  };

  const handleOpenNewVariant = () => {
    setEditingVariantId(null);
    setVarName('');
    setVarSize('');
    setVarColorHex('#111827');
    setVarSku('');
    setVarBarcode('');
    setVarPriceAdjStr('');
    setVarStockStr('0');
    setVariantModalOpen(true);
  };

  const handleOpenEditVariant = (v: ProductVariant) => {
    setEditingVariantId(v.id);
    setVarName(v.name || '');
    setVarSize(v.sizeLabel || '');
    setVarColorHex(v.colorHex || '#111827');
    setVarSku(v.sku || '');
    setVarBarcode(v.barcode || '');
    setVarPriceAdjStr(v.priceAdjustment !== undefined ? String(v.priceAdjustment) : '');
    setVarStockStr(String(v.stock?.[branchId] ?? 0));
    setVariantModalOpen(true);
  };

  const handleSaveVariant = () => {
    if (!varName.trim()) {
      Alert.alert('Variante requerida', 'Ingresa un nombre para la variante (ej. Rojo / Talla M).');
      return;
    }
    const vStockNum = Math.max(0, parseFloat(varStockStr) || 0);
    const adjNum = parseFloat(varPriceAdjStr) || 0;
    const existing = editingVariantId ? variants.find((v) => v.id === editingVariantId) : undefined;
    const nextVariant: ProductVariant = {
      ...(existing || {}),
      id: editingVariantId || `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: varName.trim(),
      sizeLabel: varSize.trim() || undefined,
      colorHex: varColorHex || undefined,
      sku: varSku.trim() || undefined,
      barcode: varBarcode.trim() || undefined,
      priceAdjustment: adjNum !== 0 ? adjNum : undefined,
      stock: {
        ...(existing?.stock || {}),
        [branchId]: vStockNum,
      },
    };
    const nextList = editingVariantId
      ? variants.map((v) => (v.id === editingVariantId ? nextVariant : v))
      : [...variants, nextVariant];
    setVariants(nextList);
    syncBranchStockFromVariants(nextList);
    setVariantModalOpen(false);
    setEditingVariantId(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemoveVariant = (variantId: string) => {
    const nextList = variants.filter((v) => v.id !== variantId);
    setVariants(nextList);
    syncBranchStockFromVariants(nextList);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleAddAttribute = () => {
    const k = attrKeyInput.trim();
    const v = attrValInput.trim();
    if (!k || !v) {
      Alert.alert('Atributo incompleto', 'Ingresa tanto el nombre como el valor del atributo.');
      return;
    }
    setAttributesList((prev) => {
      const idx = prev.findIndex((item) => item.key.toLowerCase() === k.toLowerCase());
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { key: k, value: v };
        return next;
      }
      return [...prev, { key: k, value: v }];
    });
    setAttrKeyInput('');
    setAttrValInput('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleRemoveAttribute = (idx: number) => {
    setAttributesList((prev) => prev.filter((_, i) => i !== idx));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleSave = async () => {
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

      const resolvedGallery: string[] = [];
      let uploadedIdx = 0;
      for (const uri of galleryImages) {
        if (isLocalFileUri(uri)) {
          uploadedIdx += 1;
          setUploadStatus(`Subiendo imagen ${uploadedIdx} de ${localCount}...`);
          const remoteUrl = await uploadProductImageToStorage(
            uri,
            effectiveAccountId,
            product?.id
          );
          resolvedGallery.push(remoteUrl);
        } else if (uri) {
          resolvedGallery.push(uri);
        }
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
        {scannerActive ? (
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

          {/* Galería de Imágenes (Subida automática a Firebase Storage) */}
          <View style={styles.formGroup}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>
                Imágenes ({galleryImages.length}/{MAX_GALLERY_IMAGES})
              </Text>
              <View style={styles.galleryActionsRow}>
                <TouchableOpacity
                  onPress={handleTakePhoto}
                  style={styles.pillActionBtn}
                  disabled={galleryImages.length >= MAX_GALLERY_IMAGES}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Tomar foto del producto"
                >
                  <Camera size={13} color={ui.primary} />
                  <Text style={styles.pillActionText}>Cámara</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handlePickImage}
                  style={styles.pillActionBtn}
                  disabled={galleryImages.length >= MAX_GALLERY_IMAGES}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Elegir fotos de galería"
                >
                  <ImagePlus size={13} color={ui.primary} />
                  <Text style={styles.pillActionText}>Galería</Text>
                </TouchableOpacity>
              </View>
            </View>
            {galleryImages.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.galleryStrip}
              >
                {galleryImages.map((uri, idx) => (
                  <View key={`${uri}-${idx}`} style={styles.galleryCard}>
                    <TouchableOpacity
                      onPress={() => handleSetMainImage(idx)}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityLabel={idx === 0 ? 'Imagen principal' : 'Marcar como principal'}
                    >
                      <Image source={{ uri }} style={styles.galleryThumb} contentFit="cover" />
                      {idx === 0 ? (
                        <View style={styles.galleryMainBadge}>
                          <Star size={10} color={ui.onPrimary} />
                          <Text style={styles.galleryMainBadgeText}>Principal</Text>
                        </View>
                      ) : (
                        <View style={styles.gallerySetMainTag}>
                          <Text style={styles.gallerySetMainTagText}>Principal</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleRemoveImage(idx)}
                      style={styles.galleryRemoveBtn}
                      accessibilityRole="button"
                      accessibilityLabel="Eliminar imagen"
                    >
                      <X size={12} color={ui.onPrimary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.galleryEmptyHint}>
                Sin imágenes. La primera foto será la portada en el POS.
              </Text>
            )}
          </View>

          {/* 2. Código de Barras + EAN-13 Generator */}
          <View style={styles.formGroup}>
            <View style={[styles.labelRow, compactLayout && styles.labelRowCompact]}>
              <Text style={styles.label}>Código de Barras (EAN-13 / SKU)</Text>
              <TouchableOpacity
                onPress={handleGenerateBarcode}
                style={styles.pillActionBtn}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Generar código EAN-13 de Perú"
              >
                <Shuffle size={13} color={ui.primary} />
                <Text style={styles.pillActionText}>EAN-13 Perú (775)</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.inputWithActionsRow}>
              <View style={styles.inputIconPrefix}>
                <Barcode size={18} color={ui.textSecondary} />
              </View>
              <TextInput
                style={[styles.input, styles.inputFlex]}
                value={barcode}
                onChangeText={setBarcode}
                accessibilityLabel="Código de barras del producto"
                placeholder="775XXXXXXXXXX"
                keyboardType="numeric"
                placeholderTextColor={ui.textMuted}
              />
              <TouchableOpacity
                style={styles.cameraScanBtn}
                onPress={() => handleStartScanner('main')}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Escanear código de barras con la cámara"
              >
                <Camera size={18} color={ui.text} />
              </TouchableOpacity>
            </View>

            {/* Selector opcional desplegable: Códigos de Barras Adicionales */}
            <View style={styles.extraBarcodesContainer}>
              <TouchableOpacity
                style={styles.extraBarcodesToggleBtn}
                onPress={() => setShowExtraBarcodes(!showExtraBarcodes)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Mostrar u ocultar códigos de barras adicionales"
              >
                <View style={styles.extraBarcodesToggleLeft}>
                  <Barcode size={15} color={ui.primary} />
                  <Text style={styles.extraBarcodesToggleText}>
                    {extraBarcodes.length > 0
                      ? `Códigos adicionales (${extraBarcodes.length})`
                      : '+ Código de barras adicional (opcional)'}
                  </Text>
                </View>
                {showExtraBarcodes ? (
                  <ChevronUp size={16} color={ui.primary} />
                ) : (
                  <ChevronDown size={16} color={ui.textSecondary} />
                )}
              </TouchableOpacity>

              {showExtraBarcodes && (
                <View style={styles.extraBarcodesCard}>
                  {extraBarcodes.length === 0 ? (
                    <Text style={styles.extraBarcodesEmptyText}>
                      Agrega códigos de barra alternativos (ej. packs, códigos de proveedor o presentaciones).
                    </Text>
                  ) : (
                    extraBarcodes.map((altCode, idx) => (
                      <View key={idx} style={styles.extraBarcodeItem}>
                        <View style={styles.inputWithActionsRow}>
                          <View style={styles.inputIconPrefix}>
                            <Barcode size={16} color={ui.textMuted} />
                          </View>
                          <TextInput
                            style={[styles.input, styles.inputFlex]}
                            value={altCode}
                            onChangeText={(text) => handleUpdateExtraBarcode(idx, text)}
                            placeholder={`Código adicional ${idx + 1}`}
                            placeholderTextColor={ui.textMuted}
                            keyboardType="numeric"
                          />
                          <TouchableOpacity
                            style={styles.pillActionBtnMini}
                            onPress={() => handleGenerateExtraBarcode(idx)}
                            activeOpacity={0.7}
                            accessibilityLabel="Generar EAN-13"
                          >
                            <Shuffle size={13} color={ui.primary} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.cameraScanBtn}
                            onPress={() => handleStartScanner(idx)}
                            activeOpacity={0.7}
                            accessibilityLabel="Escanear con cámara"
                          >
                            <Camera size={16} color={ui.text} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.extraBarcodeDeleteBtn}
                            onPress={() => handleRemoveExtraBarcode(idx)}
                            activeOpacity={0.7}
                            accessibilityLabel="Eliminar código adicional"
                          >
                            <Trash2 size={16} color={ui.danger} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))
                  )}

                  <TouchableOpacity
                    style={styles.addExtraBarcodeBtn}
                    onPress={handleAddExtraBarcode}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Agregar otro código de barras"
                  >
                    <Plus size={14} color={ui.primary} />
                    <Text style={styles.addExtraBarcodeBtnText}>Agregar otro código de barras</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>

          {/* 3. SKU Interno y Categoría */}
          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>SKU Interno</Text>
              <TextInput
                style={styles.input}
                value={sku}
                onChangeText={setSku}
                accessibilityLabel="SKU interno"
                placeholder="Opcional"
                placeholderTextColor={ui.textMuted}
                autoCapitalize="characters"
              />
            </View>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>Categoría</Text>
              <TextInput
                style={styles.input}
                value={category}
                onChangeText={setCategory}
                accessibilityLabel="Categoría del producto"
                placeholder="Categoría"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>

          {/* Categorías Rápidas */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.catChipsScroll}
            contentContainerStyle={styles.catChipsContent}
            keyboardShouldPersistTaps="handled"
          >
            {COMMON_CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.catChip,
                  category.toLowerCase() === cat.toLowerCase() && styles.catChipActive,
                ]}
                onPress={() => setCategory(cat)}
                accessibilityRole="button"
                accessibilityState={{ selected: category.toLowerCase() === cat.toLowerCase() }}
                accessibilityLabel={`Seleccionar categoría ${cat}`}
              >
                <Text
                  style={[
                    styles.catChipText,
                    category.toLowerCase() === cat.toLowerCase() && styles.catChipTextActive,
                  ]}
                >
                  {cat}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* 4. Marca y Medida / Talla (SOLO SI LA CUENTA LO TIENE HABILITADO) */}
          {enableCatalogFilters && (
            <View style={styles.catalogFiltersSection}>
              <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
                <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                  <View style={styles.labelRow}>
                    <Tag size={13} color={ui.primary} />
                    <Text style={styles.label}>Marca (Opcional)</Text>
                  </View>
                  <TextInput
                    style={styles.input}
                    value={brand}
                    onChangeText={setBrand}
                    placeholder="Ej. Vargas, Gloria"
                    placeholderTextColor={ui.textMuted}
                  />
                  {/* Chips rápidos de marcas populares */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.miniChipsScroll}
                    contentContainerStyle={styles.miniChipsContent}
                    keyboardShouldPersistTaps="handled"
                  >
                    {DEFAULT_CATALOG_BRANDS.slice(0, 6).map((b) => (
                      <TouchableOpacity
                        key={b}
                        style={[styles.miniChip, brand.toLowerCase() === b.toLowerCase() && styles.miniChipActive]}
                        onPress={() => setBrand(b)}
                      >
                        <Text style={[styles.miniChipText, brand.toLowerCase() === b.toLowerCase() && styles.miniChipTextActive]}>
                          {b}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>

                <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                  <View style={styles.labelRow}>
                    <Ruler size={13} color={ui.primary} />
                    <Text style={styles.label}>Medidas / Tallas (Opcional)</Text>
                  </View>
                  <TextInput
                    style={styles.input}
                    value={sizeLabel}
                    onChangeText={setSizeLabel}
                    placeholder="Separa con comas: S, M, L"
                    placeholderTextColor={ui.textMuted}
                  />
                  {/* Chips rápidos de medidas */}
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.miniChipsScroll}
                    contentContainerStyle={styles.miniChipsContent}
                    keyboardShouldPersistTaps="handled"
                  >
                    {['750 ml', '1 Litro', '500 gr', 'Pack', '2 Plazas', 'Estándar'].map((s) => (
                      <TouchableOpacity
                        key={s}
                        style={[styles.miniChip, sizeLabel.toLowerCase() === s.toLowerCase() && styles.miniChipActive]}
                        onPress={() => setSizeLabel(s)}
                      >
                        <Text style={[styles.miniChipText, sizeLabel.toLowerCase() === s.toLowerCase() && styles.miniChipTextActive]}>
                          {s}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              </View>
            </View>
          )}

          {/* 5. Unidad de Medida SUNAT + Decimales + IGV */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>Unidad de Medida (Estándar SUNAT)</Text>
            <View style={styles.unitsGrid}>
              {UNITS.map((u) => {
                const isSelected = unitOfMeasure === u.code;
                return (
                  <TouchableOpacity
                    key={u.code}
                    style={[styles.unitCard, isSelected && styles.unitCardSelected]}
                    onPress={() => {
                      setUnitOfMeasure(u.code);
                      if (['KGM', 'LTR', 'g', 'm'].includes(u.code)) {
                        setAllowDecimals(true);
                      }
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={`${u.label}. ${u.desc}`}
                  >
                    <Text
                      style={[styles.unitCodeText, isSelected && styles.unitCodeTextSelected]}
                    >
                      {u.label}
                    </Text>
                    <Text style={styles.unitDescText}>{u.desc}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.toggleRowCard}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={styles.toggleRowTitle}>Permitir cantidades decimales / peso</Text>
              <Text style={styles.toggleRowSubtitle}>
                Activa para vender fracciones (ej. 0.250 kg o 1.5 lt) en el POS.
              </Text>
            </View>
            <Switch
              value={allowDecimals}
              onValueChange={setAllowDecimals}
              trackColor={{ false: ui.border, true: ui.primarySoft }}
              thumbColor={allowDecimals ? ui.primary : ui.surface}
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Afectación IGV (SUNAT)</Text>
            <View style={styles.taxGrid}>
              {TAX_CODES.map((tc) => {
                const isSelected = taxExemptionCode === tc.code;
                return (
                  <TouchableOpacity
                    key={tc.code}
                    style={[styles.taxChip, isSelected && styles.taxChipSelected]}
                    onPress={() => setTaxExemptionCode(tc.code)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text style={[styles.taxChipLabel, isSelected && styles.taxChipLabelSelected]}>
                      {tc.label}
                    </Text>
                    <Text style={styles.taxChipDesc}>{tc.desc}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <SectionHeading title="Precios" subtitle="Venta, costo, escalas y margen estimado." />

          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>
                Precio Venta (S/) <Text style={styles.required}>*</Text>
              </Text>
              <TextInput
                style={[styles.input, styles.priceInputHighlight]}
                value={priceStr}
                onChangeText={setPriceStr}
                accessibilityLabel="Precio de venta en soles, obligatorio"
                placeholder="0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>Precio Mínimo (S/)</Text>
              <TextInput
                style={styles.input}
                value={minPriceStr}
                onChangeText={setMinPriceStr}
                accessibilityLabel="Precio mínimo de venta en soles"
                placeholder="Piso de venta"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
          </View>

          <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
            <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
              <Text style={styles.label}>Costo Compra (S/)</Text>
              <TextInput
                style={styles.input}
                value={costStr}
                onChangeText={setCostStr}
                accessibilityLabel="Costo de compra en soles"
                placeholder="0.00"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
            </View>
            {canViewMargins ? (
              <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                <Text style={styles.label}>Margen Estimado</Text>
                <View
                  style={[
                    styles.marginBadge,
                    marginCalculation.status === 'healthy' && styles.marginBadgeGreen,
                    marginCalculation.status === 'moderate' && styles.marginBadgeAmber,
                    marginCalculation.status === 'loss' && styles.marginBadgeRed,
                  ]}
                >
                  <Percent size={14} color={ui.text} />
                  <Text style={styles.marginBadgeText}>
                    {marginCalculation.pct.toFixed(1)}% (S/ {marginCalculation.profit.toFixed(2)})
                  </Text>
                </View>
              </View>
            ) : null}
          </View>

          {/* Precios por Volumen / Mayoreo */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionCardTitle}>Precios por Volumen (Opcional)</Text>
            <View style={styles.inlineAddRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={tierMinQtyStr}
                onChangeText={setTierMinQtyStr}
                placeholder="Mín. cant. (ej. 6)"
                keyboardType="numeric"
                placeholderTextColor={ui.textMuted}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={tierPriceStr}
                onChangeText={setTierPriceStr}
                placeholder="Precio c/u (S/)"
                keyboardType="decimal-pad"
                placeholderTextColor={ui.textMuted}
              />
              <TouchableOpacity
                style={styles.inlineAddBtn}
                onPress={handleAddPriceTier}
                accessibilityRole="button"
                accessibilityLabel="Agregar escala de precio"
              >
                <Plus size={18} color={ui.onPrimary} />
              </TouchableOpacity>
            </View>
            {priceTiers.length > 0 && (
              <View style={{ marginTop: 8, gap: 6 }}>
                {priceTiers.map((tier, idx) => (
                  <View key={`${tier.minQuantity}-${idx}`} style={styles.presItemCard}>
                    <Text style={styles.presItemDetails}>
                      Desde <Text style={{ fontWeight: '700', color: ui.text }}>{tier.minQuantity}</Text> u.:{' '}
                      <Text style={{ fontWeight: '700', color: ui.primary }}>
                        S/ {Number(tier.unitPrice ?? tier.price).toFixed(2)}
                      </Text>{' '}
                      c/u
                    </Text>
                    <TouchableOpacity onPress={() => handleRemovePriceTier(idx)} style={styles.presDeleteBtn}>
                      <Trash2 size={15} color={ui.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Precios diferenciados por sucursal */}
          {branches && branches.length > 1 ? (
            <View style={styles.sectionCard}>
              <TouchableOpacity
                style={styles.collapsibleHeader}
                onPress={() => setShowBranchPricesSection((v) => !v)}
              >
                <Text style={styles.sectionCardTitle}>Precios por Sucursal (Opcional)</Text>
                {showBranchPricesSection ? (
                  <ChevronUp size={18} color={ui.textSecondary} />
                ) : (
                  <ChevronDown size={18} color={ui.textSecondary} />
                )}
              </TouchableOpacity>
              {showBranchPricesSection && (
                <View style={{ marginTop: 10, gap: 10 }}>
                  {branches.map((b, idx) => {
                    const bId = b.id || `branch_${idx}`;
                    const current = branchPricesDraft[bId] || {
                      suggestedPrice: '',
                      costPrice: '',
                      minSalePrice: '',
                    };
                    return (
                      <View key={bId} style={styles.branchPriceCard}>
                        <Text style={styles.branchStockName}>{b.name || bId}</Text>
                        <View style={styles.branchPriceInputsRow}>
                          <TextInput
                            style={[styles.input, { flex: 1 }]}
                            placeholder={`Venta (${priceStr || 'base'})`}
                            keyboardType="decimal-pad"
                            placeholderTextColor={ui.textMuted}
                            value={current.suggestedPrice}
                            onChangeText={(txt) =>
                              setBranchPricesDraft((prev) => ({
                                ...prev,
                                [bId]: { ...current, suggestedPrice: txt },
                              }))
                            }
                          />
                          <TextInput
                            style={[styles.input, { flex: 1 }]}
                            placeholder={`Mín (${minPriceStr || 'base'})`}
                            keyboardType="decimal-pad"
                            placeholderTextColor={ui.textMuted}
                            value={current.minSalePrice}
                            onChangeText={(txt) =>
                              setBranchPricesDraft((prev) => ({
                                ...prev,
                                [bId]: { ...current, minSalePrice: txt },
                              }))
                            }
                          />
                          <TextInput
                            style={[styles.input, { flex: 1 }]}
                            placeholder={`Costo (${costStr || 'base'})`}
                            keyboardType="decimal-pad"
                            placeholderTextColor={ui.textMuted}
                            value={current.costPrice}
                            onChangeText={(txt) =>
                              setBranchPricesDraft((prev) => ({
                                ...prev,
                                [bId]: { ...current, costPrice: txt },
                              }))
                            }
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          <SectionHeading title="Inventario" subtitle="Existencias actuales y alerta de reposición." />
          {variants.length > 0 && (
            <View style={styles.infoBanner}>
              <Text style={styles.infoBannerText}>
                Este producto tiene variantes. El stock de la sucursal activa se calcula sumando tus variantes ({stockStr} u.).
              </Text>
            </View>
          )}
          {branches && branches.length > 1 ? (
            <View style={styles.formGroup}>
              <Text style={styles.label}>Stock por Sucursal ({unitOfMeasure})</Text>
              <View style={styles.branchStockList}>
                {branches.map((b, idx) => {
                  const bId = b.id || `branch_${idx}`;
                  return (
                    <View key={bId} style={styles.branchStockRow}>
                      <Text style={styles.branchStockName} numberOfLines={1}>
                        {b.name || 'Sucursal'}
                      </Text>
                      <TextInput
                        style={styles.branchStockInput}
                        value={stockByBranch[bId] !== undefined ? String(stockByBranch[bId]) : ''}
                        onChangeText={(val) => {
                          const num = parseFloat(val) || 0;
                          setStockByBranch((prev) => ({ ...prev, [bId]: num }));
                        }}
                        editable={!(variants.length > 0 && bId === branchId)}
                        keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                        placeholder="0"
                        placeholderTextColor={ui.textMuted}
                      />
                    </View>
                  );
                })}
              </View>
              <View style={[styles.formGroup, { marginTop: 10 }]}>
                <Text style={styles.label}>Alerta Stock Mínimo</Text>
                <TextInput
                  style={styles.input}
                  value={minStockStr}
                  onChangeText={setMinStockStr}
                  accessibilityLabel="Alerta de stock mínimo"
                  placeholder="3"
                  keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                  placeholderTextColor={ui.textMuted}
                />
              </View>
            </View>
          ) : (
            <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
              <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                <Text style={styles.label}>Stock Actual ({unitOfMeasure})</Text>
                <TextInput
                  style={[styles.input, variants.length > 0 && styles.inputReadonly]}
                  value={stockStr}
                  onChangeText={setStockStr}
                  editable={variants.length === 0}
                  accessibilityLabel={`Stock actual en ${unitOfMeasure}`}
                  placeholder="0"
                  keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                  placeholderTextColor={ui.textMuted}
                />
              </View>
              <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                <Text style={styles.label}>Alerta Stock Mínimo</Text>
                <TextInput
                  style={styles.input}
                  value={minStockStr}
                  onChangeText={setMinStockStr}
                  accessibilityLabel="Alerta de stock mínimo"
                  placeholder="3"
                  keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                  placeholderTextColor={ui.textMuted}
                />
              </View>
            </View>
          )}

          <SectionHeading
            title="Presentaciones"
            subtitle="Packs y cajas con cantidades y precios propios."
            action={(
              <TouchableOpacity
                style={styles.addPresBtn}
                onPress={handleOpenNewPresentation}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Agregar presentación adicional"
              >
                <Plus size={16} color={ui.onPrimary} />
                <Text style={styles.addPresBtnText}>Agregar</Text>
              </TouchableOpacity>
            )}
          />

          {presentations.length === 0 ? (
            <View style={styles.emptyPresCard}>
              <Layers size={22} color={ui.textMuted} />
              <Text style={styles.emptyPresText}>
                No hay presentaciones adicionales. Se venderá en su unidad base ({unitOfMeasure}).
              </Text>
            </View>
          ) : (
            <View style={styles.presList}>
              {presentations.map((p) => (
                <View key={p.id} style={styles.presItemCard}>
                  <View style={styles.presItemInfo}>
                    <Text style={styles.presItemName}>{p.name}</Text>
                    <Text style={styles.presItemDetails}>
                      Factor: {presentationFactor(p)} unidades | Precio: S/ {p.price.toFixed(2)}
                      {p.barcode ? ` | Código: ${p.barcode}` : ''}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity
                      onPress={() => handleOpenEditPresentation(p)}
                      style={styles.presEditBtn}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`Editar presentación ${p.name}`}
                    >
                      <Edit2 size={15} color={ui.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleRemovePresentation(p.id)}
                      style={styles.presDeleteBtn}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`Eliminar presentación ${p.name}`}
                    >
                      <Trash2 size={16} color={ui.danger} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Variantes (Tallas / Colores / Sabores) */}
          <SectionHeading
            title="Variantes"
            subtitle="Opciones de talla, color o sabor con stock independiente."
            action={(
              <TouchableOpacity
                style={styles.addPresBtn}
                onPress={handleOpenNewVariant}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Agregar variante"
              >
                <Plus size={16} color={ui.onPrimary} />
                <Text style={styles.addPresBtnText}>Variante</Text>
              </TouchableOpacity>
            )}
          />
          {variants.length === 0 ? (
            <View style={styles.emptyPresCard}>
              <Package size={20} color={ui.textMuted} />
              <Text style={styles.emptyPresText}>
                Sin variantes configuradas. Se manejará stock único del producto.
              </Text>
            </View>
          ) : (
            <View style={styles.presList}>
              {variants.map((v) => {
                const vBranchStock = Number(v.stock?.[branchId] ?? 0);
                return (
                  <View key={v.id} style={styles.presItemCard}>
                    {v.colorHex ? (
                      <View style={[styles.variantDot, { backgroundColor: v.colorHex }]} />
                    ) : null}
                    <View style={styles.presItemInfo}>
                      <Text style={styles.presItemName}>
                        {v.name}
                        {v.sizeLabel ? ` (${v.sizeLabel})` : ''}
                      </Text>
                      <Text style={styles.presItemDetails}>
                        Stock ({branchId}): {vBranchStock}
                        {v.priceAdjustment
                          ? ` • Ajuste: ${v.priceAdjustment >= 0 ? '+' : ''}S/ ${v.priceAdjustment.toFixed(2)}`
                          : ''}
                        {v.sku ? ` • SKU: ${v.sku}` : ''}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        onPress={() => handleOpenEditVariant(v)}
                        style={styles.presEditBtn}
                      >
                        <Edit2 size={15} color={ui.primary} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleRemoveVariant(v.id)}
                        style={styles.presDeleteBtn}
                      >
                        <Trash2 size={15} color={ui.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Atributos / Especificaciones Técnicas */}
          <View style={[styles.sectionCard, { marginTop: 16 }]}>
            <Text style={styles.sectionCardTitle}>Atributos Técnicos (Opcional)</Text>
            <View style={styles.inlineAddRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={attrKeyInput}
                onChangeText={setAttrKeyInput}
                placeholder="Ej. Material"
                placeholderTextColor={ui.textMuted}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={attrValInput}
                onChangeText={setAttrValInput}
                placeholder="Ej. Algodón"
                placeholderTextColor={ui.textMuted}
              />
              <TouchableOpacity style={styles.inlineAddBtn} onPress={handleAddAttribute}>
                <Plus size={18} color={ui.onPrimary} />
              </TouchableOpacity>
            </View>
            {attributesList.length > 0 && (
              <View style={{ marginTop: 8, gap: 6 }}>
                {attributesList.map((attr, idx) => (
                  <View key={`${attr.key}-${idx}`} style={styles.presItemCard}>
                    <Text style={styles.presItemDetails}>
                      <Text style={{ fontWeight: '700', color: ui.text }}>{attr.key}:</Text> {attr.value}
                    </Text>
                    <TouchableOpacity onPress={() => handleRemoveAttribute(idx)} style={styles.presDeleteBtn}>
                      <Trash2 size={15} color={ui.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </View>

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

        {/* Modal Secundario para Crear / Editar Presentación */}
        <Modal
          visible={presModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setPresModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <Text style={styles.subModalTitle}>
                  {editingPresId ? 'Editar Presentación' : 'Nueva Presentación'}
                </Text>
                <TouchableOpacity
                  onPress={() => setPresModalOpen(false)}
                  style={styles.closeBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar presentación"
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Nombre de Presentación</Text>
                <TextInput
                  style={styles.input}
                  value={presName}
                  onChangeText={setPresName}
                  accessibilityLabel="Nombre de la presentación"
                  placeholder="Ej. Pack x6 o Caja x12"
                  placeholderTextColor={ui.textMuted}
                />
              </View>

              <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
                <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                  <Text style={styles.label}>Unidades Contenidas</Text>
                  <TextInput
                    style={styles.input}
                    value={presFactor}
                    onChangeText={setPresFactor}
                    accessibilityLabel="Unidades contenidas en la presentación"
                    placeholder="Ej. 6"
                    keyboardType="numeric"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                  <Text style={styles.label}>Precio Especial (S/)</Text>
                  <TextInput
                    style={styles.input}
                    value={presPrice}
                    onChangeText={setPresPrice}
                    accessibilityLabel="Precio especial en soles"
                    placeholder="S/ 0.00"
                    keyboardType="decimal-pad"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Código de Barras Propio (Opcional)</Text>
                <TextInput
                  style={styles.input}
                  value={presBarcode}
                  onChangeText={setPresBarcode}
                  accessibilityLabel="Código de barras propio de la presentación, opcional"
                  placeholder="Código del empaque"
                  placeholderTextColor={ui.textMuted}
                />
              </View>

              <View style={styles.subModalActions}>
                <TouchableOpacity
                  style={styles.subModalCancel}
                  onPress={() => setPresModalOpen(false)}
                  accessibilityRole="button"
                >
                  <Text style={styles.subModalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.subModalConfirm}
                  onPress={handleAddPresentation}
                  accessibilityRole="button"
                >
                  <Check size={16} color={ui.surface} />
                  <Text style={styles.subModalConfirmText}>
                    {editingPresId ? 'Guardar' : 'Agregar'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Modal Secundario para Crear / Editar Variante */}
        <Modal
          visible={variantModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setVariantModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <Text style={styles.subModalTitle}>
                  {editingVariantId ? 'Editar Variante' : 'Nueva Variante'}
                </Text>
                <TouchableOpacity
                  onPress={() => setVariantModalOpen(false)}
                  style={styles.closeBtn}
                >
                  <X size={20} color={ui.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Nombre *</Text>
                <TextInput
                  style={styles.input}
                  value={varName}
                  onChangeText={setVarName}
                  placeholder="Ej. Rojo / Vainilla"
                  placeholderTextColor={ui.textMuted}
                />
              </View>

              <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
                <View style={[styles.formGroup, styles.colFlex]}>
                  <Text style={styles.label}>Talla / Medida</Text>
                  <TextInput
                    style={styles.input}
                    value={varSize}
                    onChangeText={setVarSize}
                    placeholder="Ej. M, L, 500ml"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroup, styles.colFlex]}>
                  <Text style={styles.label}>Stock ({branchId})</Text>
                  <TextInput
                    style={styles.input}
                    value={varStockStr}
                    onChangeText={setVarStockStr}
                    keyboardType={allowDecimals ? 'decimal-pad' : 'numeric'}
                    placeholder="0"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>

              <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
                <View style={[styles.formGroup, styles.colFlex]}>
                  <Text style={styles.label}>Ajuste Precio (S/)</Text>
                  <TextInput
                    style={styles.input}
                    value={varPriceAdjStr}
                    onChangeText={setVarPriceAdjStr}
                    keyboardType="numeric"
                    placeholder="0.00"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
                <View style={[styles.formGroup, styles.colFlex]}>
                  <Text style={styles.label}>SKU Variante</Text>
                  <TextInput
                    style={styles.input}
                    value={varSku}
                    onChangeText={setVarSku}
                    placeholder="Opcional"
                    placeholderTextColor={ui.textMuted}
                  />
                </View>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Código de Barras Variante</Text>
                <TextInput
                  style={styles.input}
                  value={varBarcode}
                  onChangeText={setVarBarcode}
                  placeholder="Opcional"
                  placeholderTextColor={ui.textMuted}
                />
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Color identificador</Text>
                <View style={styles.colorSwatchesRow}>
                  {VARIANT_COLORS.map((hex) => (
                    <TouchableOpacity
                      key={hex}
                      onPress={() => setVarColorHex(hex)}
                      style={[
                        styles.colorSwatchBtn,
                        { backgroundColor: hex },
                        varColorHex === hex && styles.colorSwatchSelected,
                      ]}
                    />
                  ))}
                </View>
              </View>

              <View style={styles.subModalActions}>
                <TouchableOpacity
                  style={styles.subModalCancel}
                  onPress={() => setVariantModalOpen(false)}
                >
                  <Text style={styles.subModalCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.subModalConfirm} onPress={handleSaveVariant}>
                  <Check size={16} color={ui.surface} />
                  <Text style={styles.subModalConfirmText}>
                    {editingVariantId ? 'Guardar' : 'Agregar'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </Modal>
  );
});

const styles = StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: ui.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 48 : 20,
    paddingBottom: 14,
    backgroundColor: ui.surface,
    borderBottomWidth: 1,
    borderBottomColor: ui.border,
  },
  headerTitleRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  headerIconWrapper: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: ui.text,
  },
  headerSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
  },
  closeBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
  },
  scannerWrapper: {
    height: 220,
    backgroundColor: '#000000',
    position: 'relative',
  },
  cameraView: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanTargetBox: {
    width: 240,
    height: 100,
    borderWidth: 2,
    borderColor: ui.primary,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  scanInstruction: {
    color: ui.surface,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  cancelScanBtn: {
    minHeight: 48,
    justifyContent: 'center',
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  cancelScanText: {
    color: ui.surface,
    fontSize: 12,
    fontWeight: '600',
  },
  scrollContent: {
    flex: 1,
  },
  scrollInner: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
  },
  formGroup: {
    marginBottom: 14,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.text,
    marginBottom: 6,
  },
  required: {
    color: ui.danger,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  labelRowCompact: {
    alignItems: 'flex-start',
    flexDirection: 'column',
    gap: 4,
  },
  pillActionBtn: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 12,
  },
  pillActionText: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.primary,
  },
  input: {
    minHeight: 48,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: ui.text,
  },
  inputWithActionsRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  inputIconPrefix: {
    paddingLeft: 12,
  },
  inputFlex: {
    flex: 1,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  cameraScanBtn: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.surfaceMuted,
    borderLeftWidth: 1,
    borderLeftColor: ui.border,
  },
  rowTwoCols: {
    flexDirection: 'row',
    gap: 12,
  },
  rowTwoColsCompact: {
    flexDirection: 'column',
    gap: 0,
  },
  colFlex: {
    flex: 1,
  },
  colFlexCompact: {
    flex: 0,
    width: '100%',
  },
  catChipsScroll: {
    marginTop: -4,
    marginBottom: 14,
  },
  catChipsContent: {
    gap: 6,
  },
  catChip: {
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 10,
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  catChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  catChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: ui.textSecondary,
  },
  catChipTextActive: {
    color: ui.primary,
    fontWeight: '600',
  },
  unitsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  unitCard: {
    width: '48%',
    minHeight: 62,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    padding: 10,
  },
  unitCardSelected: {
    borderColor: ui.primary,
    backgroundColor: ui.primarySoft,
  },
  unitCodeText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  unitCodeTextSelected: {
    color: ui.primary,
  },
  unitDescText: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: ui.border,
    marginVertical: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 2,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: ui.textSecondary,
    marginBottom: 10,
  },
  priceInputHighlight: {
    borderColor: ui.primary,
    backgroundColor: ui.background,
    fontWeight: '700',
    fontSize: 15,
  },
  marginBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: ui.border,
  },
  marginBadgeGreen: {
    backgroundColor: ui.successSoft,
    borderColor: ui.success,
  },
  marginBadgeAmber: {
    backgroundColor: ui.warningSoft,
    borderColor: ui.warningSoft,
  },
  marginBadgeRed: {
    backgroundColor: ui.dangerSoft,
    borderColor: ui.dangerSoft,
  },
  marginBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: ui.text,
  },
  presentationsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  presentationsHeaderRowCompact: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
  },
  addPresBtn: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: ui.primary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
  },
  addPresBtnText: {
    color: ui.surface,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyPresCard: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderStyle: 'dashed',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    gap: 6,
  },
  emptyPresText: {
    fontSize: 12,
    color: ui.textSecondary,
    textAlign: 'center',
  },
  presList: {
    gap: 8,
  },
  presItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    padding: 12,
  },
  presItemInfo: {
    flex: 1,
  },
  presItemName: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.text,
  },
  presItemDetails: {
    fontSize: 12,
    color: ui.textSecondary,
    marginTop: 2,
  },
  presDeleteBtn: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: ui.dangerSoft,
    marginLeft: 8,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    backgroundColor: ui.surface,
    borderTopWidth: 1,
    borderTopColor: ui.border,
  },
  footerCompact: {
    flexDirection: 'column',
    gap: 8,
  },
  footerButtonCompact: {
    flex: 0,
    width: '100%',
  },
  cancelFooterBtn: {
    flex: 1,
    minHeight: 48,
    borderRadius: 10,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelFooterText: {
    fontSize: 14,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  saveFooterBtn: {
    flex: 2,
    minHeight: 48,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveFooterText: {
    fontSize: 14,
    fontWeight: '700',
    color: ui.surface,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  subModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  subModalCard: {
    width: '100%',
    backgroundColor: ui.surface,
    borderRadius: 16,
    padding: 18,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  subModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  subModalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: ui.text,
  },
  subModalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  subModalCancel: {
    flex: 1,
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    alignItems: 'center',
  },
  subModalCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: ui.textSecondary,
  },
  subModalConfirm: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subModalConfirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.surface,
  },
  nameWithImageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputWithImage: {
    flex: 1,
  },
  attachImageBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  attachImageBtnActive: {
    borderColor: ui.primary,
  },
  attachedThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 7,
  },
  imageActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  imageActionText: {
    fontSize: 11,
    color: ui.textSecondary,
  },
  imageRemoveText: {
    fontSize: 11,
    color: ui.danger,
    fontWeight: '600',
  },
  branchStockList: {
    gap: 6,
    marginTop: 4,
  },
  branchStockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ui.surfaceMuted,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: 'space-between',
  },
  branchStockName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: ui.text,
  },
  branchStockInput: {
    width: 90,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  extraBarcodesContainer: {
    marginTop: 8,
  },
  extraBarcodesToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.primarySoft,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  extraBarcodesToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  extraBarcodesToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  extraBarcodesCard: {
    marginTop: 8,
    padding: 10,
    backgroundColor: ui.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 8,
  },
  extraBarcodesEmptyText: {
    fontSize: 11,
    color: ui.textSecondary,
    fontStyle: 'italic',
  },
  extraBarcodeItem: {
    marginBottom: 4,
  },
  pillActionBtnMini: {
    width: 32,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.primarySoft,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: ui.primary,
  },
  extraBarcodeDeleteBtn: {
    width: 34,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.dangerSoft,
    borderRadius: 6,
  },
  addExtraBarcodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    backgroundColor: ui.surfaceMuted,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: ui.border,
    borderStyle: 'dashed',
  },
  addExtraBarcodeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  catalogFiltersSection: {
    backgroundColor: ui.surface,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ui.border,
    marginBottom: 12,
  },
  miniChipsScroll: {
    marginTop: 4,
  },
  miniChipsContent: {
    gap: 6,
  },
  miniChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: ui.surfaceMuted,
    borderWidth: 1,
    borderColor: ui.border,
  },
  miniChipActive: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  miniChipText: {
    fontSize: 10,
    color: ui.textSecondary,
    fontWeight: '500',
  },
  miniChipTextActive: {
    color: ui.primary,
    fontWeight: '700',
  },
  galleryActionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  galleryStrip: {
    gap: 10,
    paddingVertical: 6,
  },
  galleryCard: {
    position: 'relative',
    width: 82,
    height: 82,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: ui.border,
    backgroundColor: ui.surfaceMuted,
  },
  galleryThumb: {
    width: 82,
    height: 82,
  },
  galleryMainBadge: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: ui.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  galleryMainBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: ui.onPrimary,
  },
  gallerySetMainTag: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    backgroundColor: 'rgba(23, 36, 61, 0.72)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
  },
  gallerySetMainTagText: {
    fontSize: 9,
    fontWeight: '600',
    color: ui.onPrimary,
  },
  galleryRemoveBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: ui.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryEmptyHint: {
    fontSize: 12,
    color: ui.textMuted,
    marginTop: 4,
  },
  toggleRowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 14,
  },
  toggleRowTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
  },
  toggleRowSubtitle: {
    fontSize: 11,
    color: ui.textSecondary,
    marginTop: 2,
  },
  taxGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  taxChip: {
    flex: 1,
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  taxChipSelected: {
    backgroundColor: ui.primarySoft,
    borderColor: ui.primary,
  },
  taxChipLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: ui.text,
  },
  taxChipLabelSelected: {
    color: ui.primary,
  },
  taxChipDesc: {
    fontSize: 10,
    color: ui.textMuted,
    marginTop: 2,
  },
  sectionCard: {
    backgroundColor: ui.surface,
    borderWidth: 1,
    borderColor: ui.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  sectionCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: ui.text,
    marginBottom: 8,
  },
  inlineAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineAddBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: ui.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  branchPriceCard: {
    backgroundColor: ui.background,
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: ui.border,
    gap: 6,
  },
  branchPriceInputsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  infoBanner: {
    backgroundColor: ui.primarySoft,
    borderWidth: 1,
    borderColor: ui.primary,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
  },
  infoBannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: ui.primary,
  },
  inputReadonly: {
    backgroundColor: ui.surfaceMuted,
    color: ui.textSecondary,
  },
  presEditBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: ui.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  variantDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: ui.border,
    marginRight: 8,
  },
  colorSwatchesRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  colorSwatchBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ui.border,
  },
  colorSwatchSelected: {
    borderWidth: 3,
    borderColor: ui.primary,
  },
});

export default ProductFormModal;
