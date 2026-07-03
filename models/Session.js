const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role:     { type: String, enum: ['user', 'assistant'] },
  content:  { type: String },
  scenario: { type: String },   // assistant 消息的场景（用于历史重载还原 badge）
}, { _id: false });

const sessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:      { type: String, default: '新咨询项目' },
  summary:    { type: String, default: '' },
  messages:   [messageSchema],
  createdAt:  { type: Date, default: Date.now },
  lastUpdate: { type: Date, default: Date.now }
});

// 让 toJSON 输出 id 字段（前端兼容）
sessionSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Session', sessionSchema);
