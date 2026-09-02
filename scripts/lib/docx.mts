/**
 * Word テンプレート（docx/docm）へ縦書き原稿を流し込むための共通処理
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import JSZip from 'jszip';

// 縦書きに流し込むため半角英数を全角化する
export function toFullWidth(text) {
  return text.replace(/[a-zA-Z0-9]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 0xFEE0),
  );
}

// ダッシュは JIS のダッシュ U+2015 に揃える（MS 明朝の縦書き字形はこちらに付いており、
// macOS の IME が出す U+2014 は Windows 版 Word で横向きのままになることがある）。
// 矢印は縦書きで90度回転して見えるため、あらかじめ逆回転しておく。
export function toVerticalBase(text) {
  return text
    .replace(/[—―]/g, '―')
    .replace(/[→←↑↓]/g, m => ({ '→': '↓', '←': '↑', '↑': '←', '↓': '→' })[m]);
}

// 縦書きテンプレート用の素のテキスト（記号正規化＋全角化）
export function toVerticalText(text) {
  return toFullWidth(toVerticalBase(text));
}

/**
 * テンプレートの zip エントリを書き換えて別ファイルに保存する。
 *   transforms: { 'word/document.xml': xml => xml, 'docProps/core.xml': xml => xml, ... }
 * word/document.xml は必須。それ以外のエントリはテンプレートに存在するときだけ書き換える。
 */
export async function rewriteDocx(templatePath, outputPath, transforms) {
  const zip = await JSZip.loadAsync(readFileSync(templatePath));
  if (!zip.file('word/document.xml')) {
    throw new Error(`テンプレートに word/document.xml がありません: ${templatePath}`);
  }
  for (const [entry, transform] of Object.entries(transforms)) {
    const file = zip.file(entry);
    if (!file) continue;
    zip.file(entry, transform(await file.async('string')));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  describe('toFullWidth', () => {
    test('半角英数のみ全角化し、記号や日本語はそのまま', () => {
      expect(toFullWidth('abc12X')).toBe('ａｂｃ１２Ｘ');
      expect(toFullWidth('あ-1')).toBe('あ-１');
    });
  });

  describe('toVerticalBase', () => {
    test('EMダッシュ・水平線はJISダッシュに揃える', () => {
      expect(toVerticalBase('——')).toBe('――');
      expect(toVerticalBase('―')).toBe('―');
    });
    test('矢印は逆回転しておく', () => {
      expect(toVerticalBase('→←↑↓')).toBe('↓↑←→');
    });
  });

  describe('toVerticalText', () => {
    test('正規化と全角化を両方行う', () => {
      expect(toVerticalText('AB—12')).toBe('ＡＢ―１２');
    });
  });

  describe('rewriteDocx', () => {
    test('document.xml を書き換え、存在しないエントリは読み飛ばす', async () => {
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const { unlinkSync } = await import('fs');
      const template = join(tmpdir(), `docx-${process.pid}-tpl.docx`);
      const output = join(tmpdir(), `docx-${process.pid}-out.docx`);
      const zip = new JSZip();
      zip.file('word/document.xml', '<w:body>old</w:body>');
      writeFileSync(template, await zip.generateAsync({ type: 'nodebuffer' }));
      try {
        await rewriteDocx(template, output, {
          'word/document.xml': xml => xml.replace('old', 'new'),
          'docProps/core.xml': () => { throw new Error('should not be called'); },
        });
        const result = await JSZip.loadAsync(readFileSync(output));
        expect(await result.file('word/document.xml').async('string')).toBe('<w:body>new</w:body>');
      } finally {
        unlinkSync(template);
        unlinkSync(output);
      }
    });
  });
}
