import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import {
  Edit2,
  Trash2,
  User,
  MapPin,
  CreditCard,
  Phone,
  MessageCircle,
  Mail,
} from 'lucide-react-native';
import { ui } from '@/lib/theme';
import { Supplier } from '@/services/suppliers-po-service';
import { suppliersStyles as styles } from './suppliersStyles';

export interface SupplierCardRowProps {
  supplier: Supplier;
  onEdit: (supplier: Supplier) => void;
  onDelete: (supplier: Supplier) => void;
  onCall: (phone?: string) => void;
  onWhatsApp: (phone?: string, supplierName?: string) => void;
  onEmail: (email?: string, supplierName?: string) => void;
}

export const SupplierCardRow: React.FC<SupplierCardRowProps> = React.memo(({
  supplier,
  onEdit,
  onDelete,
  onCall,
  onWhatsApp,
  onEmail,
}) => {
  const hasPhone = Boolean(String(supplier.phone ?? '').trim());
  const hasEmail = Boolean(String(supplier.email ?? '').trim());

  return (
    <View style={styles.supplierCard}>
      {/* CABECERA DEL PROVEEDOR */}
      <View style={styles.supplierCardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.supplierNameText}>{supplier.name}</Text>
          <View style={styles.supplierBadgesRow}>
            {Boolean(supplier.taxId) && (
              <View style={styles.taxIdBadge}>
                <Text style={styles.taxIdBadgeText}>RUC: {supplier.taxId}</Text>
              </View>
            )}
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryBadgeText}>
                {supplier.category || 'General'}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.supplierHeaderActions}>
          <TouchableOpacity
            style={styles.supplierActionIconBtn}
            onPress={() => onEdit(supplier)}
          >
            <Edit2 size={16} color={ui.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.supplierActionIconBtn, { backgroundColor: ui.dangerSoft }]}
            onPress={() => onDelete(supplier)}
          >
            <Trash2 size={16} color={ui.danger} />
          </TouchableOpacity>
        </View>
      </View>

      {/* INFORMACIÓN DE CONTACTO */}
      {Boolean(supplier.contactName) && (
        <View style={styles.supplierDetailRow}>
          <User size={15} color={ui.textSecondary} />
          <Text style={styles.supplierDetailText}>
            Contacto: <Text style={{ fontWeight: '600' }}>{supplier.contactName}</Text>
          </Text>
        </View>
      )}

      {Boolean(supplier.address) && (
        <View style={styles.supplierDetailRow}>
          <MapPin size={15} color={ui.textSecondary} />
          <Text style={styles.supplierDetailText} numberOfLines={2}>
            {supplier.address}
          </Text>
        </View>
      )}

      {Boolean(supplier.paymentTerms) && (
        <View style={styles.supplierDetailRow}>
          <CreditCard size={15} color={ui.textSecondary} />
          <Text style={styles.supplierDetailText}>
            Condiciones: {supplier.paymentTerms}
          </Text>
        </View>
      )}

      {Boolean(supplier.notes) && (
        <Text style={styles.supplierNotesText} numberOfLines={2}>
          Nota: {supplier.notes}
        </Text>
      )}

      {/* BOTONES DE ACCIÓN RÁPIDA (LLAMADA, WHATSAPP, EMAIL) */}
      <View style={styles.quickContactRow}>
        {hasPhone ? (
          <>
            <TouchableOpacity
              style={styles.contactCallBtn}
              onPress={() => onCall(supplier.phone)}
            >
              <Phone size={15} color={ui.primary} />
              <Text style={styles.contactCallBtnText}>Llamar</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.contactWhatsAppBtn}
              onPress={() => onWhatsApp(supplier.phone, supplier.name)}
            >
              <MessageCircle size={15} color={ui.surface} />
              <Text style={styles.contactWhatsAppBtnText}>WhatsApp</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.noPhoneText}>Sin teléfono registrado</Text>
        )}

        {hasEmail && (
          <TouchableOpacity
            style={styles.contactEmailBtn}
            onPress={() => onEmail(supplier.email, supplier.name)}
          >
            <Mail size={15} color={ui.primary} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});
