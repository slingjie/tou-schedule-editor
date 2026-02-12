# 部署速查表

## 🚀 常用命令

```bash
# 开发
npm run dev                    # 启动开发服务器

# 构建
npm run build                  # 构建生产版本

# 部署
npm run deploy                 # 部署到 Cloudflare
# 或
npx wrangler pages deploy dist --project-name=tou-schedule-editor

# Git 操作
git add .
git commit -m "message"
git push origin main
```

## 🔗 重要地址

| 环境 | URL |
|------|-----|
| **生产环境** | https://eaf183da.tou-schedule-editor.pages.dev |
| **本地开发** | http://localhost:5173 |
| **GitHub** | https://github.com/slingjie/tou-schedule-editor |
| **Dashboard** | https://dash.cloudflare.com |

## 📡 API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/` | GET | 服务信息 |
| `/api/health` | GET | 健康检查 |
| `/api/analyze` | POST | 数据分析 |
| `/api/calculate-profit` | POST | 收益计算 |
| `/api/config` | GET | 配置信息 |

## 🐛 故障速查

| 问题 | 解决 |
|------|------|
| 构建失败 | `rm -rf node_modules && npm install && npm run build` |
| 部署失败 | `npx wrangler login` 重新登录 |
| API 404 | 检查 `functions/api/` 目录是否存在 |
| CORS 错误 | 确认 API 响应包含 CORS headers |

## ⚙️ 配置文件

| 文件 | 用途 |
|------|------|
| `.env.local` | 环境变量 |
| `wrangler.toml` | Cloudflare 配置 |
| `package.json` | 依赖和脚本 |
| `vite.config.ts` | Vite 配置 |

## 📁 项目结构

```
├── src/              # React 前端代码
├── functions/api/    # 后端 API (Pages Functions)
├── dist/             # 构建输出
├── public/           # 静态资源
└── *.config.*        # 配置文件
```

## 🔑 环境变量

```bash
# .env.local
VITE_BACKEND_BASE_URL=https://[domain].pages.dev
GEMINI_API_KEY=your_key
```

## 💡 快速开发流程

1. `npm run dev` - 开发
2. `npm run build` - 构建
3. `npm run deploy` - 部署
4. `git push` - 推送代码

## 📞 求助

- 查看完整文档: `DEPLOYMENT_GUIDE.md`
- Cloudflare 文档: https://developers.cloudflare.com/pages/
