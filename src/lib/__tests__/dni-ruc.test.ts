import { describe, it, expect, vi } from 'vitest';
import { lookupDocument, lookupDNI, lookupRUC, LookupError } from '../dni-ruc-service';

describe('DNI / RUC Lookup Service', () => {
  it('throws INVALID_DNI on bad DNI format', async () => {
    await expect(lookupDNI('12345')).rejects.toThrow('El DNI debe tener 8 dígitos');
  });

  it('throws INVALID_RUC on bad RUC format or invalid Modulo 11', async () => {
    await expect(lookupRUC('12345678901')).rejects.toThrow('no es válido');
  });

  it('throws on unsupported document type', async () => {
    // @ts-expect-error test invalid type
    await expect(lookupDocument('pasaporte', '12345678')).rejects.toThrow('Tipo de documento');
  });
});
