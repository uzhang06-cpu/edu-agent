/**
 * 错误处理服务模块
 * 提供统一的错误分类、用户友好错误信息和错误恢复建议
 */

/**
 * 错误类型定义
 */
const ErrorTypes = {
  // API相关错误
  API_KEY_NOT_SET: 'API_KEY_NOT_SET',
  API_TIMEOUT: 'API_TIMEOUT',
  API_QUOTA_EXCEEDED: 'API_QUOTA_EXCEEDED',
  API_NETWORK_ERROR: 'API_NETWORK_ERROR',
  API_RATE_LIMIT: 'API_RATE_LIMIT',

  // 工具相关错误
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_DISABLED: 'TOOL_DISABLED',
  TOOL_EXECUTION_ERROR: 'TOOL_EXECUTION_ERROR',
  TOOL_PARAM_INVALID: 'TOOL_PARAM_INVALID',

  // 知识库相关错误
  KNOWLEDGE_LOAD_ERROR: 'KNOWLEDGE_LOAD_ERROR',
  KNOWLEDGE_SEARCH_ERROR: 'KNOWLEDGE_SEARCH_ERROR',

  // 系统错误
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  FILE_SYSTEM_ERROR: 'FILE_SYSTEM_ERROR',
  MEMORY_ERROR: 'MEMORY_ERROR',

  // 用户输入错误
  INVALID_INPUT: 'INVALID_INPUT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',

  // Agent流程错误
  AGENT_PIPELINE_ERROR: 'AGENT_PIPELINE_ERROR',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT'
};

/**
 * 错误严重级别
 */
const ErrorSeverity = {
  CRITICAL: 'CRITICAL',    // 系统无法继续运行
  HIGH: 'HIGH',            // 功能严重受限
  MEDIUM: 'MEDIUM',        // 功能部分受限
  LOW: 'LOW',              // 轻微问题，可降级处理
  INFO: 'INFO'             // 信息性错误，不影响功能
};

/**
 * 错误信息映射表
 * 键：错误类型
 * 值：{ userMessage, developerMessage, recoverySuggestion, severity }
 */
const ErrorMapping = {
  [ErrorTypes.API_KEY_NOT_SET]: {
    userMessage: 'AI服务配置需要更新，请联系系统管理员设置API密钥。',
    developerMessage: 'DeepSeek API Key未配置或无效。',
    recoverySuggestion: '请检查config.js或.env文件中的DEEPSEEK_API_KEY设置。',
    severity: ErrorSeverity.CRITICAL,
    shouldRetry: false
  },

  [ErrorTypes.API_TIMEOUT]: {
    userMessage: 'AI服务响应超时，请稍后再试。',
    developerMessage: 'DeepSeek API请求超时。',
    recoverySuggestion: '请检查网络连接，或稍后重试。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: true,
    retryDelay: 5000
  },

  [ErrorTypes.API_QUOTA_EXCEEDED]: {
    userMessage: 'AI服务使用量已达上限，请稍后再试。',
    developerMessage: 'DeepSeek API配额已用完。',
    recoverySuggestion: '请等待配额重置（通常每月1日），或联系管理员增加配额。',
    severity: ErrorSeverity.HIGH,
    shouldRetry: true,
    retryDelay: 3600000 // 1小时
  },

  [ErrorTypes.API_NETWORK_ERROR]: {
    userMessage: '网络连接异常，请检查网络后重试。',
    developerMessage: '网络请求失败。',
    recoverySuggestion: '请检查网络连接，确保可以访问https://api.deepseek.com。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: true,
    retryDelay: 3000
  },

  [ErrorTypes.TOOL_NOT_FOUND]: {
    userMessage: '请求的功能暂时不可用。',
    developerMessage: `工具不存在: {toolName}`,
    recoverySuggestion: '请使用其他功能，或联系技术支持。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: false
  },

  [ErrorTypes.TOOL_EXECUTION_ERROR]: {
    userMessage: '功能执行时遇到问题，请稍后重试。',
    developerMessage: `工具执行失败: {toolName} - {errorMessage}`,
    recoverySuggestion: '请稍后重试，如果问题持续请联系技术支持。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: true,
    retryDelay: 2000
  },

  [ErrorTypes.KNOWLEDGE_LOAD_ERROR]: {
    userMessage: '知识库加载失败，部分功能可能受限。',
    developerMessage: '知识库文件加载失败。',
    recoverySuggestion: '请检查knowledge/db目录下的JSON文件格式是否正确。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: true,
    retryDelay: 5000
  },

  [ErrorTypes.INTERNAL_ERROR]: {
    userMessage: '系统内部错误，请稍后再试。',
    developerMessage: '未处理的内部错误。',
    recoverySuggestion: '请重启服务，如果问题持续请联系技术支持。',
    severity: ErrorSeverity.HIGH,
    shouldRetry: true,
    retryDelay: 10000
  },

  [ErrorTypes.INVALID_INPUT]: {
    userMessage: '输入格式不正确，请重新输入。',
    developerMessage: '用户输入验证失败。',
    recoverySuggestion: '请检查输入格式，确保符合要求。',
    severity: ErrorSeverity.LOW,
    shouldRetry: false
  },

  [ErrorTypes.SESSION_NOT_FOUND]: {
    userMessage: '会话不存在或已过期，请重新开始对话。',
    developerMessage: '会话ID未找到。',
    recoverySuggestion: '请刷新页面或开始新的对话。',
    severity: ErrorSeverity.LOW,
    shouldRetry: false
  },

  [ErrorTypes.AGENT_PIPELINE_ERROR]: {
    userMessage: 'AI处理流程遇到问题，请稍后重试。',
    developerMessage: 'Agent流水线执行失败。',
    recoverySuggestion: '请稍后重试，如果问题持续请联系技术支持。',
    severity: ErrorSeverity.HIGH,
    shouldRetry: true,
    retryDelay: 3000
  },

  [ErrorTypes.AGENT_TIMEOUT]: {
    userMessage: 'AI处理超时，请稍后重试或简化问题。',
    developerMessage: 'Agent流水线执行超时。',
    recoverySuggestion: '请简化问题描述，或稍后重试。',
    severity: ErrorSeverity.MEDIUM,
    shouldRetry: true,
    retryDelay: 5000
  }
};

/**
 * 格式化错误信息
 * @param {string} errorType - 错误类型
 * @param {Object} context - 错误上下文信息
 * @returns {Object} 格式化的错误信息
 */
function formatError(errorType, context = {}) {
  const errorConfig = ErrorMapping[errorType] || ErrorMapping[ErrorTypes.INTERNAL_ERROR];

  // 替换模板变量
  let userMessage = errorConfig.userMessage;
  let developerMessage = errorConfig.developerMessage;
  let recoverySuggestion = errorConfig.recoverySuggestion;

  // 替换上下文变量
  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{${key}}`;
    userMessage = userMessage.replace(placeholder, value);
    developerMessage = developerMessage.replace(placeholder, value);
    recoverySuggestion = recoverySuggestion.replace(placeholder, value);
  }

  return {
    errorType,
    userMessage,
    developerMessage,
    recoverySuggestion,
    severity: errorConfig.severity,
    shouldRetry: errorConfig.shouldRetry || false,
    retryDelay: errorConfig.retryDelay || 0,
    timestamp: new Date().toISOString(),
    context
  };
}

/**
 * 从异常对象推断错误类型
 * @param {Error} error - 异常对象
 * @returns {string} 错误类型
 */
function inferErrorType(error) {
  if (error.code === 'API_KEY_NOT_SET') {
    return ErrorTypes.API_KEY_NOT_SET;
  }

  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return ErrorTypes.API_NETWORK_ERROR;
  }

  if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
    return ErrorTypes.API_TIMEOUT;
  }

  if (error.response?.status === 429) {
    return ErrorTypes.API_RATE_LIMIT;
  }

  if (error.response?.status === 401 || error.response?.status === 403) {
    return ErrorTypes.API_KEY_NOT_SET;
  }

  if (error.message?.includes('工具') || error.message?.includes('tool')) {
    if (error.message.includes('不存在') || error.message.includes('not found')) {
      return ErrorTypes.TOOL_NOT_FOUND;
    }
    return ErrorTypes.TOOL_EXECUTION_ERROR;
  }

  if (error.message?.includes('知识库') || error.message?.includes('knowledge')) {
    return ErrorTypes.KNOWLEDGE_LOAD_ERROR;
  }

  if (error.message?.includes('会话') || error.message?.includes('session')) {
    return ErrorTypes.SESSION_NOT_FOUND;
  }

  return ErrorTypes.INTERNAL_ERROR;
}

/**
 * 记录错误日志
 * @param {Object} formattedError - 格式化的错误信息
 */
function logError(formattedError) {
  const logEntry = {
    timestamp: formattedError.timestamp,
    errorType: formattedError.errorType,
    severity: formattedError.severity,
    userMessage: formattedError.userMessage,
    developerMessage: formattedError.developerMessage,
    context: formattedError.context
  };

  // 控制台输出
  console.error('[错误日志]', logEntry);

  // 严重错误额外输出
  if (formattedError.severity === ErrorSeverity.CRITICAL || formattedError.severity === ErrorSeverity.HIGH) {
    console.error('[严重错误]', formattedError.developerMessage, formattedError.context);
  }

  // 这里可以添加文件日志、监控系统上报等
  return logEntry;
}

/**
 * 处理错误的主函数
 * @param {Error|string} error - 错误对象或错误消息
 * @param {Object} context - 错误上下文
 * @returns {Object} 用户友好的错误响应
 */
function handleError(error, context = {}) {
  // 确定错误类型
  const errorType = typeof error === 'string' ? error : inferErrorType(error);

  // 添加额外的上下文信息
  const fullContext = {
    ...context,
    originalMessage: error.message || error,
    stack: error.stack
  };

  // 格式化错误信息
  const formattedError = formatError(errorType, fullContext);

  // 记录日志
  logError(formattedError);

  // 返回用户友好的错误信息
  return {
    success: false,
    error: formattedError.errorType,
    message: formattedError.userMessage,
    recoverySuggestion: formattedError.recoverySuggestion,
    developerMessage: formattedError.developerMessage,
    shouldRetry: formattedError.shouldRetry,
    retryDelay: formattedError.retryDelay
  };
}

/**
 * 判断错误是否应该重试
 * @param {Object} errorResponse - 错误响应对象
 * @returns {boolean} 是否应该重试
 */
function shouldRetry(errorResponse) {
  return errorResponse.shouldRetry === true;
}

/**
 * 获取重试延迟时间
 * @param {Object} errorResponse - 错误响应对象
 * @returns {number} 重试延迟时间（毫秒）
 */
function getRetryDelay(errorResponse) {
  return errorResponse.retryDelay || 0;
}

module.exports = {
  ErrorTypes,
  ErrorSeverity,
  formatError,
  inferErrorType,
  logError,
  handleError,
  shouldRetry,
  getRetryDelay
};