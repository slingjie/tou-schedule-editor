"""
后端包入口。

说明：
- 该仓库的后端目录需要作为“普通包”被导入，避免在 Windows 环境下因命名空间包（namespace package）
  与其他同名包/路径合并导致 `uvicorn backend.app:app` 实际加载到错误模块版本。
"""

