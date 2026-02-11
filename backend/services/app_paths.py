"""
桌面版数据目录管理模块

在桌面版（PyInstaller 打包 exe）中，所有可写数据目录
统一落到 %LOCALAPPDATA%\\TouEditor\\ 下，避免安装到
Program Files 时因权限不足导致写入失败。

普通开发/Web 部署模式下，退化为项目根目录下的相对路径
（保持向后兼容）。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


# 应用名称（用于 AppData 子目录）
APP_NAME = "TouEditor"


def _is_frozen() -> bool:
    """判断是否处于 PyInstaller 打包环境"""
    return getattr(sys, "frozen", False)


def _get_data_root() -> Path:
    """
    获取可写数据根目录：
    - 桌面版 (frozen): %LOCALAPPDATA%\\TouEditor
    - 开发 / Web 部署:  当前工作目录
    """
    if _is_frozen():
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / APP_NAME
        # 备选：HOME 目录
        return Path.home() / f".{APP_NAME}"
    # 非桌面版：使用 cwd（与原有行为一致）
    return Path.cwd()


DATA_ROOT: Path = _get_data_root()

# 输出目录（Excel/CSV/ZIP 报表导出）
OUTPUTS_DIR: Path = DATA_ROOT / "outputs"

# 本地同步快照存储目录
STORE_DIR: Path = DATA_ROOT / "local_sync_store"
SNAPSHOT_PATH: Path = STORE_DIR / "snapshot.json"


def ensure_dirs() -> None:
    """启动时确保所有可写目录已创建"""
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    STORE_DIR.mkdir(parents=True, exist_ok=True)
