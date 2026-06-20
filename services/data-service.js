/**
 * 数据服务模块
 * 统一管理工具使用的数据，支持从配置文件加载，未来可扩展为API数据源
 */

const fs = require('fs');
const path = require('path');

// 数据缓存
let cachedData = null;
let lastLoadTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 加载数据配置文件
 */
function loadData() {
  try {
    const dataPath = path.join(__dirname, '../data/tools-data.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    console.error('加载数据配置文件失败:', error.message);
    // 返回默认空数据避免程序崩溃
    return {
      orders: {},
      schedules: {},
      learningPaths: {},
      discounts: {},
      comfortTemplates: {}
    };
  }
}

/**
 * 获取数据（带缓存）
 */
function getData() {
  const now = Date.now();
  if (!cachedData || (now - lastLoadTime) > CACHE_TTL) {
    cachedData = loadData();
    lastLoadTime = now;
  }
  return cachedData;
}

/**
 * 获取订单数据
 * @param {string} orderId - 订单ID
 * @returns {Object|null} 订单信息或null
 */
function getOrder(orderId) {
  const data = getData();
  return data.orders[orderId] || null;
}

/**
 * 获取所有订单数据（用于调试）
 */
function getAllOrders() {
  const data = getData();
  return data.orders;
}

/**
 * 获取排课数据
 * @param {string} subject - 学科名称
 * @returns {Array|null} 排课列表或null
 */
function getSchedule(subject) {
  const data = getData();
  return data.schedules[subject] || null;
}

/**
 * 获取所有排课数据（用于调试）
 */
function getAllSchedules() {
  const data = getData();
  return data.schedules;
}

/**
 * 获取学习路径
 * @param {string} level - 水平等级 (poor/medium/good)
 * @returns {Object|null} 学习路径配置或null
 */
function getLearningPath(level) {
  const data = getData();
  return data.learningPaths[level] || data.learningPaths['medium'];
}

/**
 * 获取折扣配置
 * @param {string} discountType - 折扣类型
 * @returns {Object|null} 折扣配置或null
 */
function getDiscount(discountType) {
  const data = getData();
  return data.discounts[discountType] || null;
}

/**
 * 获取所有折扣配置（用于调试）
 */
function getAllDiscounts() {
  const data = getData();
  return data.discounts;
}

/**
 * 获取情感安抚模板
 * @param {string} emotion - 情绪类型
 * @returns {string} 安抚模板
 */
function getComfortTemplate(emotion) {
  const data = getData();
  return data.comfortTemplates[emotion] || data.comfortTemplates['frustrated'];
}

/**
 * 重新加载数据（用于开发热重载）
 */
function reloadData() {
  cachedData = loadData();
  lastLoadTime = Date.now();
  return cachedData;
}

module.exports = {
  // 数据获取方法
  getOrder,
  getAllOrders,
  getSchedule,
  getAllSchedules,
  getLearningPath,
  getDiscount,
  getAllDiscounts,
  getComfortTemplate,

  // 数据管理
  getData,
  reloadData,

  // 常量
  CACHE_TTL
};