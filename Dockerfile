# 使用 Python 3.11  slim 镜像
FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY backend/requirements.txt .

# 安装 Python 依赖
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码
COPY backend/ ./backend/

# 设置环境变量
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8080"]
