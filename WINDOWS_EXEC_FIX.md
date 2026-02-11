# Windows 用户执行指南

## 问题原因
Windows 将 `.sh` 脚本默认关联到了 VS Code，所以双击时直接用编辑器打开了。

## 解决方案

### 方法 1: 使用 CMD 直接执行（推荐）

1. 按 `Win + R`，输入 `cmd`，回车
2. 在 CMD 中执行：

```cmd
cd /d D:\Desktop\ai\dist_package
bash deploy-cloud.sh
```

### 方法 2: 使用 PowerShell

1. 按 `Win + X`，选择 `Windows PowerShell`
2. 执行：

```powershell
cd D:\Desktop\ai\dist_package
bash ./deploy-cloud.sh
```

### 方法 3: 使用 Git Bash（最简单）

1. 在文件夹空白处右键 → `Git Bash Here`
2. 执行：

```bash
./deploy-cloud.sh
```

### 方法 4: 使用批处理文件（已创建）

双击运行：`deploy-cloud.bat`

---

## 如果还是打不开

直接复制以下命令到 CMD 执行：

```cmd
cd /d D:\Desktop\ai\dist_package

:: 推送到 GitHub
git remote add origin https://github.com/YOUR_USERNAME/tou-schedule-editor.git
git branch -M main
git push -u origin main

:: 然后手动打开 Railway 部署
start https://railway.app/new
```

---

## 关键区别

| 方式 | 命令 |
|------|------|
| 错误方式 | `./deploy-cloud.sh` (被关联到 VS Code) |
| 正确方式 | `bash deploy-cloud.sh` (用 Git Bash 执行) |
| 或 | `sh deploy-cloud.sh` (用 Shell 执行) |

---

**现在请尝试：在 CMD 中输入 `bash deploy-cloud.sh`**
