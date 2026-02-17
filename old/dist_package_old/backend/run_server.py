"""
桌面版后端启动入口（PyInstaller 打包目标）

打包为 backend-server.exe 后作为 Tauri sidecar 分发。
启动时设置 DESKTOP_MODE=1 环境变量，后端据此禁用 PDF 路由。
"""

import os
import sys

# 标记桌面模式（后端据此禁用 PDF 等桌面不需要的功能）
os.environ["DESKTOP_MODE"] = "1"

# PyInstaller frozen 模式下修正工作目录
if getattr(sys, "frozen", False):
    # 确保 Python 路径正确
    base_dir = os.path.dirname(sys.executable)
    os.chdir(base_dir)

import uvicorn


def main():
    uvicorn.run(
        "backend.app:app",
        host="127.0.0.1",
        port=8000,
        log_level="info",
    )


if __name__ == "__main__":
    main()
