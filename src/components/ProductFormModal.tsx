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
} from 'lucide-react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ui } from '@/lib/theme';
import { SectionHeading } from '@/components/ui';
import { useSettings } from '@/context/SettingsContext';
import { usePermissions } from '@/hooks/usePermissions';
import { DEFAULT_CATALOG_BRANDS, DEFAULT_CATALOG_SIZES } from '@/lib/catalog-filters';

export interface ProductPresentation {
  id: string;
  name: string;
  conversionFactor: number;
  factor?: number;
  price: number;
  barcode?: string;
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
  price: number;
  minSalePrice: number;
  cost: number;
  stock: number;
  minStock: number;
  presentations: ProductPresentation[];
  imageUrl?: string;
  stockByBranch?: Record<string, number>;
}

interface ProductFormModalProps {
  visible: boolean;
  onClose: () => void;
  product?: any | null;
  onSave?: (productData: ProductFormData) => Promise<void> | void;
  branchId?: string;
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

const UNITS: { code: 'NIU' | 'KGM' | 'LTR' | 'BX'; label: string; desc: string }[] = [
  { code: 'NIU', label: 'Unidad (NIU)', desc: 'Pieza individual' },
  { code: 'KGM', label: 'Kilo (KGM)', desc: 'Venta por peso' },
  { code: 'LTR', label: 'Litro (LTR)', desc: 'Líquidos a granel' },
  { code: 'BX', label: 'Caja (BX)', desc: 'Embalaje por caja' },
];

const BARCODE_SCANNER_CONFIG: any = {
  barcodeTypes: ['ean13', 'ean8', 'qr', 'code128', 'code39', 'upc_a', 'upc_e'],
};

export const ProductFormModal: React.FC<ProductFormModalProps> = React.memo(({
  visible,
  onClose,
  product,
  onSave,
  branchId = 'main',
}) => {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
  const [unitOfMeasure, setUnitOfMeasure] = useState<'NIU' | 'KGM' | 'LTR' | 'BX'>('NIU');
  const [priceStr, setPriceStr] = useState('');
  const [minPriceStr, setMinPriceStr] = useState('');
  const [costStr, setCostStr] = useState('');
  const [stockStr, setStockStr] = useState('0');
  const [minStockStr, setMinStockStr] = useState('3');
  const [presentations, setPresentations] = useState<ProductPresentation[]>([]);
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);
  const [stockByBranch, setStockByBranch] = useState<Record<string, number>>({});

  // Sub-modal de presentación
  const [presModalOpen, setPresModalOpen] = useState(false);
  const [presName, setPresName] = useState('');
  const [presFactor, setPresFactor] = useState('');
  const [presPrice, setPresPrice] = useState('');
  const [presBarcode, setPresBarcode] = useState('');

  // Cámara para escanear código
  const [scannerActive, setScannerActive] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isSaving, setIsSaving] = useState(false);

  const handlePickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setImageUrl(result.assets[0].uri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err: any) {
      Alert.alert('Error', 'No se pudo seleccionar la imagen de la galería.');
    }
  };

  useEffect(() => {
    if (visible) {
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
        setUnitOfMeasure(product.unitOfMeasure || 'NIU');
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
        setMinStockStr(String(product.minStock || 3));
        setPresentations(product.presentations || []);
        setImageUrl(product.imageUrl || product.thumbUrl || undefined);

        if (product.stock && typeof product.stock === 'object') {
          // Mantener solo sucursales asignadas. La ausencia de una clave no es
          // equivalente a stock cero ni debe adscribir el producto a esa sede.
          setStockByBranch({ ...product.stock });
        } else {
          setStockByBranch({ [branchId]: typeof product.stock === 'number' ? product.stock : 0 });
        }
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
        setPriceStr('');
        setMinPriceStr('');
        setCostStr('');
        setStockStr('0');
        setMinStockStr('3');
        setPresentations([]);
        setImageUrl(undefined);

        // Asignar el producto nuevo solo a la sucursal activa. Las demás se
        // agregan cuando el usuario ingresa stock explícitamente.
        setStockByBranch(branchId ? { [branchId]: 0 } : {});
      }
      setScannerActive(false);
      setPresModalOpen(false);
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

  const handleAddPresentation = () => {
    const factorNum = parseFloat(presFactor);
    const priceNum = parseFloat(presPrice);
    if (!presName.trim() || isNaN(factorNum) || factorNum <= 1 || isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Datos Inválidos', 'Ingresa un nombre, factor de unidades mayor a 1 y precio válido.');
      return;
    }

    const newPres: ProductPresentation = {
      id: `pres_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: presName.trim(),
      conversionFactor: factorNum,
      price: priceNum,
      barcode: presBarcode.trim() || undefined,
    };

    setPresentations((prev) => [...prev, newPres]);
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

    const cleanExtraBarcodes = extraBarcodes
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && b !== barcode.trim());

    const payload: ProductFormData = {
      id: product?.id,
      name: name.trim(),
      category: category.trim() || 'General',
      barcode: barcode.trim(),
      barcodes: cleanExtraBarcodes,
      sku: sku.trim() || barcode.trim() || `SKU-${Date.now().toString().slice(-6)}`,
      ...catalogAttributeUpdate(product, enableCatalogFilters, brand, sizeLabel),
      unitOfMeasure,
      price: priceVal,
      minSalePrice: minPriceVal > 0 ? minPriceVal : priceVal,
      cost: costVal,
      stock: branches && branches.length > 1
        ? (stockByBranch[branchId] ?? parseFloat(stockStr) ?? 0)
        : parseFloat(stockStr) || 0,
      minStock: parseFloat(minStockStr) || 3,
      presentations: presentations.map(normalizePresentation),
      imageUrl: imageUrl || product?.imageUrl || '',
      stockByBranch: { ...stockByBranch },
    };

    if (!canManageProducts) {
      Alert.alert('Acceso Denegado', 'No cuentas con permisos para crear o modificar productos.');
      return;
    }

    try {
      setIsSaving(true);
      if (onSave) {
        await onSave(payload);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err: any) {
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
            <View style={styles.nameWithImageRow}>
              <TextInput
                style={[styles.input, styles.inputWithImage]}
                value={name}
                onChangeText={setName}
                accessibilityLabel="Nombre del producto, obligatorio"
                placeholder="Ej. Gaseosa Inca Kola 500ml"
                placeholderTextColor={ui.textMuted}
              />
              <TouchableOpacity
                onPress={handlePickImage}
                style={[styles.attachImageBtn, !!imageUrl && styles.attachImageBtnActive]}
                accessibilityRole="button"
                accessibilityLabel={imageUrl ? 'Cambiar imagen adjunta' : 'Adjuntar imagen'}
                activeOpacity={0.7}
              >
                {imageUrl ? (
                  <Image source={{ uri: imageUrl }} style={styles.attachedThumbnail} contentFit="cover" />
                ) : (
                  <Camera size={18} color={ui.primary} />
                )}
              </TouchableOpacity>
            </View>
            {imageUrl ? (
              <View style={styles.imageActionRow}>
                <Text style={styles.imageActionText}>Foto adjunta</Text>
                <TouchableOpacity onPress={() => setImageUrl(undefined)}>
                  <Text style={styles.imageRemoveText}>Quitar</Text>
                </TouchableOpacity>
              </View>
            ) : null}
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

          {/* 5. Unidad de Medida SUNAT */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>Unidad de Medida (Estándar SUNAT)</Text>
            <View style={styles.unitsGrid}>
              {UNITS.map((u) => {
                const isSelected = unitOfMeasure === u.code;
                return (
                  <TouchableOpacity
                    key={u.code}
                    style={[styles.unitCard, isSelected && styles.unitCardSelected]}
                    onPress={() => setUnitOfMeasure(u.code)}
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

          <SectionHeading title="Precios" subtitle="Venta, costo y margen estimado." />

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
          </View>

          <SectionHeading title="Inventario" subtitle="Existencias actuales y alerta de reposición." />
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
                        keyboardType="numeric"
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
                  keyboardType="numeric"
                  placeholderTextColor={ui.textMuted}
                />
              </View>
            </View>
          ) : (
            <View style={[styles.rowTwoCols, compactLayout && styles.rowTwoColsCompact]}>
              <View style={[styles.formGroup, styles.colFlex, compactLayout && styles.colFlexCompact]}>
                <Text style={styles.label}>Stock Actual ({unitOfMeasure})</Text>
                <TextInput
                  style={styles.input}
                  value={stockStr}
                  onChangeText={setStockStr}
                  accessibilityLabel={`Stock actual en ${unitOfMeasure}`}
                  placeholder="0"
                  keyboardType="numeric"
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
                  keyboardType="numeric"
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
                onPress={() => setPresModalOpen(true)}
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
              ))}
            </View>
          )}

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
              <ActivityIndicator color={ui.surface} size="small" />
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

        {/* Modal Secundario para Crear Presentación */}
        <Modal
          visible={presModalOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setPresModalOpen(false)}
        >
          <View style={styles.subModalOverlay}>
            <View style={styles.subModalCard}>
              <View style={styles.subModalHeader}>
                <Text style={styles.subModalTitle}>Nueva Presentación</Text>
                <TouchableOpacity
                  onPress={() => setPresModalOpen(false)}
                  style={styles.closeBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Cerrar nueva presentación"
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
                  <Text style={styles.subModalConfirmText}>Agregar</Text>
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
});

export default ProductFormModal;
