import React, { useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Camera, ImagePlus, Star, X } from 'lucide-react-native';
import { ui } from '@/lib/theme';
import { MAX_GALLERY_IMAGES } from './productFormTypes';
import { productFormStyles as styles } from './productFormStyles';

export interface GallerySectionProps {
  galleryImages: string[];
  onAppendImages: (uris: string[]) => void;
  onSetMainImage: (index: number) => void;
  onRemoveImage: (index: number) => void;
}

export const GallerySection: React.FC<GallerySectionProps> = React.memo(({
  galleryImages,
  onAppendImages,
  onSetMainImage,
  onRemoveImage,
}) => {
  const handlePickImage = useCallback(async () => {
    try {
      const remaining = Math.max(1, MAX_GALLERY_IMAGES - galleryImages.length);
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 0.75,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        onAppendImages(result.assets.map((a) => a.uri));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      Alert.alert('Error', 'No se pudo seleccionar la imagen de la galería.');
    }
  }, [galleryImages.length, onAppendImages]);

  const handleTakePhoto = useCallback(async () => {
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
        onAppendImages([result.assets[0].uri]);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      Alert.alert('Error', 'No se pudo capturar la foto.');
    }
  }, [onAppendImages]);

  const atLimit = galleryImages.length >= MAX_GALLERY_IMAGES;

  return (
    <View style={styles.formGroup}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>
          Imágenes ({galleryImages.length}/{MAX_GALLERY_IMAGES})
        </Text>
        <View style={styles.galleryActionsRow}>
          <TouchableOpacity
            onPress={handleTakePhoto}
            style={styles.pillActionBtn}
            disabled={atLimit}
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
            disabled={atLimit}
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
                onPress={() => onSetMainImage(idx)}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={idx === 0 ? 'Imagen principal' : 'Marcar como principal'}
              >
                <Image
                  source={{ uri }}
                  style={styles.galleryThumb}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={uri}
                />
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
                onPress={() => onRemoveImage(idx)}
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
  );
});
