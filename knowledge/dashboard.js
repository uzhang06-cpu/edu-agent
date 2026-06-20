/**
 * dashboard.js
 * ──────────────────────────────────────────────────────────────────
 * 学习仪表盘系统（基础版）
 *
 * 功能：
 * 1. 知识库统计（文档数、分类、更新情况）
 * 2. 用户活跃度统计
 * 3. 检索效果分析
 * 4. 系统健康状态
 *
 * 提供 JSON API 供前端展示
 * ──────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { loadAndPreprocessDocs } = require('./enhanced-retriever');
const { loadUserProfile } = require('./user-profile');

const DB_DIR = path.join(__dirname, 'db');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// ── 知识库统计 ────────────────────────────────────────────────────
function getKnowledgeStats() {
  try {
    const files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.json'));
    let totalDocs = 0;
    const statsByFile = [];

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), 'utf8'));
        const docCount = raw.length;
        totalDocs += docCount;

        // 分析文档内容
        let totalChars = 0;
        let totalTags = 0;
        raw.forEach(doc => {
          totalChars += (doc.content || '').length;
          totalTags += (doc.tags || []).length;
        });

        statsByFile.push({
          filename: file,
          docCount,
          avgContentLength: Math.round(totalChars / Math.max(docCount, 1)),
          avgTagsPerDoc: Math.round(totalTags / Math.max(docCount, 1)),
          lastModified: fs.statSync(path.join(DB_DIR, file)).mtime
        });
      } catch (e) {
        console.error(`[仪表盘] 分析文件 ${file} 失败:`, e.message);
      }
    }

    // 总体统计
    const allDocs = loadAndPreprocessDocs();
    const uniqueTags = new Set();
    allDocs.forEach(doc => {
      (doc.tags || []).forEach(tag => uniqueTags.add(tag));
    });

    return {
      totalFiles: files.length,
      totalDocs,
      uniqueTags: uniqueTags.size,
      avgDocsPerFile: Math.round(totalDocs / Math.max(files.length, 1)),
      files: statsByFile,
      lastUpdated: statsByFile.length > 0
        ? new Date(Math.max(...statsByFile.map(f => new Date(f.lastModified).getTime()))).toISOString()
        : null
    };
  } catch (error) {
    console.error('[仪表盘] 获取知识库统计失败:', error.message);
    return {
      totalFiles: 0,
      totalDocs: 0,
      uniqueTags: 0,
      avgDocsPerFile: 0,
      files: [],
      lastUpdated: null,
      error: error.message
    };
  }
}

// ── 用户活跃度统计 ─────────────────────────────────────────────────
function getUserActivityStats() {
  try {
    if (!fs.existsSync(PROFILES_DIR)) {
      return {
        totalUsers: 0,
        totalInteractions: 0,
        activeUsers: 0,
        users: []
      };
    }

    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.startsWith('user_') && f.endsWith('.json'));
    const users = [];
    let totalInteractions = 0;
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const file of files) {
      try {
        const userId = file.replace('user_', '').replace('.json', '');
        const profile = loadUserProfile(userId);

        totalInteractions += profile.totalInteractions || 0;

        const lastActive = new Date(profile.updatedAt);
        const isActive = lastActive > sevenDaysAgo;

        users.push({
          userId,
          totalInteractions: profile.totalInteractions || 0,
          totalQueries: profile.statistics?.totalQueries || 0,
          totalClicks: profile.statistics?.totalClicks || 0,
          interestCount: Object.keys(profile.interestTags || {}).length,
          createdAt: profile.createdAt,
          lastActive: profile.updatedAt,
          isActive
        });
      } catch (e) {
        console.error(`[仪表盘] 分析用户文件 ${file} 失败:`, e.message);
      }
    }

    // 按活跃度排序
    users.sort((a, b) => b.totalInteractions - a.totalInteractions);

    const activeUsers = users.filter(u => u.isActive).length;

    // 计算每日活跃度（简化版）
    const dailyActivity = calculateDailyActivity(users);

    return {
      totalUsers: users.length,
      totalInteractions,
      activeUsers,
      avgInteractionsPerUser: Math.round(totalInteractions / Math.max(users.length, 1)),
      topActiveUsers: users.slice(0, 5),
      dailyActivity,
      users: users.slice(0, 20) // 只返回前20个用户详情
    };
  } catch (error) {
    console.error('[仪表盘] 获取用户活跃度统计失败:', error.message);
    return {
      totalUsers: 0,
      totalInteractions: 0,
      activeUsers: 0,
      avgInteractionsPerUser: 0,
      topActiveUsers: [],
      dailyActivity: [],
      users: [],
      error: error.message
    };
  }
}

// ── 计算每日活跃度 ─────────────────────────────────────────────────
function calculateDailyActivity(users) {
  const dailyCounts = {};

  users.forEach(user => {
    // 简化：只统计最近7天
    const date = new Date(user.lastActive).toISOString().split('T')[0];
    dailyCounts[date] = (dailyCounts[date] || 0) + 1;
  });

  // 转换为数组并按日期排序
  return Object.entries(dailyCounts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7); // 最近7天
}

// ── 检索效果分析 ───────────────────────────────────────────────────
function getRetrievalStats() {
  // 注：实际检索效果分析需要记录检索日志
  // 这里提供基础框架
  return {
    totalQueries: 0, // 需要从日志获取
    avgResponseTime: 0,
    successRate: 1.0,
    topQueries: [],
    queryCategories: {}
  };
}

// ── 系统健康状态 ───────────────────────────────────────────────────
function getSystemHealth() {
  const stats = getKnowledgeStats();
  const activity = getUserActivityStats();

  const diskUsage = getDiskUsage();
  const memoryUsage = process.memoryUsage();

  return {
    timestamp: new Date().toISOString(),
    status: 'healthy', // 简化：总是健康
    knowledgeBase: {
      status: stats.totalDocs > 0 ? 'healthy' : 'empty',
      docsCount: stats.totalDocs,
      lastUpdated: stats.lastUpdated
    },
    userActivity: {
      status: activity.totalUsers > 0 ? 'active' : 'inactive',
      activeUsers: activity.activeUsers,
      totalInteractions: activity.totalInteractions
    },
    resources: {
      disk: diskUsage,
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024)
      },
      uptime: Math.round(process.uptime()) // 秒
    },
    dependencies: {
      // 可以检查关键依赖是否可用
    }
  };
}

// ── 获取磁盘使用情况 ────────────────────────────────────────────────
function getDiskUsage() {
  try {
    const knowledgeSize = getDirSize(DB_DIR);
    const profilesSize = fs.existsSync(PROFILES_DIR) ? getDirSize(PROFILES_DIR) : 0;
    const totalSize = knowledgeSize + profilesSize;

    return {
      knowledgeBase: Math.round(knowledgeSize / 1024), // KB
      userProfiles: Math.round(profilesSize / 1024),   // KB
      total: Math.round(totalSize / 1024)              // KB
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ── 计算目录大小 ───────────────────────────────────────────────────
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;

  let totalSize = 0;
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      totalSize += getDirSize(filePath);
    } else {
      totalSize += stat.size;
    }
  }

  return totalSize;
}

// ── 获取仪表盘汇总数据 ──────────────────────────────────────────────
function getDashboardSummary() {
  const knowledgeStats = getKnowledgeStats();
  const userStats = getUserActivityStats();
  const systemHealth = getSystemHealth();

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalKnowledgeDocs: knowledgeStats.totalDocs,
      totalUsers: userStats.totalUsers,
      totalInteractions: userStats.totalInteractions,
      systemStatus: systemHealth.status
    },
    knowledgeBase: knowledgeStats,
    userActivity: userStats,
    systemHealth
  };
}

// ── 生成报告（用于定期导出）─────────────────────────────────────────
function generateReport() {
  const dashboard = getDashboardSummary();

  const report = {
    generatedAt: new Date().toISOString(),
    period: 'all', // 可以支持时间段
    ...dashboard
  };

  // 保存报告到文件（可选）
  const reportDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const reportFile = path.join(reportDir, `report_${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  return {
    report,
    savedTo: reportFile
  };
}

module.exports = {
  getKnowledgeStats,
  getUserActivityStats,
  getRetrievalStats,
  getSystemHealth,
  getDashboardSummary,
  generateReport,
  getDiskUsage
};