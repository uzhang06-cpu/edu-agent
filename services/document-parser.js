/**
 * services/document-parser.js
 * ──────────────────────────────────────────────────────────────────
 *  解析上传文件为纯文本，供 Agent 阅读
 *  支持：pdf / docx / xlsx / xls / csv / txt / 图片(OCR)
 * ──────────────────────────────────────────────────────────────────
 */

const path = require('path');

const MAX_TEXT_CHARS = 20000; // 防止 LLM 超长上下文

function clip(text) {
  if (!text) return '';
  text = String(text).replace(/\s+\n/g, '\n').trim();
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + `\n…（已截断，原文共 ${text.length} 字）`;
}

/** PDF */
async function parsePdf(buffer) {
  const pdf = require('pdf-parse');
  const data = await pdf(buffer);
  return {
    type: 'pdf',
    pages: data.numpages,
    text: clip(data.text)
  };
}

/** DOCX */
async function parseDocx(buffer) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return { type: 'docx', text: clip(value) };
}

/** XLSX / XLS / CSV */
async function parseSpreadsheet(buffer, ext) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    out.push(`# Sheet: ${name}\n${csv}`);
  }
  return {
    type: ext === 'csv' ? 'csv' : 'spreadsheet',
    sheets: wb.SheetNames.length,
    text: clip(out.join('\n\n'))
  };
}

/** TXT 类文本 */
async function parseText(buffer) {
  return { type: 'text', text: clip(buffer.toString('utf8')) };
}

/** 图片 OCR（中文+英文，懒加载 tesseract） */
async function parseImage(buffer) {
  try {
    const Tesseract = require('tesseract.js');
    const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', {
      // 关闭烦人的日志
      logger: () => {}
    });
    return {
      type: 'image',
      confidence: data.confidence,
      text: clip(data.text) || '（图片中未识别到文字）'
    };
  } catch (err) {
    return {
      type: 'image',
      error: err.message,
      text: '（OCR 失败，无法识别图片中的文字）'
    };
  }
}

// ────────────────────────────────────────────────────────────────
//  入口：按 mimetype / 扩展名分派
// ────────────────────────────────────────────────────────────────

const IMAGE_EXTS  = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const SHEET_EXTS  = new Set(['xlsx', 'xls', 'csv']);
const TEXT_EXTS   = new Set(['txt', 'md', 'log', 'json']);

async function parseFile({ buffer, originalname, mimetype }) {
  const ext = path.extname(originalname || '').slice(1).toLowerCase();

  if (ext === 'pdf' || mimetype === 'application/pdf') {
    return parsePdf(buffer);
  }
  if (ext === 'docx' || mimetype?.includes('officedocument.wordprocessingml')) {
    return parseDocx(buffer);
  }
  if (SHEET_EXTS.has(ext) || mimetype?.includes('spreadsheet') || mimetype === 'text/csv') {
    return parseSpreadsheet(buffer, ext || 'xlsx');
  }
  if (IMAGE_EXTS.has(ext) || mimetype?.startsWith('image/')) {
    return parseImage(buffer);
  }
  if (TEXT_EXTS.has(ext) || mimetype?.startsWith('text/')) {
    return parseText(buffer);
  }

  return {
    type: 'unknown',
    text: `（不支持的文件类型：${ext || mimetype || 'unknown'}）`
  };
}

module.exports = { parseFile, MAX_TEXT_CHARS };
