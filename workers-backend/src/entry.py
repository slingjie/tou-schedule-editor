# Cloudflare Workers Python Backend
# 注意: 这是一个简化版本，针对 Workers 环境优化

from workers import WorkerEntrypoint
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import asgi
import json

# 创建 FastAPI 应用
app = FastAPI(
    title="TOU Schedule Backend",
    version="1.0.0",
    description="Cloudflare Workers Python Backend"
)

# CORS 配置 - 允许前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://4c5ac2be.tou-schedule-editor.pages.dev",
        "https://tou-schedule-editor.pages.dev",
        "http://localhost:5173",
        "http://localhost:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ 数据模型 ============

class HealthResponse(BaseModel):
    status: str
    service: str
    version: str

class ScheduleData(BaseModel):
    time_slots: List[Dict[str, Any]]
    prices: List[float]
    metadata: Optional[Dict[str, Any]] = None

class AnalysisRequest(BaseModel):
    schedule_data: ScheduleData
    analysis_type: str = "basic"

class AnalysisResponse(BaseModel):
    success: bool
    message: str
    results: Optional[Dict[str, Any]] = None

# ============ 路由 ============

@app.get("/", response_model=Dict[str, str])
async def root():
    """根路径 - 服务信息"""
    return {
        "service": "TOU Schedule Backend",
        "version": "1.0.0",
        "platform": "Cloudflare Workers Python",
        "status": "running"
    }

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    return HealthResponse(
        status="healthy",
        service="tou-schedule-backend",
        version="1.0.0"
    )

@app.post("/api/analyze", response_model=AnalysisResponse)
async def analyze_schedule(request: AnalysisRequest):
    """
    分析电价 schedule
    
    这是一个示例端点，展示如何在 Workers 中处理数据分析
    实际业务逻辑需要根据具体需求实现
    """
    try:
        # 简化的分析逻辑
        schedule = request.schedule_data
        
        # 计算基础统计
        prices = schedule.prices
        if not prices:
            return AnalysisResponse(
                success=False,
                message="No price data provided",
                results=None
            )
        
        avg_price = sum(prices) / len(prices)
        max_price = max(prices)
        min_price = min(prices)
        
        # 峰谷分析
        peak_hours = [i for i, p in enumerate(prices) if p > avg_price * 1.2]
        valley_hours = [i for i, p in enumerate(prices) if p < avg_price * 0.8]
        
        results = {
            "statistics": {
                "average_price": round(avg_price, 4),
                "max_price": max_price,
                "min_price": min_price,
                "price_range": max_price - min_price
            },
            "peak_valley_analysis": {
                "peak_hours_count": len(peak_hours),
                "valley_hours_count": len(valley_hours),
                "peak_hours": peak_hours[:10],  # 限制返回数量
                "valley_hours": valley_hours[:10]
            },
            "total_time_slots": len(schedule.time_slots)
        }
        
        return AnalysisResponse(
            success=True,
            message="Analysis completed successfully",
            results=results
        )
        
    except Exception as e:
        return AnalysisResponse(
            success=False,
            message=f"Analysis failed: {str(e)}",
            results=None
        )

@app.post("/api/calculate-profit", response_model=AnalysisResponse)
async def calculate_profit(data: Dict[str, Any] = Body(...)):
    """
    计算储能收益（简化版）
    """
    try:
        # 这里可以添加实际的收益计算逻辑
        # 目前返回示例数据
        
        return AnalysisResponse(
            success=True,
            message="Profit calculation completed",
            results={
                "estimated_daily_profit": 1250.50,
                "estimated_monthly_profit": 37515.00,
                "estimated_annual_profit": 450180.00,
                "capacity_utilization": 0.85,
                "note": "This is a simplified calculation for demo purposes"
            }
        )
    except Exception as e:
        return AnalysisResponse(
            success=False,
            message=f"Calculation failed: {str(e)}",
            results=None
        )

@app.get("/api/config")
async def get_config():
    """获取配置信息"""
    return {
        "supported_features": [
            "schedule_analysis",
            "profit_calculation",
            "peak_valley_analysis"
        ],
        "max_upload_size_mb": 10,
        "supported_formats": ["json"],
        "version": "1.0.0"
    }

# ============ Workers 入口 ============

class Default(WorkerEntrypoint):
    """Cloudflare Workers 入口点"""
    
    async def fetch(self, request):
        """
        处理所有 HTTP 请求
        
        使用 ASGI 适配器将 FastAPI 应用连接到 Workers 运行时
        """
        return await asgi.fetch(app, request, self.env)

# 本地测试入口（直接运行此文件时）
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
