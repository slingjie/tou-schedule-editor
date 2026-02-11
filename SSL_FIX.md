# SSL 证书问题修复指南

## 🔍 问题原因
Cloudflare Pages 新部署项目时，SSL 证书可能需要几分钟才能完全激活。

## ✅ 解决方案

### 方法 1: 使用新部署地址
**新地址**: https://4c5ac2be.tou-schedule-editor.pages.dev

旧地址可能因为证书问题无法访问，新部署的地址应该可以正常访问。

### 方法 2: 等待证书激活
通常需要 5-15 分钟。在此期间：
- 使用 http:// 而不是 https:// 访问（会自动跳转）
- 或者稍后再试

### 方法 3: 清除浏览器缓存
```
1. 按 Ctrl+Shift+R (Windows) 或 Cmd+Shift+R (Mac) 强制刷新
2. 或者按 F12 打开开发者工具 → Network → 勾选 Disable cache → 刷新页面
```

### 方法 4: 检查本地网络
某些网络（公司/学校）可能会拦截 SSL 连接：
- 尝试使用手机热点
- 或者使用 VPN

### 方法 5: 使用其他浏览器
Chrome、Firefox、Edge 都试一遍

## 🔧 测试 SSL 状态

```bash
# 检查 SSL 证书
curl -I https://4c5ac2be.tou-schedule-editor.pages.dev

# 或者使用在线工具
# https://www.ssllabs.com/ssltest/
```

## 📊 当前部署状态

| 部署 ID | 时间 | 地址 |
|---------|------|------|
| 4c5ac2be | 刚刚 | https://4c5ac2be.tou-schedule-editor.pages.dev |
| f62f976f | 7分钟前 | https://f62f976f.tou-schedule-editor.pages.dev |

主域名: https://tou-schedule-editor.pages.dev

## 🚀 推荐操作

1. **立即尝试**: https://4c5ac2be.tou-schedule-editor.pages.dev
2. 如果不行，等待 10 分钟再试
3. 检查 Cloudflare Dashboard: https://dash.cloudflare.com
4. 查看 SSL 证书状态

## 💡 备用访问方式

如果 HTTPS 仍有问题，可以尝试：

```bash
# 本地预览构建结果
npm run preview
# 然后访问 http://localhost:4173
```
