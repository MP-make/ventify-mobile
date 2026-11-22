import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Barcode, Zap, ZapOff, X } from 'lucide-react-native';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import { ui } from '@/lib/theme';
import { posStyles as styles } from './posStyles';

const BARCODE_SCANNER_SETTINGS: any = {
  barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
};

interface PosInlineScannerCardProps {
  torchOn: boolean;
  onToggleTorch: () => void;
  onClose: () => void;
  onBarcodeScanned: (result: BarcodeScanningResult) => void;
}

/** Inline barcode scanner mounted strictly while the user opens the POS camera preview. */
export const PosInlineScannerCard: React.FC<PosInlineScannerCardProps> = React.memo(
  ({ torchOn, onToggleTorch, onClose, onBarcodeScanned }) => {
    return (
      <View style={styles.inlineScannerCard}>
        <View style={styles.inlineScannerTopBar}>
          <View style={styles.inlineScannerTitleWrap}>
            <Barcode size={16} color={ui.primary} />
            <Text style={styles.inlineScannerTitle}>Escáner de Productos</Text>
          </View>
          <View style={styles.inlineScannerActions}>
            <TouchableOpacity
              style={[styles.inlineScannerActionBtn, torchOn && styles.inlineScannerActionBtnActive]}
              onPress={onToggleTorch}
              accessibilityRole="button"
              accessibilityLabel="Alternar linterna"
            >
              {torchOn ? (
                <ZapOff size={14} color={ui.onPrimary} />
              ) : (
                <Zap size={14} color={ui.textSecondary} />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.inlineScannerActionBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cerrar lector"
            >
              <X size={14} color={ui.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.inlineCameraBox}>
          <CameraView
            style={styles.inlineCamera}
            facing="back"
            enableTorch={torchOn}
            barcodeScannerSettings={BARCODE_SCANNER_SETTINGS}
            onBarcodeScanned={onBarcodeScanned}
          />
          <View style={styles.inlineReticle} />
          <View style={styles.inlineScanBanner}>
            <Text style={styles.inlineScanBannerText}>
              Apunta al código de barras del producto
            </Text>
          </View>
        </View>
      </View>
    );
  }
);
