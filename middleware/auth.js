const jwt    = require('jsonwebtoken');
const config = require('../config');

module.exports = function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录，请先登录' });
  try {
    req.user = jwt.verify(token, config.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 已过期，请重新登录' });
  }
};
