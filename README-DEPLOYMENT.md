# 📚 部署文档索引

所有部署相关文档已创建完成：

## 主要文档

| 文档 | 用途 | 说明 |
|------|------|------|
| **DEPLOYMENT_GUIDE.md** | 📖 完整部署指南 | 详细的部署流程、配置说明、开发工作流 |
| **CHEATSHEET.md** | ⚡ 速查表 | 常用命令、URL、快速参考 |
| **DEPLOY_SUCCESS.md** | ✅ 部署总结 | 当前部署状态、测试方法 |
| **functions/README.md** | 🔧 Functions 文档 | 后端 API 开发说明 |

## 快速开始

### 查看完整指南
```bash
cat DEPLOYMENT_GUIDE.md
```

### 查看速查表
```bash
cat CHEATSHEET.md
```

## 当前部署状态

- ✅ **前端**: https://eaf183da.tou-schedule-editor.pages.dev
- ✅ **后端 API**: 同上（Pages Functions）
- ✅ **GitHub**: https://github.com/slingjie/tou-schedule-editor

## 技术栈

- **前端**: React + Vite + TypeScript
- **后端**: Cloudflare Pages Functions (JavaScript)
- **部署**: Cloudflare Pages
- **托管**: GitHub

## 后续开发

1. 阅读 `DEPLOYMENT_GUIDE.md` 了解完整流程
2. 使用 `CHEATSHEET.md` 快速查阅命令
3. 参考 `functions/README.md` 开发后端 API

## 部署只需3步

```bash
npm run build    # 构建
npm run deploy   # 部署
git push         # 推送
```

---

所有文档已提交到 GitHub，可随时查阅！
