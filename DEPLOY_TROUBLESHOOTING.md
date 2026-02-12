# 部署问题排查记录

## 问题：上传负荷文件后无结果显示

**现象**：部署到 Cloudflare Pages 后，点击「上传负荷文件」按钮选择 CSV/XLSX 文件，按钮短暂显示「处理中」后恢复，但页面无图表、无数据、无报错提示。

**排查时间**：2026-02-12

---

## 根因分析

经第一性原理逐层追踪（按钮点击 → 文件处理 → API 请求 → 后端解析 → 前端渲染），发现 **3 个同时存在的 Bug**：

### 根因 1（致命）：API 请求发到了错误的域名

| 项目 | 说明 |
|------|------|
| **文件** | `.env.local` |
| **问题** | `VITE_BACKEND_BASE_URL=https://4c5ac2be.tou-schedule-editor.pages.dev`（旧部署 URL） |
| **影响** | Vite 构建时将此值烘焙进产物，所有 API 请求发往旧域名 → 404 或跨域失败 |
| **修复** | `VITE_BACKEND_BASE_URL=`（留空，Cloudflare Pages Functions 与前端同源） |

**原理**：Cloudflare Pages 每次部署生成唯一子域名（如 `868d67e6.xxx`），而 Pages Functions 始终与前端同源。写死任何特定部署 URL 都会在下一次部署后失效。

### 根因 2：XLSX 文件未转换直接上传

| 项目 | 说明 |
|------|------|
| **文件** | `loadApi.ts` → `analyzeLoadFileWithProgress()` |
| **问题** | App.tsx 全局上传按钮使用 XHR 版本上传函数，该函数**跳过了 XLSX→CSV 预处理** |
| **影响** | XLSX 二进制文件直接发给后端 → 后端用 TextDecoder 解码得到乱码 → 解析出 0 条数据 |
| **修复** | 在 XHR 发送前调用 `preprocessFile()` 将 XLSX 转为 CSV |

### 根因 3：CSV 正则表达式破坏时间戳

| 项目 | 说明 |
|------|------|
| **文件** | `functions/api/load/analyze.js` |
| **问题** | 正则 `[^",\s]+` 中的 `\s` 在**空格处断开**时间戳（如 `2023-01-01 00:00:00`） |
| **影响** | 2 列 CSV 被错误解析为 3 列 → 数据结构错位 → 数值解析 NaN |
| **修复** | 改用 `line.split(',')` 简单分割，不破坏字段内的空格 |

### 附带修复：后端 API 响应字段名不匹配

| 后端原字段 | 前端期望字段 | 说明 |
|-----------|------------|------|
| `points` | `cleaned_points` | 数据点数组 |
| `quality_report` | `report` | 质量报告（含 `missing`/`anomalies`/`continuous_zero_spans`） |
| `load_kw` | `load_kwh` | 单条数据的负荷值字段 |

---

## 教训总结

1. **Cloudflare Pages Functions 是同源的**，`VITE_BACKEND_BASE_URL` 在生产环境必须留空。
2. **同一功能的两个代码路径**（`analyzeLoadFile` vs `analyzeLoadFileWithProgress`）必须保持行为一致。
3. **CSV 解析不要用花哨正则**，`split(',')` 对 99% 的场景足够且不会引入意外。
4. **API 契约（字段名）必须与 TypeScript 接口定义严格一致**，建议后端 JSON key 与 `types.ts` 接口逐字段比对。
