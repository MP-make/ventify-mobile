import React, { useState, useEffect, useCallback } from 'react';
import { ActivityIndicator, View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import {
  AlertCircle,
  Barcode,
  Camera,
  ChevronDown,
  ChevronUp,
  Info,
  Plus,
  RefreshCw,
  Shuffle,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react-native';
import { ui } from '@/lib/theme';
import type { GlobalProduct } from '@/services/global-catalog-service';
import { productFormStyles as styles } from './productFormStyles';

interface ExtraBarcodesPanelProps {
  extraBarcodes: string[];
  initialExpanded: boolean;
  formSessionKey: number;
  onAddExtraBarcode: () => void;
  onRemoveExtraBarcode: (index: number) => void;
  onUpdateExtraBarcode: (index: number, val: string) => void;
  onGenerateExtraBarcode: (index: number) => void;
  onStartScanner: (target: 'main' | number) => void;
}

const ExtraBarcodesPanel = React.memo<ExtraBarcodesPanelProps>(({
  extraBarcodes,
  initialExpanded,
  formSessionKey,
  onAddExtraBarcode,
  onRemoveExtraBarcode,
  onUpdateExtraBarcode,
  onGenerateExtraBarcode,
  onStartScanner,
}) => {
  const [showExtraBarcodes, setShowExtraBarcodes] = useState(initialExpanded);

  useEffect(() => {
    setShowExtraBarcodes(initialExpanded);
  }, [formSessionKey, initialExpanded]);

  const handleToggle = useCallback(() => {
    setShowExtraBarcodes((prev) => !prev);
  }, []);

  return (
    <View style={styles.extraBarcodesContainer}>
      <TouchableOpacity
        style={styles.extraBarcodesToggleBtn}
        onPress={handleToggle}
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
                    onChangeText={(text) => onUpdateExtraBarcode(idx, text)}
                    placeholder={`Código adicional ${idx + 1}`}
                    placeholderTextColor={ui.textMuted}
                    keyboardType="numeric"
                  />
                  <TouchableOpacity
                    style={styles.pillActionBtnMini}
                    onPress={() => onGenerateExtraBarcode(idx)}
                    activeOpacity={0.7}
                    accessibilityLabel="Generar EAN-13"
                  >
                    <Shuffle size={13} color={ui.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cameraScanBtn}
                    onPress={() => onStartScanner(idx)}
                    activeOpacity={0.7}
                    accessibilityLabel="Escanear con cámara"
                  >
                    <Camera size={16} color={ui.text} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.extraBarcodeDeleteBtn}
                    onPress={() => onRemoveExtraBarcode(idx)}
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
            onPress={onAddExtraBarcode}
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
  );
});

export interface BarcodeSectionProps {
  barcode: string;
  extraBarcodes: string[];
  compactLayout: boolean;
  initialShowExtraBarcodes: boolean;
  formSessionKey: number;
  isSearchingCatalog: boolean;
  catalogSuggestion: GlobalProduct | null;
  catalogNotice: { type: 'success' | 'info' | 'warning'; text: string } | null;
  duplicateProduct: { name: string; sku?: string } | null;
  onChangeBarcode: (val: string) => void;
  onGenerateBarcode: () => void;
  onManualCatalogSearch: () => void;
  onApplyCatalogSuggestion: () => void;
  onDismissCatalogSuggestion: () => void;
  onDismissCatalogNotice: () => void;
  onStartScanner: (target: 'main' | number) => void;
  onAddExtraBarcode: () => void;
  onRemoveExtraBarcode: (index: number) => void;
  onUpdateExtraBarcode: (index: number, val: string) => void;
  onGenerateExtraBarcode: (index: number) => void;
}

export const BarcodeSection: React.FC<BarcodeSectionProps> = React.memo(({
  barcode,
  extraBarcodes,
  compactLayout,
  initialShowExtraBarcodes,
  formSessionKey,
  isSearchingCatalog,
  catalogSuggestion,
  catalogNotice,
  duplicateProduct,
  onChangeBarcode,
  onGenerateBarcode,
  onManualCatalogSearch,
  onApplyCatalogSuggestion,
  onDismissCatalogSuggestion,
  onDismissCatalogNotice,
  onStartScanner,
  onAddExtraBarcode,
  onRemoveExtraBarcode,
  onUpdateExtraBarcode,
  onGenerateExtraBarcode,
}) => {
  const handleScanMain = useCallback(() => {
    onStartScanner('main');
  }, [onStartScanner]);

  const trimmedBarcode = barcode.trim();
  const canSyncCatalog = trimmedBarcode.length >= 3 && !isSearchingCatalog;

  return (
    <View style={styles.formGroup}>
      <View style={[styles.labelRow, compactLayout && styles.labelRowCompact]}>
        <View style={styles.barcodeLabelGroup}>
          <Text style={[styles.label, { marginBottom: 0 }]}>Código de Barras (EAN-13 / SKU)</Text>
          {isSearchingCatalog && (
            <View style={styles.searchingBadge}>
              <ActivityIndicator size="small" color={ui.primary} />
              <Text style={styles.searchingBadgeText}>Buscando...</Text>
            </View>
          )}
        </View>
        <TouchableOpacity
          onPress={onGenerateBarcode}
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
          onChangeText={onChangeBarcode}
          accessibilityLabel="Código de barras del producto"
          placeholder="Escanear o escribir"
          keyboardType="numeric"
          returnKeyType="search"
          onSubmitEditing={onManualCatalogSearch}
          placeholderTextColor={ui.textMuted}
        />
        <TouchableOpacity
          style={[
            styles.syncCatalogBtn,
            canSyncCatalog && styles.syncCatalogBtnActive,
            !canSyncCatalog && !isSearchingCatalog && styles.syncCatalogBtnDisabled,
          ]}
          onPress={onManualCatalogSearch}
          disabled={!canSyncCatalog}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Sincronizar producto por código de barras"
        >
          {isSearchingCatalog ? (
            <ActivityIndicator size="small" color={ui.primary} />
          ) : (
            <RefreshCw size={18} color={canSyncCatalog ? ui.primary : ui.textMuted} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.cameraScanBtn}
          onPress={handleScanMain}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Escanear código de barras con la cámara"
        >
          <Camera size={18} color={ui.text} />
        </TouchableOpacity>
      </View>

      {duplicateProduct && (
        <View style={styles.duplicateBarcodeBanner} accessibilityRole="alert">
          <AlertCircle size={15} color={ui.danger} />
          <Text style={styles.duplicateBarcodeText}>
            Ya existe en tu inventario: {duplicateProduct.name}
            {duplicateProduct.sku ? ` (SKU ${duplicateProduct.sku})` : ''}.
          </Text>
        </View>
      )}

      {catalogNotice && (
        <View
          style={[
            styles.catalogNoticeBanner,
            catalogNotice.type === 'success'
              ? styles.catalogNoticeSuccess
              : catalogNotice.type === 'warning'
              ? styles.catalogNoticeWarning
              : styles.catalogNoticeInfo,
          ]}
        >
          {catalogNotice.type === 'success' ? (
            <Sparkles size={15} color={ui.success} />
          ) : (
            <Info
              size={15}
              color={catalogNotice.type === 'warning' ? ui.warning : ui.primary}
            />
          )}
          <Text style={styles.catalogNoticeText}>{catalogNotice.text}</Text>
          <TouchableOpacity
            onPress={onDismissCatalogNotice}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Cerrar aviso de sincronización"
          >
            <X size={14} color={ui.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {catalogSuggestion && (
        <View style={styles.catalogSuggestionCard}>
          <View style={styles.catalogSuggestionLeft}>
            {catalogSuggestion.imageUrl ? (
              <Image
                source={{ uri: catalogSuggestion.imageUrl }}
                style={styles.catalogSuggestionThumb}
                contentFit="cover"
                cachePolicy="memory-disk"
                recyclingKey={catalogSuggestion.imageUrl}
              />
            ) : (
              <View style={styles.catalogSuggestionThumbFallback}>
                <Barcode size={18} color={ui.primary} />
              </View>
            )}
            <View style={styles.catalogSuggestionCopy}>
              <Text style={styles.catalogSuggestionTitle} numberOfLines={2}>
                {catalogSuggestion.name}
              </Text>
              <Text style={styles.catalogSuggestionSubtitle} numberOfLines={2}>
                {catalogSuggestion.source === 'openfoodfacts'
                  ? 'Open Food Facts'
                  : 'Catálogo Ventify'}{' '}
                · ¿Sincronizar nombre, imagen y unidad?
              </Text>
            </View>
          </View>
          <View style={styles.catalogSuggestionActions}>
            <TouchableOpacity
              style={styles.catalogSuggestionApplyBtn}
              onPress={onApplyCatalogSuggestion}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Sincronizar datos sugeridos"
            >
              <Text style={styles.catalogSuggestionApplyText}>Sincronizar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.catalogSuggestionDismissBtn}
              onPress={onDismissCatalogSuggestion}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Descartar sugerencia"
            >
              <X size={16} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ExtraBarcodesPanel
        extraBarcodes={extraBarcodes}
        initialExpanded={initialShowExtraBarcodes}
        formSessionKey={formSessionKey}
        onAddExtraBarcode={onAddExtraBarcode}
        onRemoveExtraBarcode={onRemoveExtraBarcode}
        onUpdateExtraBarcode={onUpdateExtraBarcode}
        onGenerateExtraBarcode={onGenerateExtraBarcode}
        onStartScanner={onStartScanner}
      />
    </View>
  );
});
