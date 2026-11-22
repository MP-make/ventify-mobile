import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Barcode, Shuffle, Camera, ChevronUp, ChevronDown, Trash2, Plus } from 'lucide-react-native';
import { ui } from '@/lib/theme';
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
  onChangeBarcode: (val: string) => void;
  onGenerateBarcode: () => void;
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
  onChangeBarcode,
  onGenerateBarcode,
  onStartScanner,
  onAddExtraBarcode,
  onRemoveExtraBarcode,
  onUpdateExtraBarcode,
  onGenerateExtraBarcode,
}) => {
  const handleScanMain = useCallback(() => {
    onStartScanner('main');
  }, [onStartScanner]);

  return (
    <View style={styles.formGroup}>
      <View style={[styles.labelRow, compactLayout && styles.labelRowCompact]}>
        <Text style={styles.label}>Código de Barras (EAN-13 / SKU)</Text>
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
          placeholder="775XXXXXXXXXX"
          keyboardType="numeric"
          placeholderTextColor={ui.textMuted}
        />
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
