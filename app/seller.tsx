import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { BrandLogo, SectionHeading } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { ui, formatPEN, formatDatePE } from '@/lib/theme';
import { sellerPresetDates, type SellerPreset } from '@/lib/seller-dates';
import { fetchSellerMetadata, fetchSellerPerformance, type SellerMetadata, type SellerOwnReport } from '@/services/seller-report-service';

type RecentSaleItem = SellerOwnReport['recentSales'][number];

const SellerSaleRow = React.memo(({ sale }: { sale: RecentSaleItem }) => (
  <View style={styles.sale}>
    <View style={styles.row}>
      <Text style={styles.saleTitle}>{sale.isReturn ? 'Devolución' : `Venta ${sale.saleNumber || ''}`}</Text>
      <Text style={styles.saleTitle}>{formatPEN(sale.total)}</Text>
    </View>
    <Text style={styles.subtitle}>{sale.customerName || 'Cliente general'} · {sale.paymentMethod}</Text>
    <Text style={styles.note}>{formatDatePE(sale.date)}</Text>
  </View>
));

export default function SellerScreen() {
  const { user, accountId, logout } = useAuth();
  const [metadata, setMetadata] = useState<SellerMetadata | null>(null);
  const [report, setReport] = useState<SellerOwnReport | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    let alive = true;
    setMetadata(null); setReport(null); setBranch(''); setBusy(true); setError('');
    fetchSellerMetadata().then(data => {
      if (!alive) return;
      setMetadata(data); setFrom(data.today); setTo(data.today);
    }).catch(err => { if (alive) { setError(err.message); setBusy(false); } });
    return () => { alive = false; requestVersion.current++; };
  }, [user?.uid, accountId, revision]);

  const load = async (start: string, end: string, branchId: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
      setError('Ingresa fechas válidas como AAAA-MM-DD.'); return;
    }
    const version = ++requestVersion.current;
    setReport(null); setBusy(true); setError('');
    try {
      const data = await fetchSellerPerformance(start, end, branchId);
      if (version === requestVersion.current) setReport(data);
    } catch (err) { if (version === requestVersion.current) setError(err instanceof Error ? err.message : 'No se pudieron consultar tus ventas.'); }
    finally { if (version === requestVersion.current) setBusy(false); }
  };
  useEffect(() => {
    if (metadata) void load(metadata.today, metadata.today, '');
  }, [metadata]);

  const preset = (value: SellerPreset) => {
    if (!metadata) return;
    const range = sellerPresetDates(metadata.today, value);
    setFrom(range.from); setTo(range.to); void load(range.from, range.to, branch);
  };

  const totalSalesCount = useMemo(() => {
    return report?.report.rows.reduce((sum, r) => sum + r.salesCount, 0) ?? 0;
  }, [report]);

  const renderHeader = () => (
    <View style={{ gap: 16 }}>
      <Text style={styles.title}>Mis ventas</Text>
      <Text style={styles.subtitle}>{metadata?.seller.name || 'Portal de vendedor'} · Consulta tus resultados y comprobantes.</Text>
      {metadata && (
        <>
          <View style={styles.row}>
            {([['today','Hoy'],['yesterday','Ayer'],['week','Semana'],['month','Mes']] as const).map(([value,label]) => (
              <TouchableOpacity key={value} accessibilityRole="button" style={styles.chip} onPress={() => preset(value)}>
                <Text style={styles.linkText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>Sucursal</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
              {[{id:'',name:'Mis sucursales'},...metadata.branches].map(b => (
                <TouchableOpacity key={b.id} accessibilityRole="button" accessibilityState={{selected:branch===b.id}} style={[styles.chip,branch===b.id && styles.chipActive]} onPress={() => {setBranch(b.id);void load(from,to,b.id);}}>
                  <Text style={styles.linkText}>{b.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
          <View style={styles.row}>
            <View style={styles.field}><Text style={styles.label}>Desde</Text><TextInput accessibilityLabel="Desde (AAAA-MM-DD)" placeholder="AAAA-MM-DD" value={from} onChangeText={setFrom} style={styles.input}/></View>
            <View style={styles.field}><Text style={styles.label}>Hasta</Text><TextInput accessibilityLabel="Hasta (AAAA-MM-DD)" placeholder="AAAA-MM-DD" value={to} onChangeText={setTo} style={styles.input}/></View>
          </View>
          <TouchableOpacity accessibilityRole="button" disabled={busy} style={[styles.primary,busy && {opacity:0.6}]} onPress={() => void load(from,to,branch)}>
            <Text style={styles.primaryText}>Consultar período</Text>
          </TouchableOpacity>
          <Text style={styles.note}>Fechas del negocio · {metadata.timeZone}</Text>
        </>
      )}
      {busy && <ActivityIndicator color={ui.primary} accessibilityLabel="Consultando tus ventas" />}
      {!!error && (
        <View style={styles.error}>
          <Text accessibilityRole="alert" style={{color:ui.danger}}>{error}</Text>
          <TouchableOpacity accessibilityRole="button" style={styles.link} onPress={() => metadata ? void load(from,to,branch) : setRevision(v=>v+1)}>
            <Text style={styles.linkText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}
      {report && (
        <>
          <View style={styles.summary}>
            <Text style={styles.label}>Ventas netas del período</Text>
            <Text style={styles.value}>{formatPEN(report.report.totalNet)}</Text>
            <View style={styles.row}>
              <Text style={styles.subtitle}>Bruto {formatPEN(report.report.totalGross)}</Text>
              <Text style={styles.subtitle}>Devoluciones {formatPEN(report.report.totalRefunds)}</Text>
            </View>
            <Text style={styles.subtitle}>{totalSalesCount} ventas</Text>
          </View>
          <SectionHeading title="Ventas recientes" />
          {!report.recentSales.length && <Text style={styles.subtitle}>No tienes ventas registradas en este período.</Text>}
        </>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <BrandLogo />
        <TouchableOpacity accessibilityRole="button" onPress={() => void logout()} style={styles.link}>
          <Text style={styles.linkText}>Cerrar sesión</Text>
        </TouchableOpacity>
      </View>
      <FlashList
        data={report?.recentSales || []}
        keyExtractor={(sale) => sale.id}
        estimatedItemSize={90}
        renderItem={({ item }) => <SellerSaleRow sale={item} />}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      />
    </SafeAreaView>
  );
}

const styles=StyleSheet.create({
  screen:{flex:1,backgroundColor:ui.background},header:{paddingHorizontal:20,paddingVertical:12,backgroundColor:ui.surface,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},content:{padding:20,gap:16,paddingBottom:40},title:{fontSize:28,fontWeight:'700',color:ui.text},subtitle:{fontSize:14,lineHeight:21,color:ui.textSecondary},link:{paddingVertical:12,paddingHorizontal:8,minHeight:48,justifyContent:'center'},linkText:{color:ui.primary,fontWeight:'600'},row:{flexDirection:'row',gap:12,alignItems:'center',flexWrap:'wrap'},chip:{paddingHorizontal:14,paddingVertical:14,minHeight:48,backgroundColor:ui.surface,borderRadius:10,borderWidth:1,borderColor:ui.border},chipActive:{backgroundColor:ui.primarySoft,borderColor:ui.primary},field:{flex:1,minWidth:130},label:{fontSize:13,fontWeight:'600',color:ui.textSecondary,marginBottom:6},input:{padding:14,borderWidth:1,borderColor:ui.border,borderRadius:10,backgroundColor:ui.surface,color:ui.text,minHeight:48},primary:{padding:16,backgroundColor:ui.primary,borderRadius:12,alignItems:'center'},primaryText:{color:ui.onPrimary,fontWeight:'700'},note:{fontSize:12,color:ui.textMuted,lineHeight:18},error:{padding:16,backgroundColor:ui.dangerSoft,borderRadius:12},summary:{padding:20,gap:8,backgroundColor:ui.surface,borderRadius:14,borderWidth:1,borderColor:ui.border},value:{fontSize:28,fontWeight:'700',color:ui.text},sale:{padding:16,gap:6,borderBottomWidth:1,borderColor:ui.border,backgroundColor:ui.surface},saleTitle:{fontWeight:'700',fontSize:16,color:ui.text},
});
