# Agent 项目备忘录

本文件记录开发和部署过程中踩过的坑，所有 AI Agent 在修改本项目时**必须遵守**以下规则。

---

## 🔴 Cloudflare Pages 部署规则

1. **`VITE_BACKEND_BASE_URL` 必须留空**
   - Cloudflare Pages Functions 与前端同源，不需要指定 Base URL
   - 每次部署生成不同子域名，写死任何 URL 都会在下次部署后失效
   - `.env.local` 中保持 `VITE_BACKEND_BASE_URL=`

2. **后端 API 响应字段必须匹配 `types.ts` 接口**
   - `BackendLoadAnalysisResponse` 要求 `cleaned_points`（不是 `points`）
   - `BackendCleanedLoadPoint` 要求 `load_kwh`（不是 `load_kw`）
   - `report` 字段需含 `missing`、`anomalies`、`continuous_zero_spans`
   - 修改后端 JSON 响应前，先查看 `types.ts` 确认字段名

## 🟡 代码一致性规则

3. **`loadApi.ts` 中两个上传函数必须保持行为一致**
   - `analyzeLoadFile`（fetch 版）和 `analyzeLoadFileWithProgress`（XHR 版）
   - 两者都必须调用 `preprocessFile()` 进行 XLSX→CSV 预处理
   - 修改一个时必须检查另一个是否需要同步修改

## 🟡 CSV 解析规则

4. **后端 CSV 解析使用 `split(',')` 而非正则**
   - 时间戳字段可能含空格（如 `2023-01-01 00:00:00`），正则 `\s` 会错误断裂
   - `functions/api/load/analyze.js` 中使用 `line.split(',')` 作为主解析方式

## 🟡 后端数据返回规则

5. **不要硬编码数据点上限**
   - 典型负荷 CSV 有 3 万+ 行（15 分钟间隔 × 1 年），截断会丢失大部分月份数据
   - `analyze.js` 必须返回全部 `cleaned_points`，不得使用 `.slice(0, N)`

6. **后端 API 必须正确处理请求 Content-Type**
   - 前端 `storageApi.ts` 使用 `FormData` 发送请求，后端必须用 `request.formData()` 而非 `request.json()`
   - 对 FormData 请求调用 `request.json()` 会产生 JSON 解析错误（如 `No number after minus sign`）
   - 后端应检查 `Content-Type` 头，分别处理 `multipart/form-data` 和 `application/json`
