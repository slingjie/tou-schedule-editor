# Cloudflare Pages Functions Backend

已创建的 API 端点：

## 端点列表

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/` | GET | 服务信息 |
| `/api/health` | GET | 健康检查 |
| `/api/analyze` | POST | 数据分析 |
| `/api/calculate-profit` | POST | 收益计算 |
| `/api/config` | GET | 配置信息 |

## 测试 API

```bash
# 健康检查
curl https://4c5ac2be.tou-schedule-editor.pages.dev/api/health

# 服务信息
curl https://4c5ac2be.tou-schedule-editor.pages.dev/api/

# 数据分析
curl -X POST https://4c5ac2be.tou-schedule-editor.pages.dev/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"prices":[0.5,0.8,1.2,0.6],"time_slots":[]}'

# 收益计算
curl -X POST https://4c5ac2be.tou-schedule-editor.pages.dev/api/calculate-profit \
  -H "Content-Type: application/json" \
  -d '{"capacity_mwh":10,"efficiency":0.85}'
```

## 部署

```bash
npm run deploy
```
