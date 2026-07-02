/**
 * services/text-cleaner.js
 * ──────────────────────────────────────────────────────────────────
 *  LLM 回复文本清洗
 *  ──────────────────────────────────────────────────────────────
 *  之前的实现（pipeline.js 老版）：
 *    reply.replace(/（[^）]*）/g,'')  // 一刀切删所有全角括号
 *  → 会误删 "精英班（一对一）"、"数学（高中）、物理（高中）" 里的语义括号。
 *
 *  新规则：
 *  1. 只删 "旁白式" 括号内容：
 *     - 明确标签：思考、思考中、心里、心想、内心、动作、旁白、OS、括号内、括号里、内心 OS
 *     - 元描述：微笑、点头、叹气、看着、笑道、说、道、皱眉、想了想、犹豫 …
 *     - 长度：括号内 ≥ 6 字，或含冒号 "："
 *  2. 保留语义括号：
 *     - 学科/等级/年级："数学（高中）"、"精英班（一对一）"
 *     - 数字单位："48 节（每年）"、"¥ 9800（¥/年）"
 *     - 短标注（< 6 字且非旁白关键字）
 *  3. 删 AI 味前缀："AI:" / "Bot:" / "助手:" 开头
 *  4. 去掉 markdown 里孤立空行
 *
 *  同时导出 `isNarration(text)` 供单元测试。
 * ──────────────────────────────────────────────────────────────────
 */

// 旁白关键字（出现即视为旁白，无论长度）
const NARRATION_KEYWORDS = [
  // 思考类
  '思考', '思考中', '心里', '心想', '内心', '内心 OS', 'OS', '独白',
  '想了想', '犹豫', '琢磨', '沉思', '思索',
  // 元标签
  '旁白', '括号内', '括号里', '注：', '注意：', '说明：',
  // 动作类（面部/身体）
  '动作', '微笑', '笑着', '笑道', '大笑', '苦笑',
  '点头', '摇头', '皱眉', '叹气', '停顿', '沉默', '停下',
  '看着', '看向', '望着', '望向',
  '哭', '叹', '啜泣', '低头', '抬头', '眨眼',
  // 表达类
  '说道', '说着', '答道', '低声', '大声',
  '语气', '眼神', '表情', '神情', '神态',
];

// AI 味前缀
const AI_PREFIX_RE = /^\s*(AI|Bot|助手|机器人|小助手|星小助)\s*[:：]\s*/i;

/** 判断一段括号内的文本是否"旁白型"（应删） */
function isNarration(inner) {
  if (!inner) return false;
  const s = String(inner).trim();
  // 含冒号 "xxx：yyy" 大概率是旁白/元信息
  if (/[:：]/.test(s)) return true;
  // 命中关键字直接判旁白
  for (const kw of NARRATION_KEYWORDS) {
    if (s.includes(kw)) return true;
  }
  // 无关键字 & 长度 ≥ 8 字 → 视为长旁白（阈值稍宽，避免误伤"（每次 1 小时的直播课）"这种数字标注）
  if (s.length >= 8) {
    // 但如果里面含数字且短于 12 字，倾向保留（如"（每周 3 节 × 60 分钟）"）
    if (/\d/.test(s) && s.length < 12) return false;
    return true;
  }
  return false;
}

/** 主清洗函数 */
function cleanReply(text) {
  if (!text) return '';
  let s = String(text);

  // 1. 去 AI 前缀
  s = s.replace(AI_PREFIX_RE, '');

  // 2. 按 " 全角括号 / 半角括号 / 方头括号 " 三种匹配，逐条判断
  //    使用非贪婪 + 允许嵌套单层
  const patterns = [
    /（([^（）]{0,120})）/g,  // 全角
    /\(([^()]{0,120})\)/g,   // 半角
    /【([^【】]{0,120})】/g,  // 方头（几乎必然是旁白/标签）
  ];
  for (const re of patterns) {
    s = s.replace(re, (full, inner) => {
      // 方头括号里的内容更严格：只要含关键字或超 4 字就删
      if (full.startsWith('【')) {
        if (isNarration(inner) || inner.length >= 4) return '';
        return full;
      }
      return isNarration(inner) ? '' : full;
    });
  }

  // 3. 多重空白规整（保留段落分隔）
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/^[ \t]+|[ \t]+$/gm, '');

  return s.trim();
}

module.exports = { cleanReply, isNarration, NARRATION_KEYWORDS };
