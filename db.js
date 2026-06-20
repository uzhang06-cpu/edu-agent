const mongoose = require('mongoose');
const config   = require('./config');

mongoose.connect(config.MONGODB_URI)
  .then(() => console.log('✅ MongoDB 连接成功'))
  .catch(err => console.error('❌ MongoDB 连接失败:', err));

module.exports = mongoose;
