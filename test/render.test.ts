import { describe, it, expect } from 'vitest';
import { renderApproval, approvalData, parseApprovalData } from '../src/render.js';
import type { ApprovalRequest } from '@multicodigo/shared';

const ID = '11111111-1111-4111-8111-111111111111';

const A: ApprovalRequest = {
  approvalId: ID,
  jobId: '22222222-2222-4222-8222-222222222222',
  agent: 'c1',
  tool: 'Write',
  summary: 'Quiere escribir src/stock/lote.ts.',
  createdAt: '2026-08-25T12:00:00.000Z',
  expiresAt: '2026-08-25T12:15:00.000Z',
};

describe('approvalData / parseApprovalData', () => {
  it('ida y vuelta', () => {
    expect(parseApprovalData(approvalData('ok', ID))).toEqual({ kind: 'ok', approvalId: ID });
  });

  // Telegram corta callback_data en 64 bytes; si se pasa, el boton no llega.
  it('entra en los 64 bytes que permite Telegram', () => {
    for (const k of ['ok', 'no', 'ex'] as const) {
      expect(Buffer.byteLength(approvalData(k, ID), 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('devuelve null con basura', () => {
    expect(parseApprovalData('cualquier cosa')).toBeNull();
  });

  it('devuelve null con un prefijo desconocido', () => {
    expect(parseApprovalData(`zz:${ID}`)).toBeNull();
  });
});

describe('renderApproval', () => {
  it('muestra el agente y el resumen', () => {
    const r = renderApproval(A);
    expect(r.text).toContain('C1');
    expect(r.text).toContain('src/stock/lote.ts');
  });

  it('trae los tres botones del spec', () => {
    const labels = renderApproval(A).buttons.flat().map((b) => b.label);
    expect(labels.some((l) => l.includes('Aprobar'))).toBe(true);
    expect(labels.some((l) => l.includes('Rechazar'))).toBe(true);
    expect(labels.some((l) => l.includes('explicar'))).toBe(true);
  });

  it('cada boton lleva el id adentro, que es lo que lo hace idempotente', () => {
    for (const b of renderApproval(A).buttons.flat()) {
      expect(parseApprovalData(b.data)?.approvalId).toBe(ID);
    }
  });

  it('avisa que hay 15 minutos para contestar', () => {
    expect(renderApproval(A).text).toContain('15');
  });
});
