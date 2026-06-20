const { Router } = require('express');
const jwt        = require('jsonwebtoken');
const User       = require('../models/User');
const config     = require('../config');

const router = Router();

function makeToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), username: user.username },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/** POST /api/auth/register */
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: '用户名和密码不能为空' });
    if (username.length < 2 || username.length > 20)
      return res.status(400).json({ error: '用户名长度 2~20 位' });
    if (password.length < 6)
      return res.status(400).json({ error: '密码至少 6 位' });

    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ error: '用户名已存在' });

    const user = new User({ username, password });
    await user.save();

    res.json({ token: makeToken(user), username });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

/** POST /api/auth/login */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: '用户名和密码不能为空' });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });

    res.json({ token: makeToken(user), username });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

module.exports = router;
