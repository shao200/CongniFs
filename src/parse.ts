export interface ParsedDocument {
  text: string;
  pages?: number;
  parserVersion: string;
}

interface PdfTextItem {
  str?: string;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
}

interface PdfModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

export const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.pdf',
  '.docx',
  '.xlsx',
  '.xls',
  '.pptx',
  '.csv',
]);

const MAX_SHEETS = 50;
const MAX_ROWS = 5000;
const MAX_SLIDES = 200;

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function parseSpreadsheet(buffer: Buffer): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_ROWS });
  const sheets = workbook.SheetNames.slice(0, MAX_SHEETS);
  const parts: string[] = [];

  for (const name of sheets) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      parts.push(`# ${name}\n${lines.join('\n')}`);
    }
  }

  return { text: parts.join('\n\n'), pages: sheets.length, parserVersion: 'sheetjs-v1' };
}

async function parsePresentation(buffer: Buffer): Promise<ParsedDocument> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      const rightNumber = Number(right.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return leftNumber - rightNumber;
    })
    .slice(0, MAX_SLIDES);

  const parts: string[] = [];
  for (const [index, name] of slides.entries()) {
    const xml = await zip.files[name].async('string');
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((paragraph) =>
        Array.from(paragraph.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
          .map((match) => decodeXml(match[1]))
          .join(''),
      )
      .map((text) => text.trim())
      .filter(Boolean);

    if (paragraphs.length > 0) {
      parts.push(`# Slide ${index + 1}\n${paragraphs.join('\n')}`);
    }
  }

  return { text: parts.join('\n\n'), pages: slides.length, parserVersion: 'pptx-v1' };
}

export async function parseBuffer(buffer: Buffer, ext: string): Promise<ParsedDocument> {
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
    case '.csv':
      return { text: buffer.toString('utf8'), parserVersion: 'text-v1' };

    case '.docx': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value, parserVersion: 'mammoth-v1' };
    }

    case '.xlsx':
    case '.xls':
      return parseSpreadsheet(buffer);

    case '.pptx':
      return parsePresentation(buffer);

    case '.pdf': {
      const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;
      const document = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise;

      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .trim();
        if (text) pages.push(text);
      }
      return {
        text: pages.join('\n\n'),
        pages: document.numPages,
        parserVersion: 'pdfjs-v1',
      };
    }

    default:
      throw new Error('UNSUPPORTED');
  }
}
