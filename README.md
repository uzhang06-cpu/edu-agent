# 🌟 星光教育 AI 智能助手 — 后端

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key（选其一）
cp .env.example .env
# 编辑 .env，填写你的 DEEPSEEK_API_KEY

# 3. 启动服务
node server.js

# 4. 浏览器访问
open http://localhost:3000
```

---

## 🔑 API Key 在哪里改？

**方式 1（推荐）：** 创建 `.env` 文件
```
DEEPSEEK_API_KEY=sk-你的真实key
```

**方式 2：** 直接修改 `config.js` 第 20 行
```javascript
DEEPSEEK_API_KEY: 'sk-你的真实key',
```

> DeepSeek API Key 申请地址：https://platform.deepseek.com/api_keys

---

## 📁 项目结构

```
├── server.js              # 入口（Express + Socket.IO）
├── config.js              # 🔑 全局配置（含 API Key）
├── index.html             # 前端（原样保留）
├── package.json
├── .env.example           # 环境变量示例
│
├── agent/
│   └── pipeline.js        # 5步Agent流水线（核心逻辑）
│
├── knowledge/             # RAG 知识库
│   ├── index.js           # 检索引擎 + CRUD API
│   └── db/
│       ├── courses_kb.json   # 课程知识
│       ├── faq_kb.json       # 常见问题
│       └── teachers_kb.json  # 教师信息
│
├── skills/
│   └── index.js           # 技能注册表（插排式）
│
├── tools/
│   └── index.js           # 工具注册表（插排式）
│
└── workflows/
    └── index.js           # 工作流注册表（插排式）
```

---

## 📡 API 接口一览

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查（前端启动时调用）|
| `/api/courses` | GET | 获取课程列表（左侧栏）|
| `/api/knowledge` | GET | 列出所有知识库文档 |
| `/api/knowledge/search?q=...` | GET | 知识库检索 |
| `/api/knowledge/:id` | GET/PUT/DELETE | 文档 CRUD |
| `/api/knowledge` | POST | 新增文档 |
| `/api/skills` | GET | 列出所有技能 |
| `/api/skills/:name` | GET/PATCH | 获取/启用禁用技能 |
| `/api/tools` | GET | 列出所有工具 |
| `/api/tools/:name` | GET/PATCH | 获取/启用禁用工具 |
| `/api/tools/test` | POST | 测试执行工具 |
| `/api/workflows` | GET | 列出所有工作流 |
| `/api/workflows/:name` | GET/PATCH | 获取/修改工作流 |
| `/api/workflows/utils/match?scenario=...` | GET | 预览场景匹配 |

---

## 🧠 Agent 流水线

每条消息经历 5 步（根据工作流可跳过某些步骤）：

```
感知(Perceive) → 规划(Plan) → 执行(Execute) → 复盘(Review) → 定论(Conclude)
    ↓                ↓              ↓                ↓              ↓
分析意图/情绪    制定策略       RAG检索+生成       质检评分       达标输出/不达标重写
```

---

## 🔌 插排式扩展

### 添加新工具（tools/index.js）
```javascript
{
  name: 'my_tool',
  label: '我的工具',
  description: '工具描述（会注入LLM上下文）',
  params: { param1: '参数说明' },
  enabled: true,
  execute: async ({ param1 }) => {
    // 实现逻辑
    return { result: '...' };
  }
}
```

### 添加新技能（skills/index.js）
```javascript
{
  name: 'my_skill',
  label: '我的技能',
  trigger: (ctx) => ctx.perception?.emotion === '愤怒',  // 触发条件
  enabled: true,
  preprocess: async (ctx) => ({
    systemAppend: '这是注入到系统提示的内容'
  })
}
```

### 添加新工作流（workflows/index.js）
```javascript
{
  name: 'my_workflow',
  label: '我的工作流',
  priority: 95,  // 数字越大优先级越高
  enabled: true,
  match: (perception) => perception?.scenario === '我的场景',
  steps: ['perceive', 'execute', 'conclude'],  // 自定义步骤
  systemPrompt: '这个工作流的系统提示词'
}
```

### 添加新知识（直接通过 API）
```bash
curl -X POST http://localhost:3000/api/knowledge \
  -H "Content-Type: application/json" \
  -d '{"title":"新知识标题","tags":["关键词1"],"content":"知识内容"}'
```
