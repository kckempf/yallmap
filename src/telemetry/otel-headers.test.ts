import { describe, it, expect, beforeEach } from 'vitest';
import { buildOtlpHeaders } from './index';

beforeEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
});

describe('buildOtlpHeaders', () => {
  it('returns empty object when no env vars are set', () => {
    expect(buildOtlpHeaders()).toEqual({});
  });

  describe('OTEL_EXPORTER_OTLP_HEADERS', () => {
    it('parses a single key=value pair', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer token123';
      expect(buildOtlpHeaders()).toEqual({ Authorization: 'Bearer token123' });
    });

    it('parses multiple comma-separated pairs', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'X-Tenant=acme,X-Env=prod';
      expect(buildOtlpHeaders()).toEqual({ 'X-Tenant': 'acme', 'X-Env': 'prod' });
    });

    it('trims whitespace around key and value', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = ' X-Key = some value ';
      expect(buildOtlpHeaders()['X-Key']).toBe('some value');
    });

    it('handles a value containing an = sign', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Basic dXNlcjpwYXNz==';
      expect(buildOtlpHeaders()['Authorization']).toBe('Basic dXNlcjpwYXNz==');
    });

    it('skips malformed pairs with no = sign', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'ValidKey=val,badpair,X-Other=ok';
      const headers = buildOtlpHeaders();
      expect(headers['ValidKey']).toBe('val');
      expect(headers['X-Other']).toBe('ok');
      expect(Object.keys(headers)).toHaveLength(2);
    });
  });

  describe('Langfuse convenience vars', () => {
    it('builds Basic auth from LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
      const expected = `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`;
      expect(buildOtlpHeaders()['Authorization']).toBe(expected);
    });

    it('does not set Authorization when only public key is present', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      expect(buildOtlpHeaders()['Authorization']).toBeUndefined();
    });

    it('does not set Authorization when only secret key is present', () => {
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
      expect(buildOtlpHeaders()['Authorization']).toBeUndefined();
    });

    it('Langfuse Basic auth overwrites Authorization from OTEL_EXPORTER_OTLP_HEADERS', () => {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer old-token';
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
      const headers = buildOtlpHeaders();
      expect(headers['Authorization']).toMatch(/^Basic /);
    });

    it('base64 encodes credentials correctly', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'user';
      process.env.LANGFUSE_SECRET_KEY = 'pass';
      const headers = buildOtlpHeaders();
      const decoded = Buffer.from(headers['Authorization'].replace('Basic ', ''), 'base64').toString();
      expect(decoded).toBe('user:pass');
    });
  });
});
