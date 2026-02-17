# Cloudflare Pages Functions 储能计算逻辑修复计划

**创建时间**: 2026-02-14 01:30
**状态**: 待处理
**优先级**: 高

---

## 为什么需要修改

### 1. 架构要求：JS 后端必须与 Python 后端对齐

根据项目 AGENTS.md 中的明确规定：

> **Cloudflare Pages Functions（JS 后端）与 Python 后端对齐**
> Cloudflare Pages Functions（`functions/api/`）是 Python 后端（`backend/`）的 JS 移植版。由于 Cloudflare 运行时只支持 JS/TS，无法直接运行 Python，因此存在两套实现。
>
> **核心原则：JS 端必须严格 1:1 对齐 Python 端的计算逻辑。**

具体要求：
1. **Python 是唯一的逻辑基准** — 任何计算公式、物理口径、聚合方式，以 Python 后端代码为准
2. **禁止在 JS 端自行"简化"或"增强"** — 不得添加 Python 没有的逻辑
3. **修改 Python 计算逻辑后，必须同步更新 JS 端** — 确保两端输出在相同输入下结果一致

### 2. 当前偏差超出验收标准

| 验收指标 | 要求 | 当前实际 | 状态 |
|----------|------|----------|------|
| cycles 偏差 | < 0.1% | 53.7% | ❌ 不合格 |
| profit 偏差 | < 5% | 11% | ❌ 不合格 |

当前 JS 版本的计算结果与 Python 存在巨大差异，违反了架构原则，必须修复。

### 3. 业务影响

- **储能循环次数 (cycles)** 是储能项目经济性评估的核心指标，53.7% 的偏差会导致：
  - 项目投资回报期计算错误
  - 储能容量配置方案不合理
  
- **收益 (profit)** 偏差 11% 会影响：
  - 项目年收益预估准确性
  - 项目可行性判断

---

## 问题描述

当前 Cloudflare Pages Functions (`functions/api/storage/cycles.js`) 与 Python 后端 (`backend/services/cycles.py`) 的计算结果存在显著偏差：

| 指标 | Cloudflare Pages | Python Backend | 偏差 |
|------|------------------|----------------|------|
| cycles | 0.45 | 0.972 | **53.7%** ⚠️ |
| revenue | 74.46 | 112.49 | **33.8%** ⚠️ |
| profit | 65.46 | 73.61 | **11%** ⚠️ |

**验收标准**: cycles 偏差 < 0.1%, profit 偏差 < 5%

---

## 差异根源分析

### 1. cycles 计算公式不同

**Python (`cycles.py` 第 749-762 行)**:
```python
def _cycle_contrib(cmask: dict) -> float:
    e_in_base = _window_energy(...)   # 电池侧允许充入能量
    e_out_base = _window_energy(...) # 电池侧允许放出能量

    # physics 口径：电网侧能量
    E_in_grid = e_in_base * dod / eta   # 充电：考虑 DOD 和效率
    E_out_grid = e_out_base * dod * eta # 放电：考虑 DOD 和效率

    # 满充/放率
    fc = min(E_in_grid / capacity, 1.0)
    fd = min(E_out_grid / capacity, 1.0)
    
    return min(fc, fd)
```

**JS 版本 (`cycles.js` 第 501-508 行)**:
```javascript
// JS 版本（存在问题）
const E_in_grid = ch.baseKwh * dod / Math.max(eta, EPS);
const E_out_grid = dis.baseKwh * dod * eta;
const fc = capacityKwh > EPS ? Math.min(E_in_grid / capacityKwh, 1) : 0;
const fd = capacityKwh > EPS ? Math.min(E_out_grid / capacityKwh, 1) : 0;
```

**问题**: JS 版本没有正确实现 physics/sample 两种口径的计算逻辑。

### 2. profit 结构不完整

- **JS**: 只有 `main` 口径
- **Python**: 有 `main`, `physics`, `sample` 三种口径

### 3. 尖段分析未启用

- **JS**: 明确标注未启用
- **Python**: 完整支持

---

## 修复方案

### 修改 1: 调整 `windowEnergy` 函数

**文件**: `functions/api/storage/cycles.js`
**位置**: 第 302-324 行

**当前代码**:
```javascript
const windowEnergy = (dayRows, hourList, intervalHours, isCharge, limitKw, reserveChargeKw, reserveDischargeKw) => {
  // ...
  const baseKwh = allowKw * hours;  // 这是电池侧能量
  
  return {
    baseKwh,
    avgLoad,
    points: selected.length,
  };
};
```

**修改为**:
```javascript
const windowEnergy = (dayRows, hourList, intervalHours, isCharge, limitKw, reserveChargeKw, reserveDischargeKw) => {
  // ...
  const baseKwh = allowKw * hours;
  
  return {
    baseKwh,        // 电池侧能量
    avgLoad,        // 窗口平均负荷
    hours: hours,   // 窗口时长
    points: selected.length,
  };
};
```

---

### 修改 2: 新增 `computeCycleContrib` 函数

**文件**: `functions/api/storage/cycles.js`
**位置**: 在 `buildDailyMasks` 函数之后（约第 288 行附近）

**新增代码**:
```javascript
/**
 * 计算单个窗口的 cycles 贡献（与 Python _cycle_contrib 对齐）
 * 使用 physics 口径：电网侧能量 = 电池侧能量 × DOD / η（充电）或 × DOD × η（放电）
 */
const computeCycleContrib = (
  dayRows,
  mask,
  intervalHours,
  limitKw,
  reserveChargeKw,
  reserveDischargeKw,
  capacityKwh,
  eta,
  dod
) => {
  const ch = windowEnergy(
    dayRows,
    mask.charge_hours,
    intervalHours,
    true,
    limitKw,
    reserveChargeKw,
    reserveDischargeKw
  );
  const dis = windowEnergy(
    dayRows,
    mask.discharge_hours,
    intervalHours,
    false,
    limitKw,
    reserveChargeKw,
    reserveDischargeKw
  );

  // physics 口径（与 Python 对齐）
  const E_in_grid = ch.baseKwh * dod / Math.max(eta, EPS);
  const E_out_grid = dis.baseKwh * dod * eta;

  const fc = capacityKwh > EPS ? Math.min(E_in_grid / capacityKwh, 1) : 0;
  const fd = capacityKwh > EPS ? Math.min(E_out_grid / capacityKwh, 1) : 0;

  return {
    fc,
    fd,
    cycles: Math.min(fc, fd),
    E_in_grid,
    E_out_grid,
    charge_energy_kwh: E_in_grid,
    discharge_energy_kwh: E_out_grid,
  };
};
```

---

### 修改 3: 替换主循环中的 cycles 计算逻辑

**文件**: `functions/api/storage/cycles.js`
**位置**: 第 474-509 行

**当前代码**:
```javascript
if (limitKw > EPS && capacityKwh > EPS) {
  const windows = [
    { key: 'c1', data: mask.c1 },
    { key: 'c2', data: mask.c2 },
  ];

  for (const win of windows) {
    const ch = windowEnergy(
      dayRows,
      win.data.charge_hours,
      intervalHours,
      true,
      limitKw,
      reserveChargeKw,
      reserveDischargeKw,
    );
    const dis = windowEnergy(
      dayRows,
      win.data.discharge_hours,
      intervalHours,
      false,
      limitKw,
      reserveChargeKw,
      reserveDischargeKw,
    );

    // 与 Python _cycle_contrib 完全对齐
    const E_in_grid = ch.baseKwh * dod / Math.max(eta, EPS);
    const E_out_grid = dis.baseKwh * dod * eta;
    const fc = capacityKwh > EPS ? Math.min(E_in_grid / capacityKwh, 1) : 0;
    const fd = capacityKwh > EPS ? Math.min(E_out_grid / capacityKwh, 1) : 0;
    const cyc = Math.min(fc, fd);
    dayCycles += cyc;
    dayChargeKwh += E_in_grid;
    dayDischargeKwh += E_out_grid;
  }
}
```

**修改为**:
```javascript
if (limitKw > EPS && capacityKwh > EPS) {
  const windows = [
    { key: 'c1', data: mask.c1 },
    { key: 'c2', data: mask.c2 },
  ];

  for (const win of windows) {
    const contrib = computeCycleContrib(
      dayRows,
      win.data,
      intervalHours,
      limitKw,
      reserveChargeKw,
      reserveDischargeKw,
      capacityKwh,
      eta,
      dod
    );
    dayCycles += contrib.cycles;
    dayChargeKwh += contrib.charge_energy_kwh;
    dayDischargeKwh += contrib.discharge_energy_kwh;
  }
}
```

---

### 修改 4: 可选 - 增加 profit 结构

如需与 Python 完全对齐，可增加 `physics` 和 `sample` 口径（复杂度较高，当前可暂不实现）。

---

## 验证方法

### 测试数据
```json
{
  "storage": {
    "capacity_kwh": 100,
    "single_side_efficiency": 0.9,
    "depth_of_discharge": 0.9,
    "c_rate": 0.5
  },
  "strategySource": {
    "monthlySchedule": [[{"op": "充", "tou": "谷"}, ...]],
    "dateRules": []
  },
  "monthlyTouPrices": [{"尖": 1.2, "峰": 1.0, "平": 0.7, "谷": 0.4, "深": 0.2}],
  "points": [96 个 15 分钟点数据]
}
```

### 验证命令
```bash
# Cloudflare Pages
curl -s -X POST "https://03eb18b4.tou-schedule-editor.pages.dev/api/storage/cycles" \
  -F "payload=@payload.json" | python -c "import sys,json; d=json.load(sys.stdin); print('cycles:', d['year']['cycles']); print('profit:', d['year']['profit']['main'])"

# Python Backend
curl -s -X POST "http://localhost:8000/api/storage/cycles" \
  -F "payload=@payload.json" | python -c "import sys,json; d=json.load(sys.stdin); print('cycles:', d['year']['cycles']); print('profit:', d['year']['profit']['main'])"
```

### 验收标准
- cycles 偏差 < 0.1%
- profit 偏差 < 5%

---

## 实施步骤

1. [ ] 修改 `windowEnergy` 函数，增加返回 `hours` 字段
2. [ ] 新增 `computeCycleContrib` 函数
3. [ ] 替换主循环中的 cycles 计算逻辑
4. [ ] 重新部署到 Cloudflare Pages: `npm run deploy`
5. [ ] 使用测试数据验证 cycles 和 profit 偏差
6. [ ] 如偏差仍超标，继续调试

---

## 相关文件

- `functions/api/storage/cycles.js` - Cloudflare Pages Functions 后端
- `backend/services/cycles.py` - Python 后端（参考实现）
- `functions/api/storage/cycles/curves.js` - 储能曲线接口（可能也需要同步修复）
