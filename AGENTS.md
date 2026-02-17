# AGENTS.md - Agent Coding Guidelines

This file provides guidelines and context for AI agents working on this project.

---

## Project Overview

- **Frontend**: React 19 + TypeScript 5.8 + Vite 6
- **Backend**: Python FastAPI
- **Deployment**: Cloudflare Pages (frontend) + Cloudflare Workers or Railway/Vercel (backend)
- **Testing**: No test framework configured

---

## Build Commands

### Frontend (Node.js)

```bash
# Install dependencies
npm install

# Development server (http://localhost:5173)
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Deploy to Cloudflare Pages
npm run deploy

# Deploy to Cloudflare Pages staging branch
npm run deploy:staging
```

### Backend (Python)

```bash
# Install Python dependencies
pip install -r backend/requirements.txt

# Run backend server (requires .env.local with VITE_BACKEND_BASE_URL)
python -m uvicorn backend.app:app --reload --port 8000

# Or use the run_server.py helper
python backend/run_server.py
```

### Running a Single Test

**No test framework is currently configured.** If you add tests:
- For Vitest: `npm run test -- --run <test-file>`
- For Jest: `npm test -- --testPathPattern=<test-file>`

---

## Code Style Guidelines

### TypeScript / React

#### Imports
Group imports in this order (blank line between groups):
1. React core: `import React, { useState, useCallback } from 'react'`
2. TypeScript types: `import type { Schedule, TierId } from './types'`
3. Constants: `import { INITIAL_APP_STATE, VALID_TIER_IDS } from './constants'`
4. Utilities: `import { exportScheduleToExcel } from './utils'`
5. Third-party: `import * as XLSX from 'xlsx'`
6. Local components: `import { ConfigurationManager } from './components/ConfigurationManager'`
7. Custom hooks: `import { useScrollSpy } from './hooks/useScrollSpy'`

```typescript
// Good example
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Schedule, TierId, DateRule, OperatingLogicId, Configuration } from './types';
import { INITIAL_APP_STATE, VALID_OP_LOGIC_IDS, VALID_TIER_IDS } from './constants';
import * as api from './api';
import { exportScheduleToExcel } from './utils';
import * as XLSX from 'xlsx';
import { ConfigurationManager } from './components/ConfigurationManager';
import { useScrollSpy } from './hooks/useScrollSpy';
```

#### Naming Conventions
- **Components**: PascalCase (e.g., `ScheduleEditorPage`, `DateRuleModal`)
- **Types/Interfaces**: PascalCase (e.g., `TierId`, `OperatingLogicId`, `CellData`)
- **Variables/Functions**: camelCase (e.g., `handleSelectConfig`, `isDirty`)
- **Constants**: PascalCase for enum-like constants, UPPER_SNAKE for config keys
- **Files**: PascalCase for components (e.g., `ScheduleEditorPage.tsx`), camelCase for utilities (e.g., `loadApi.ts`)

#### Type Annotations
- Use explicit type annotations for function parameters and return types
- Use `type` for unions/intersections, `interface` for object shapes
- Prefer `import type { ... }` for type-only imports

```typescript
// Good
const handleSelectConfig = useCallback(async (id: string, initialLoad = false) => {
  // ...
  const config: Configuration | null = await api.getConfiguration(id);
  return config;
}, []);

// Avoid
const handleSelectConfig = useCallback(async (id, initialLoad = false) => { ... });
```

#### React Component Patterns
- Use `React.FC<Props>` for typed functional components
- Destructure props in the component signature
- Keep components focused and small

```typescript
// Good
const EditModeSelector: React.FC<{
  editMode: 'tou' | 'op';
  setEditMode: (mode: 'tou' | 'op') => void;
}> = ({ editMode, setEditMode }) => {
  // ...
};
```

#### Error Handling
- Always wrap async operations in try/catch
- Log errors with `console.error` including context
- Show user-friendly messages via `alert()` or state
- Never leave empty catch blocks

```typescript
// Good
try {
  const config = await api.getConfiguration(id);
  if (!config) throw new Error("Configuration not found.");
} catch (error) {
  console.error("Failed to load configuration:", error);
  alert(`Error loading configuration: ${(error as Error).message}`);
}
```

#### State Management
- Use `useState` for component-local state
- Use `useRef` for values that don't trigger re-renders
- Use `useCallback` for stable callback references
- Use `useMemo` for expensive computations

### Python / FastAPI

#### Imports
Group imports in this order:
1. Standard library
2. Third-party packages
3. Local application modules

```python
# Good
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List

import pandas as pd
from fastapi import FastAPI, HTTPException

from .schemas import CleaningResultResponse
from .services import cleaning as cleaning_svc
```

#### Naming Conventions
- **Functions**: snake_case (e.g., `get_configuration`, `analyze_load_file`)
- **Classes**: PascalCase (e.g., `StorageCyclesResponse`)
- **Constants**: UPPER_SNAKE_CASE
- **Private methods**: prefix with underscore (e.g., `_ensure_data_dirs`)

#### Type Hints
Use Python type hints for all function signatures:

```python
# Good
def get_configuration(config_id: str) -> Configuration | None:
    """Fetch configuration by ID."""
    # ...
```

#### Error Handling
Use FastAPI's `HTTPException` for HTTP errors:

```python
# Good
if not config:
    raise HTTPException(status_code=404, detail="Configuration not found")
```

---

## Critical Development Rules

### Cloudflare Pages Functions（JS 后端）与 Python 后端对齐

Cloudflare Pages Functions（`functions/api/`）是 Python 后端（`backend/`）的 JS 移植版。由于 Cloudflare 运行时只支持 JS/TS，无法直接运行 Python，因此存在两套实现。

**核心原则：JS 端必须严格 1:1 对齐 Python 端的计算逻辑。**

具体要求：
1. **Python 是唯一的逻辑基准** — 任何计算公式、物理口径、聚合方式，以 Python 后端代码为准
2. **禁止在 JS 端自行"简化"或"增强"** — 不得添加 Python 没有的逻辑（如 SOC 模拟、容量封顶），也不得用简化公式替代逐点计算
3. **修改 Python 计算逻辑后，必须同步更新 JS 端** — 确保两端输出在相同输入下结果一致
4. **收益计算必须使用逐点分时电价** — 每个 15 分钟点的充放电能量 × 该点实际电价，不得用 min/max 电价简化
5. **循环次数公式必须与 Python `_cycle_contrib` 一致** — `fc = min(E_in / capacity, 1)`，`fd = min(E_out / capacity, 1)`，`cyc = min(fc, fd)`
6. **月度/年度收益 = 日度收益累加** — 不得用平均电价重新计算

---

1. **`VITE_BACKEND_BASE_URL` must be empty** for Cloudflare deployment
   - Cloudflare Pages Functions run on the same origin
   - Hardcoding any URL will break after redeployment

### Backend API Contract
- Backend responses MUST match frontend TypeScript interfaces exactly
- Check `types.ts` before modifying backend JSON responses
- Key fields: `cleaned_points` (not `points`), `load_kwh` (not `load_kw`)

### CSV Parsing
- Use `split(',')` instead of regex for parsing CSV
- Timestamps may contain spaces (e.g., `2023-01-01 00:00:00`)

### Data Integrity
- Do NOT hardcode data point limits (30,000+ rows for yearly 15-min intervals)
- Always return full datasets from backend

### FormData Handling
- Frontend uses `FormData` for file uploads
- Backend must use `request.formData()` not `request.json()`

---

## Project Structure

```
dist_package/
├── App.tsx                 # Main React application
├── api.ts                  # Frontend API (localStorage mock)
├── types.ts                # TypeScript type definitions
├── constants.ts            # App constants
├── loadApi.ts              # Load file upload API
├── storageApi.ts           # Storage analysis API
├── utils.ts                # Utility functions
├── vite.config.ts          # Vite configuration
├── tsconfig.json           # TypeScript configuration
├── package.json            # Node.js dependencies
├── components/             # React components
│   ├── ScheduleEditorPage.tsx
│   ├── DateRuleManager.tsx
│   └── ...
├── hooks/                  # Custom React hooks
├── backend/                # Python FastAPI backend
│   ├── app.py             # FastAPI application
│   ├── schemas.py         # Pydantic schemas
│   ├── services/          # Business logic
│   │   ├── cycles.py
│   │   ├── cleaning.py
│   │   └── ...
│   └── requirements.txt   # Python dependencies
├── workers-backend/        # Cloudflare Workers backend
└── .agent/agent.md        # Development notes (Chinese)
```

---

## Environment Variables

### Frontend (.env.local)
```
VITE_BACKEND_BASE_URL=http://localhost:8000  # Empty for Cloudflare deployment
```

### Backend (.env.local)
```
# Backend reads from VITE_BACKEND_BASE_URL via frontend proxy
```

---

## 云端同步（Cloud Sync）常见错误记录

以下是实现 D1 + R2 云端同步过程中犯过的错误，务必避免重蹈覆辙。

### 1. Pull 端点按 device_id 过滤导致跨会话数据不可见

**问题**：`pull.js` 的 SQL 查询使用 `WHERE device_id = ?1` 过滤数据。隐私模式/新浏览器会生成全新的 `device_id`，导致拉取到空数据，用户以为同步失败。

**根因**：在没有用户认证的阶段，不应该按 device_id 隔离数据。device_id 只是设备标识，不等于用户身份。

**修复**：去掉 pull 查询中的 `device_id` 过滤条件，返回所有设备的数据。等 Phase 4 加用户认证后再按 `user_id` 做数据隔离。

**教训**：设计 API 时要从用户使用场景出发思考——用户会在不同浏览器/隐私模式下访问，如果没有登录系统，数据隔离策略必须考虑这一点。

### 2. initSync() 未在应用启动时调用

**问题**：实现了完整的 `cloudSyncManager.ts`（包括 `initSync()`、`pullFromCloud()` 等），但忘记在 `index.tsx` 的 bootstrap 函数中调用 `initSync()`，导致 pull 逻辑永远不会执行。

**根因**：只关注了模块内部逻辑的完整性，忽略了入口文件的集成。

**修复**：在 `index.tsx` 的 `bootstrap()` 中添加 `initSync().catch(...)` 调用。

**教训**：实现新的全局服务/管理器后，必须检查入口文件是否已正确初始化。写完模块不等于集成完成。

### 3. Cloudflare Pages 部署时中文 commit message 导致失败

**问题**：`wrangler pages deploy` 默认使用 git 最新 commit message，如果包含中文字符会报 "Invalid commit message, it must be a valid UTF-8 string" 错误。

**修复**：使用 `--commit-message="english message"` 参数显式指定英文 commit message。

**教训**：Cloudflare Pages 部署时始终使用 `--commit-message` 参数传入英文描述。

### 4. wrangler.toml 缺少 pages_build_output_dir

**问题**：创建 `wrangler.toml` 时只配置了 D1 和 R2 绑定，遗漏了 `pages_build_output_dir = "dist"` 字段，导致 wrangler 警告。

**教训**：Cloudflare Pages 项目的 `wrangler.toml` 必须包含 `pages_build_output_dir` 字段。

### 5. upsertDatasetWithPoints 空数组覆盖已有数据

**问题**：pull 合并时调用 `upsertDatasetWithPoints(dataset, [])` 传入空 points 数组，原始实现会用空数组覆盖本地已有的点位数据。

**修复**：在 `upsertDatasetWithPoints` 中添加 `if (points.length > 0)` 守卫，空数组时跳过 points 写入。

**教训**：复用已有函数时，要考虑新调用场景下的边界条件。pull 只同步元数据不同步点位，但复用了同一个写入函数，必须确保不会误删数据。

---

## IDE Recommendations

- **VS Code** with extensions:
  - ESLint
  - Prettier
  - Tailwind CSS IntelliSense
  - Python (Pylance)
