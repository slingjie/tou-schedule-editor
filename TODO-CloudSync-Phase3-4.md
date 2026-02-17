# 云端同步 — 未完成任务文档

> 生成日期：2026-02-16
> Phase 1（基础设施 + 云端写入）：✅ 已完成
> Phase 2（云端拉取 + 双向同步）：✅ 已完成
> Phase 3（UI 指示 + 打磨）：🔲 未开始
> Phase 4（用户认证）：🔲 未开始

---

## 已完成工作回顾

### Phase 1 已交付

- D1 数据库 `tou-schedule-db`（ID: `a84a7d8e-fde5-4aac-a540-2b3cf77aad42`）
- R2 存储桶 `tou-schedule-storage`
- `wrangler.toml` — Pages 绑定 D1 + R2
- `migrations/0001_init.sql` — 7 张表（devices, projects, datasets, runs, run_artifacts, tou_configs, sync_cursors）
- `functions/api/sync/register.js` — POST 设备注册
- `functions/api/sync/push.js` — POST 批量推送实体到 D1
- `functions/api/sync/upload.js` — POST 上传大文件到 R2
- `cloudSyncApi.ts` — HTTP 客户端
- `cloudSyncManager.ts` — 推送队列 + 2 秒去抖
- `localProjectStore.ts` — 9 个写操作函数添加 `enqueuePush()` hook
- `api.ts` — `saveConfiguration` / `deleteConfiguration` 添加 `enqueuePush()` hook

### Phase 2 已交付

- `functions/api/sync/pull.js` — GET 增量拉取（已修复：不按 device_id 过滤）
- `functions/api/sync/download/[[key]].js` — GET R2 文件下载
- `cloudSyncApi.ts` — 添加 `pullEntities()`、`downloadBlob()` 及类型定义
- `cloudSyncManager.ts` — 完整双向同步：`initSync()`、`pullFromCloud()`、5 分钟定时拉取、online/offline 监听、`_skipSync` 防循环
- `localProjectStore.ts` — DB_VERSION 2→3，新增 `sync_meta` store，导出 `upsertProject`/`upsertDatasetWithPoints`/`upsertRunWithArtifacts`
- `index.tsx` — 启动时调用 `initSync()`

---

## Phase 3：UI 指示 + 打磨

### 任务 3.1：App 顶栏添加同步状态指示器

**目标**：让用户随时知道同步状态。

**需求详情**：

- 在 `App.tsx` 的 `<header>` 导航栏右侧添加一个同步状态图标
- 四种状态对应不同的视觉表现：
  | 状态 | 图标/样式 | 说明 |
  |------|-----------|------|
  | `idle` | 绿色圆点或 ✓ | 已同步，一切正常 |
  | `syncing` | 旋转动画 | 正在同步中 |
  | `offline` | 灰色/黄色断开图标 | 离线状态 |
  | `error` | 红色 ✗ | 同步出错，hover 显示错误信息 |
- 显示上次同步时间（如 "2 分钟前"）
- 使用 `cloudSyncManager.ts` 已有的 API：
  ```typescript
  import { getSyncStatus, onSyncStatusChange } from './cloudSyncManager';
  // getSyncStatus() 返回 { state, lastPullAt, pendingPushCount, lastError }
  // onSyncStatusChange(callback) 返回取消订阅函数
  ```

**涉及文件**：

- 新建 `components/SyncStatusIndicator.tsx` — 同步状态组件
- 修改 `App.tsx` — 在 `<header>` 的 `<nav>` 右侧引入组件

**实现要点**：

- 组件内部用 `useState` + `useEffect` 订阅 `onSyncStatusChange`
- 不需要 Context，直接调用 `getSyncStatus()` 即可
- 当前 header 结构：`<nav className="mt-2 flex items-center justify-between gap-4">` 内有左侧上传按钮和右侧标签组，状态指示器放在标签组右边或 nav 最右侧

### 任务 3.2：手动"立即同步"按钮

**目标**：用户可以主动触发一次完整同步。

**需求详情**：

- 点击同步状态指示器时触发手动同步
- 或在指示器旁边放一个小按钮（刷新图标）
- 点击后调用：
  ```typescript
  import { flushPendingSync, pullFromCloud } from './cloudSyncManager';
  await flushPendingSync(); // 先推送所有待推送数据
  await pullFromCloud();    // 再拉取最新数据
  ```
- 同步期间按钮显示 loading 状态，防止重复点击

**涉及文件**：

- `components/SyncStatusIndicator.tsx` — 在同一组件中实现

### 任务 3.3：大文件上传失败重试

**目标**：R2 上传偶尔失败时自动重试一次。

**需求详情**：

- 在 `cloudSyncManager.ts` 的 `uploadToR2()` 函数中添加重试逻辑
- 策略：失败后等待 2 秒，重试 1 次（指数退避）
- 仅对网络错误和 5xx 错误重试，4xx 错误不重试
- 当前 `uploadToR2` 实现：
  ```typescript
  // cloudSyncManager.ts
  export async function uploadToR2(r2Key: string, body: Blob | ArrayBuffer, contentType?: string): Promise<void> {
    await ensureRegistered();
    await uploadBlob({ device_id: getDeviceId(), r2_key: r2Key, body, content_type: contentType });
  }
  ```

**涉及文件**：

- `cloudSyncManager.ts` — 修改 `uploadToR2()` 添加重试

### 任务 3.4：移除旧的 local-sync/snapshot.js 方案

**目标**：清理已被 D1+R2 云同步完全替代的旧 Cache API 伪持久化代码。

**需求详情**：

需要移除的文件和代码：

1. **删除文件**：`functions/api/local-sync/snapshot.js` — 旧的 Cache API 快照端点
2. **删除文件**：`local_sync_store/snapshot.json` — 本地快照文件
3. **清理 openapi 注册**：`functions/openapi.json.js` 中包含 `/api/local-sync/snapshot` 的路由定义，需移除
4. **清理前端调用**：`components/ProjectDatasetsPage.tsx` 中有大量 `/api/local-sync/snapshot` 相关代码（约第 260-337 行），包括：
   - `ensureBackendSupports('项目数据本地同步拉取', ['/api/local-sync/snapshot'])` 调用
   - `fetch(\`${getLocalSyncBaseUrl()}/api/local-sync/snapshot\`)` GET 拉取
   - `fetch(\`${getLocalSyncBaseUrl()}/api/local-sync/snapshot\`, { method: 'POST', ... })` POST 推送
   - `localSyncPausedReason` 相关状态和 UI
   - 这些代码现在由 `cloudSyncManager.ts` 的 `initSync()` 自动处理，不再需要手动同步按钮

**注意事项**：

- 移除前确认 `ProjectDatasetsPage.tsx` 中的 local-sync 代码没有被其他功能依赖
- `snapshotReadiness` 相关代码是快照保存功能，与 local-sync 无关，不要误删
- `old/` 目录下的旧文件不需要处理

---

## Phase 4：用户认证（未来规划）

### 任务 4.1：接入认证系统

**目标**：让数据按用户隔离，而非全局共享。

**需求详情**：

- 方案选择（待定）：
  - 方案 A：Cloudflare Access（零代码，但需要 Cloudflare 付费计划）
  - 方案 B：自定义 JWT（灵活，需要自建登录页）
  - 方案 C：简单密码/邀请码（最轻量，适合小团队）
- 认证后，所有 sync API 端点需要验证身份
- 前端需要登录/注册 UI

### 任务 4.2：device_id → user_id 命名空间迁移

**目标**：数据归属从设备级别升级到用户级别。

**需求详情**：

- D1 所有表添加 `user_id` 字段
- 迁移脚本：将现有 device_id 数据关联到 user_id
- `pull.js` 恢复按 `user_id` 过滤（当前为全局返回，Phase 3 阶段的临时方案）
- `push.js` 写入时记录 `user_id`
- R2 key 结构从 `{device_id}/...` 改为 `{user_id}/...`

### 任务 4.3：多设备关联

**目标**：同一用户的多个设备共享数据。

**需求详情**：

- 用户登录后，将当前 device_id 关联到 user_id
- 新增 `user_devices` 表记录关联关系
- 同一 user_id 下的所有设备数据自动合并

---

## 当前架构关键信息

### Cloudflare 资源

| 资源 | 名称 | ID |
|------|------|-----|
| D1 数据库 | tou-schedule-db | `a84a7d8e-fde5-4aac-a540-2b3cf77aad42` |
| R2 存储桶 | tou-schedule-storage | — |
| Pages 项目 | tou-schedule-editor | — |

### 同步 API 端点

| 端点 | 方法 | 状态 |
|------|------|------|
| `/api/sync/register` | POST | ✅ |
| `/api/sync/push` | POST | ✅ |
| `/api/sync/upload` | POST | ✅ |
| `/api/sync/pull` | GET | ✅（已修复全局返回） |
| `/api/sync/download/:key` | GET | ✅ |

### 同步策略

- 启动时：全量拉取（`since` = 上次同步时间）
- 运行中：每 5 分钟增量拉取
- 写操作后：2 秒去抖批量推送
- 离线时：暂停推送，上线后立即同步
- 冲突解决：last-write-wins（比较 `updated_at`）
- 当前无用户认证，pull 返回所有设备数据

### 关键文件

| 文件 | 职责 |
|------|------|
| `cloudSyncManager.ts` | 同步调度器（push/pull/状态管理） |
| `cloudSyncApi.ts` | sync API HTTP 客户端 |
| `localProjectStore.ts` | 本地存储（IndexedDB + localStorage 双模式） |
| `index.tsx` | 入口，调用 `initSync()` |
| `functions/api/sync/*.js` | 5 个 Pages Functions 端点 |
| `wrangler.toml` | D1 + R2 绑定配置 |

### 部署注意事项

- 部署命令：`npx wrangler pages deploy dist --project-name=tou-schedule-editor --commit-message="english message"`
- commit message 必须用英文，中文会导致部署失败
- `wrangler.toml` 必须包含 `pages_build_output_dir = "dist"`
