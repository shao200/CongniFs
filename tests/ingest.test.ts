import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { hammingDistance, simhash64 } from '../src/dedupe.js';
import { addSource, chunkText, scanSource } from '../src/ingest.js';

describe('chunkText', () => {
  it('keeps paragraphs together and splits long text', () => {
    const text = `# 标题\n\n第一段内容。\n\n${'长'.repeat(50)}\n\n最后一段。`;
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('第一段内容');
    expect(chunks.every((chunk) => chunk.text.length <= 40)).toBe(true);
  });

  it('returns empty for blank input', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('scanSource', () => {
  it('indexes supported files and skips unchanged ones on rescan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-'));
    writeFileSync(join(root, 'note.md'), '# 种植体\n\n这是第一段。\n\n这是第二段。');
    writeFileSync(join(root, 'readme.txt'), '普通文本内容。');
    writeFileSync(join(root, 'skip.bin'), 'not supported');

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');

    const first = await scanSource(db, source.id);
    expect(first).toMatchObject({ scanned: 2, indexed: 2, skipped: 0, failed: 0 });

    const documents = db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number };
    expect(documents.n).toBe(2);

    const second = await scanSource(db, source.id);
    expect(second).toMatchObject({ scanned: 2, indexed: 0, skipped: 2, failed: 0 });
  });

  it('records failures without aborting the batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-'));
    writeFileSync(join(root, 'empty.md'), '');

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const result = await scanSource(db, source.id);

    expect(result).toMatchObject({ scanned: 1, indexed: 0, skipped: 0, failed: 1 });
    const failed = db
      .prepare("SELECT COUNT(*) AS n FROM ingest_jobs WHERE state = 'failed'")
      .get() as { n: number };
    expect(failed.n).toBe(1);
  });

  it('parses docx and pdf into documents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-'));

    const docx = new Document({
      sections: [{ children: [new Paragraph('齿科种植体方案与随访计划。')] }],
    });
    writeFileSync(join(root, 'plan.docx'), await Packer.toBuffer(docx));

    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Dental implant plan and follow up.', { x: 50, y: 700, size: 12, font });
    writeFileSync(join(root, 'plan.pdf'), await pdf.save());

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const result = await scanSource(db, source.id);

    expect(result).toMatchObject({ scanned: 2, indexed: 2, failed: 0 });
    const titles = db.prepare('SELECT title FROM documents ORDER BY title').all() as Array<{
      title: string;
    }>;
    expect(titles).toHaveLength(2);
  });

  it('parses xlsx and pptx into documents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-'));

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['姓名', '诊断'],
      ['张三', '种植体周围炎'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, '随访');
    writeFileSync(
      join(root, '随访.xlsx'),
      XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    );

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>齿科种植体方案</a:t></a:r></a:p><a:p><a:r><a:t>第二段内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
    writeFileSync(join(root, '方案.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const result = await scanSource(db, source.id);

    expect(result).toMatchObject({ scanned: 2, indexed: 2, failed: 0 });
    const texts = db.prepare('SELECT text FROM chunks').all() as Array<{ text: string }>;
    const combined = texts.map((row) => row.text).join('\n');
    expect(combined).toContain('种植体周围炎');
    expect(combined).toContain('齿科种植体方案');
  });

  it('creates a dedupe suggestion for identical content at different paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'congni-'));
    const content = '同一份方案的内容，用于测试重复检测。';
    writeFileSync(join(root, 'a.txt'), content);
    writeFileSync(join(root, 'b.txt'), content);

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const result = await scanSource(db, source.id);
    expect(result.indexed).toBe(2);

    const suggestions = db
      .prepare("SELECT kind, confidence FROM organize_suggestions WHERE status = 'pending'")
      .all() as Array<{ kind: string; confidence: number }>;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ kind: 'dedupe', confidence: 1 });
  });

  it('detects near-duplicate content with simhash', async () => {
    const base = Array.from(
      { length: 20 },
      (_, index) => `第${index}条：患者${index}的种植体复查记录、用药说明与随访安排。`,
    ).join('\n\n');
    const variant = `${base}\n\n补充：术后每三个月复查一次。`;

    expect(hammingDistance(simhash64(base), simhash64(base))).toBe(0);
    expect(hammingDistance(simhash64(base), simhash64(variant))).toBeLessThanOrEqual(4);

    const root = mkdtempSync(join(tmpdir(), 'congni-'));
    writeFileSync(join(root, 'base.txt'), base);
    writeFileSync(join(root, 'variant.txt'), variant);

    const db = openDb(':memory:');
    const source = addSource(db, root, 'llm_ok');
    const result = await scanSource(db, source.id);
    expect(result.indexed).toBe(2);

    const suggestions = db
      .prepare("SELECT payload_json FROM organize_suggestions WHERE status = 'pending'")
      .all() as Array<{ payload_json: string }>;
    expect(suggestions).toHaveLength(1);
    expect(JSON.parse(suggestions[0].payload_json).method).toBe('simhash');
  });
});
