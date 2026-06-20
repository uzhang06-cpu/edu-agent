/**
 * user-profile.js
 * ──────────────────────────────────────────────────────────────────
 * 用户画像系统（基础版）
 *
 * 功能：
 * 1. 记录用户交互历史（查询、点击、会话）
 * 2. 分析用户兴趣标签
 * 3. 提供个性化推荐
 * 4. 存储用户偏好
 *
 * 数据存储：./profiles/ 目录下的 JSON 文件
 * 每个用户一个文件：user_{userId}.json
 * ──────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { tokenizeChinese } = require('./enhanced-retriever');

const PROFILES_DIR = path.join(__dirname, 'profiles');

// 确保目录存在
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// ── 用户画像结构 ──────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  userId: null,
  // 基础信息
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  totalInteractions: 0,
  // 交互历史
  queries: [],          // 搜索查询历史
  clicks: [],           // 内容点击历史
  sessions: [],         // 会话历史
  // 兴趣标签（自动分析）
  interestTags: {},     // { "标签": 权重(0-1) }
  // 偏好设置
  preferences: {
    preferredTopics: [],
    notificationEnabled: true,
    language: 'zh-CN',
  },
  // 统计信息
  statistics: {
    totalQueries: 0,
    totalClicks: 0,
    avgQueryLength: 0,
    mostActiveTime: null,
  }
};

// ── 加载用户画像 ──────────────────────────────────────────────────
function loadUserProfile(userId) {
  const filePath = path.join(PROFILES_DIR, `user_${userId}.json`);

  if (!fs.existsSync(filePath)) {
    return {
      ...DEFAULT_PROFILE,
      userId,
      createdAt: new Date().toISOString()
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 合并默认值，确保新字段存在
    return {
      ...DEFAULT_PROFILE,
      ...raw,
      userId,
      updatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error(`[用户画像] 加载用户 ${userId} 失败:`, e.message);
    return {
      ...DEFAULT_PROFILE,
      userId,
      createdAt: new Date().toISOString()
    };
  }
}

// ── 保存用户画像 ──────────────────────────────────────────────────
function saveUserProfile(profile) {
  const filePath = path.join(PROFILES_DIR, `user_${profile.userId}.json`);
  profile.updatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    return true;
  } catch (e) {
    console.error(`[用户画像] 保存用户 ${profile.userId} 失败:`, e.message);
    return false;
  }
}

// ── 记录用户查询 ──────────────────────────────────────────────────
function recordQuery(userId, query, results = []) {
  const profile = loadUserProfile(userId);

  // 记录查询
  const queryRecord = {
    query,
    timestamp: new Date().toISOString(),
    resultCount: results.length,
    topResults: results.slice(0, 3).map(r => ({
      id: r.id,
      title: r.title,
      score: r.score
    }))
  };

  profile.queries.push(queryRecord);
  profile.totalInteractions++;
  profile.statistics.totalQueries++;

  // 更新平均查询长度
  const totalLength = profile.queries.reduce((sum, q) => sum + q.query.length, 0);
  profile.statistics.avgQueryLength = totalLength / profile.queries.length;

  // 分析查询内容，更新兴趣标签
  updateInterestTags(profile, query, results);

  // 更新最活跃时间（简化：记录最近一次查询的小时）
  const hour = new Date().getHours();
  profile.statistics.mostActiveTime = hour;

  return saveUserProfile(profile);
}

// ── 记录用户点击 ──────────────────────────────────────────────────
function recordClick(userId, contentId, contentType = 'knowledge', title = '') {
  const profile = loadUserProfile(userId);

  const clickRecord = {
    contentId,
    contentType,
    title,
    timestamp: new Date().toISOString()
  };

  profile.clicks.push(clickRecord);
  profile.totalInteractions++;
  profile.statistics.totalClicks++;

  // 根据点击内容更新兴趣标签
  if (contentType === 'knowledge') {
    const contentTags = extractTagsFromTitle(title);
    contentTags.forEach(tag => {
      profile.interestTags[tag] = (profile.interestTags[tag] || 0) + 0.1;
    });
  }

  return saveUserProfile(profile);
}

// ── 更新兴趣标签 ──────────────────────────────────────────────────
function updateInterestTags(profile, query, results) {
  const tokens = tokenizeChinese(query);

  // 查询中的关键词权重
  tokens.forEach(token => {
    if (token.length >= 2) {
      profile.interestTags[token] = (profile.interestTags[token] || 0) + 0.05;
    }
  });

  // 根据结果内容增加相关标签权重
  results.slice(0, 3).forEach(result => {
    const resultTags = extractTagsFromTitle(result.title);
    resultTags.forEach(tag => {
      profile.interestTags[tag] = (profile.interestTags[tag] || 0) + 0.03;
    });
  });

  // 归一化标签权重（保持 0-1 范围）
  const maxWeight = Math.max(...Object.values(profile.interestTags), 1);
  Object.keys(profile.interestTags).forEach(tag => {
    profile.interestTags[tag] = Math.min(profile.interestTags[tag] / maxWeight, 1);
  });

  // 清理低权重标签（< 0.1）
  Object.keys(profile.interestTags).forEach(tag => {
    if (profile.interestTags[tag] < 0.1) {
      delete profile.interestTags[tag];
    }
  });
}

// ── 从标题提取标签 ─────────────────────────────────────────────────
function extractTagsFromTitle(title) {
  if (!title) return [];
  return tokenizeChinese(title).filter(token => token.length >= 2);
}

// ── 获取用户兴趣标签（按权重排序）────────────────────────────────────
function getUserInterests(userId, topN = 10) {
  const profile = loadUserProfile(userId);
  const tags = Object.entries(profile.interestTags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([tag, weight]) => ({ tag, weight: Math.round(weight * 100) / 100 }));

  return tags;
}

// ── 获取个性化推荐 ─────────────────────────────────────────────────
function getPersonalizedRecommendations(userId, allContents, topN = 5) {
  const profile = loadUserProfile(userId);
  const userTags = profile.interestTags;

  if (Object.keys(userTags).length === 0) {
    // 无兴趣数据，返回热门内容
    return allContents.slice(0, topN);
  }

  // 计算内容与用户兴趣的匹配度
  const scoredContents = allContents.map(content => {
    const contentTags = extractTagsFromTitle(content.title);
    let score = 0;

    contentTags.forEach(tag => {
      if (userTags[tag]) {
        score += userTags[tag];
      }
    });

    // 如果内容有标签数组，也进行匹配
    if (content.tags && Array.isArray(content.tags)) {
      content.tags.forEach(tag => {
        if (userTags[tag]) {
          score += userTags[tag] * 0.5; // 标签权重稍低
        }
      });
    }

    return {
      ...content,
      personalizationScore: Math.round(score * 100) / 100
    };
  });

  // 按个性化分数排序
  return scoredContents
    .sort((a, b) => b.personalizationScore - a.personalizationScore)
    .slice(0, topN);
}

// ── 获取用户统计摘要 ───────────────────────────────────────────────
function getUserSummary(userId) {
  const profile = loadUserProfile(userId);

  return {
    userId,
    totalInteractions: profile.totalInteractions,
    totalQueries: profile.statistics.totalQueries,
    totalClicks: profile.statistics.totalClicks,
    avgQueryLength: Math.round(profile.statistics.avgQueryLength * 100) / 100,
    mostActiveTime: profile.statistics.mostActiveTime,
    interestCount: Object.keys(profile.interestTags).length,
    topInterests: getUserInterests(userId, 5),
    profileAgeDays: Math.floor(
      (new Date() - new Date(profile.createdAt)) / (1000 * 60 * 60 * 24)
    )
  };
}

// ── 清空用户数据（测试用）──────────────────────────────────────────
function clearUserData(userId) {
  const filePath = path.join(PROFILES_DIR, `user_${userId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

module.exports = {
  loadUserProfile,
  saveUserProfile,
  recordQuery,
  recordClick,
  getUserInterests,
  getPersonalizedRecommendations,
  getUserSummary,
  clearUserData
};