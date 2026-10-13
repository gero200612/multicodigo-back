import { describe, expect, it } from 'vitest';
import { videoDelMensaje } from '../src/telegram.js';

describe('videoDelMensaje', () => {
  it('un video mandado como video', () => {
    expect(videoDelMensaje({ video: { file_id: 'v1', file_size: 1234, mime_type: 'video/mp4' } })).toEqual({ fileId: 'v1', peso: 1234 });
  });
  it('un video mandado como archivo (sin comprimir)', () => {
    expect(videoDelMensaje({ document: { file_id: 'd1', file_size: 99, mime_type: 'video/quicktime', file_name: 'reel.mov' } })).toEqual({
      fileId: 'd1',
      peso: 99,
    });
    expect(videoDelMensaje({ document: { file_id: 'd2', file_name: 'reel.MP4' } })).toEqual({ fileId: 'd2', peso: 0 });
  });
  it('otro archivo no es un video', () => {
    expect(videoDelMensaje({ document: { file_id: 'd3', mime_type: 'application/pdf', file_name: 'factura.pdf' } })).toBeUndefined();
    expect(videoDelMensaje({})).toBeUndefined();
  });
});
