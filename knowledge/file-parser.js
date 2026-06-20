/**
 * file-parser.js
 * ──────────────────────────────────────────────────────────────────
 * 多格式文件解析器（PDF/Word/文本）
 *
 * 功能：
 * 1. 解析 PDF 文件（使用 pdf-parse）
 * 2. 解析 Word 文档（使用 mammoth）
 * 3. 解析纯文本文件
 * 4. 提取文本内容并分块
 *
 * 依赖（需要安装）：
 * - pdf-parse
 * - mammoth
 *
 * 安装命令：
 * npm install pdf-parse mammoth
 * ──────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

// 动态加载依赖（避免未安装时报错）
let pdfParse = null;
let mammoth = null;

try {
  pdfParse = require('pdf-parse');
  console.log('[文件解析] PDF 解析器已加载');
} catch (e) {
  console.warn('[文件解析] pdf-parse 未安装，PDF 解析功能不可用');
}

try {
  mammoth = require('mammoth');
  console.log('[文件解析] Word 解析器已加载');
} catch (e) {
  console.warn('[文件解析] mammoth 未安装，Word 解析功能不可用');
}

// ── 支持的文件类型 ─────────────────────────────────────────────────
const SUPPORTED_EXTENSIONS = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.txt': 'text',
  '.md': 'text',
  '.json': 'text'
};

// ── 检测文件类型 ──────────────────────────────────────────────────
function detectFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] || null;
}

// ── 解析 PDF 文件 ─────────────────────────────────────────────────
async function parsePdf(filePath) {
  if (!pdfParse) {
    throw new Error('PDF 解析功能不可用，请安装 pdf-parse 库');
  }

  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    return {
      success: true,
      text: data.text,
      metadata: {
        pageCount: data.numpages,
        info: data.info,
        version: data.version
      },
      chunks: splitIntoChunks(data.text)
    };
  } catch (error) {
    console.error(`[文件解析] PDF 解析失败 ${filePath}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ── 解析 Word 文件 ─────────────────────────────────────────────────
async function parseWord(filePath) {
  if (!mammoth) {
    throw new Error('Word 解析功能不可用，请安装 mammoth 库');
  }

  try {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = result.value;

    return {
      success: true,
      text: text,
      metadata: {
        warnings: result.messages.filter(m => m.type === 'warning'),
        messages: result.messages
      },
      chunks: splitIntoChunks(text)
    };
  } catch (error) {
    console.error(`[文件解析] Word 解析失败 ${filePath}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ── 解析文本文件 ───────────────────────────────────────────────────
async function parseText(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');

    return {
      success: true,
      text: text,
      metadata: {
        encoding: 'utf8',
        size: text.length
      },
      chunks: splitIntoChunks(text)
    };
  } catch (error) {
    console.error(`[文件解析] 文本解析失败 ${filePath}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ── 通用文件解析 ───────────────────────────────────────────────────
async function parseFile(filePath) {
  const fileType = detectFileType(filePath);

  if (!fileType) {
    return {
      success: false,
      error: `不支持的文件类型: ${path.extname(filePath)}`
    };
  }

  switch (fileType) {
    case 'pdf':
      return await parsePdf(filePath);
    case 'docx':
    case 'doc':
      return await parseWord(filePath);
    case 'text':
      return await parseText(filePath);
    default:
      return {
        success: false,
        error: `未实现的解析器: ${fileType}`
      };
  }
}

// ── 文本分块（用于 RAG 知识库）─────────────────────────────────────
function splitIntoChunks(text, options = {}) {
  const {
    maxChunkSize = 1000,    // 最大块大小（字符）
    overlap = 200,          // 块间重叠（字符）
    minChunkSize = 100      // 最小块大小（字符）
  } = options;

  if (!text || text.length <= minChunkSize) {
    return [text];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChunkSize;

    // 如果未到文本末尾，尝试在句子边界分割
    if (end < text.length) {
      // 查找句子结束符（。！？.?!）
      const sentenceEnd = Math.max(
        text.lastIndexOf('。', end),
        text.lastIndexOf('！', end),
        text.lastIndexOf('？', end),
        text.lastIndexOf('.', end),
        text.lastIndexOf('!', end),
        text.lastIndexOf('?', end)
      );

      if (sentenceEnd > start + minChunkSize) {
        end = sentenceEnd + 1; // 包含结束符
      }
    } else {
      end = text.length;
    }

    const chunk = text.substring(start, end).trim();
    if (chunk.length >= minChunkSize) {
      chunks.push(chunk);
    }

    // 移动起始位置，考虑重叠
    start = end - overlap;

    // 确保前进
    if (start < end) {
      start = end;
    }
  }

  return chunks;
}

// ── 批量解析文件 ───────────────────────────────────────────────────
async function parseFiles(filePaths, options = {}) {
  const results = [];

  for (const filePath of filePaths) {
    try {
      const result = await parseFile(filePath);
      results.push({
        filePath,
        filename: path.basename(filePath),
        ...result
      });
    } catch (error) {
      results.push({
        filePath,
        filename: path.basename(filePath),
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

// ── 检查依赖是否安装 ─────────────────────────────────────────────────
function checkDependencies() {
  return {
    pdf: !!pdfParse,
    word: !!mammoth,
    supportedExtensions: Object.keys(SUPPORTED_EXTENSIONS)
  };
}

module.exports = {
  detectFileType,
  parseFile,
  parseFiles,
  parsePdf,
  parseWord,
  parseText,
  splitIntoChunks,
  checkDependencies,
  SUPPORTED_EXTENSIONS
};