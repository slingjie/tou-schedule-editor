"""
DeepSeek 项目评估报告生成服务

负责从负荷数据、TOU 配置、储能测算结果中提取关键信息，
构建 Prompt 并调用 DeepSeek API 生成项目评估报告 Markdown。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class DeepSeekError(Exception):
    """DeepSeek API 调用相关异常"""
    pass


def extract_summary_data(
    project_info: Dict[str, Any],
    load_profile: Optional[Dict[str, Any]],
    tou_config: Optional[Dict[str, Any]],
    storage_config: Optional[Dict[str, Any]],
    storage_results: Optional[Dict[str, Any]],
    quality_report: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    从各模块数据中提取用于 DeepSeek 的结构化输入。
    
    Args:
        project_info: 项目基本信息 { name, location, periodStart, periodEnd, ... }
        load_profile: 负荷特征摘要
        tou_config: TOU 配置与表格
        storage_config: 储能配置参数
        storage_results: 储能测算结果（收益、循环、利用小时等）
        quality_report: 数据质量报告
    
    Returns:
        用于注入 Prompt 的完整 JSON 结构
    """
    logger.info("🔍 [extract_summary_data] 开始提取数据")
    logger.info(f"🔍 [extract_summary_data] project_info: {project_info}")
    logger.info(f"🔍 [extract_summary_data] load_profile: {load_profile}")
    logger.info(f"🔍 [extract_summary_data] storage_config: {storage_config}")
    logger.info(f"🔍 [extract_summary_data] storage_results: {storage_results}")
    logger.info(f"🔍 [extract_summary_data] quality_report: {quality_report}")
    
    # 这里只是示例结构，实际需要根据你的 backend 已有数据结构做映射
    extracted = {
        "project": {
            "name": project_info.get("name", "未命名项目"),
            "location": project_info.get("location", "未指定地点"),
            "periodStart": project_info.get("periodStart", ""),
            "periodEnd": project_info.get("periodEnd", ""),
            "periodDescription": project_info.get("periodDescription", ""),
            "loadDataSource": project_info.get("loadDataSource", "用户提供的 CSV 数据"),
            "touSource": project_info.get("touSource", "当前 TOU 配置"),
            "simulationVersion": project_info.get("simulationVersion", "v1.0"),
            "reportDate": project_info.get("reportDate", ""),
        },
        "loadProfileSummary": load_profile or {},
        "touConfig": tou_config or {},
        "storageConfig": storage_config or {},
        "storageResults": storage_results or {},
        "qualityFlags": quality_report or {},
        "risks": {
            "tariffPolicyRisk": "若后续分时电价结构调整、峰谷价差缩小，将直接影响套利空间和整体收益水平",
            "dataQualityRisk": "当前数据代表性需结合更长周期验证",
            "marketAndLoadUncertainty": "产业结构和产能利用率变化可能导致未来负荷曲线发生偏移",
            "otherRisks": "",
        },
        "recommendations": {
            "storageSizing": "视后续运行数据考虑配置调整",
            "operationStrategy": "建议进一步优化充放电策略，提高利用效率",
            "touDesign": "如有可能，可与电网侧沟通优化峰谷价差",
            "dataAndOandM": "建议建立长期运行监测看板并定期复评",
        },
    }
    
    logger.info("✅ [extract_summary_data] 提取完成")
    logger.info(f"✅ [extract_summary_data] extracted keys: {list(extracted.keys())}")
    logger.info(f"✅ [extract_summary_data] loadProfileSummary keys: {list(extracted.get('loadProfileSummary', {}).keys())}")
    logger.info(f"✅ [extract_summary_data] storageConfig keys: {list(extracted.get('storageConfig', {}).keys())}")
    logger.info(f"✅ [extract_summary_data] storageResults keys: {list(extracted.get('storageResults', {}).keys())}")
    
    return extracted


def build_deepseek_prompt(input_data: Dict[str, Any]) -> str:
    """
    根据提取的数据构建 DeepSeek Prompt。
    
    Args:
        input_data: 由 extract_summary_data 返回的完整结构化数据
    
    Returns:
        最终发给 DeepSeek 的 Prompt 文本
    """
    input_json_str = json.dumps(input_data, ensure_ascii=False, indent=2)
    
    prompt = f"""你是一名熟悉工商业用户负荷特性、分时电价（TOU）和储能项目经济性的解决方案工程师，
需要为业主方生成一份项目评估报告初稿。

【任务目标】
- 目标读者是业主方管理层，报告需要结论清晰、结构规范，便于项目决策。
- 报告长度建议在 5–10 页 A4 纸的文字量（Markdown 格式约 3000–6000 字）。
- 可以给出具体的电价和收益金额，但对于存在不确定性的部分要有说明。
- 风险与建议部分需要给出方向性和倾向性判断，但不需要精确到具体百分比。

【输入数据（JSON）】
下面是系统根据负荷数据、TOU 配置、储能配置与模拟结果整理的结构化数据：

```json
{input_json_str}
```

【输出要求总则】
1. 你必须以 **Markdown 文本** 的形式输出一份完整报告，章节结构必须严格按照下述 7 章标题与顺序：
   - 第 1 章 项目概况与评估结论
   - 第 2 章 用户负荷特征与典型运行情况
   - 第 3 章 当前 TOU 配置与运行策略
   - 第 4 章 储能电站配置与模拟方式
   - 第 5 章 储能充放次数与收益评估
   - 第 6 章 风险点与优化建议
   - 第 7 章 附录：数据与参数表

2. 各章节内部的小节标题可以参考报告模板，但允许根据实际数据略微调整表述，只要含义一致即可。

3. 你需要尽可能使用输入 JSON 中已经整理好的文字字段，在此基础上进行适当润色、衔接和补充解释。
   - 不要随意修改这些字段中给出的结论方向。
   - 当你需要从多个字段综合得出一句话结论时，请保持逻辑清晰。

4. 禁止行为：
   - 禁止凭空编造 JSON 中不存在的**具体数值**（例如增加新的电价、收益金额）。
   - 如果某个字段缺失或为空，请在报告中以「当前数据暂不足以给出可靠结论」之类的措辞说明，而不是硬填内容。
   - 不要输出任何与该储能项目无关的背景故事或营销话术。

5. 对于首页结论部分，请使用条目列表的形式，确保至少包含：
   - 首年总收益（从 storageResults.firstYearRevenueDetail 获取）
   - 等效年循环次数 / 日均循环次数（从 storageResults.effectiveAnnualCycles 和 storageResults.dailyCycles 获取）
   - 储能利用小时数区间（从 storageResults.utilizationHoursRangeDetail 获取）
   - 上传负荷文件数据完整情况（从 qualityFlags.loadMissingRateDescription 获取）
   - 综合结论（经济性与策略合理性）

【关键字段使用说明】
从 JSON 数据中提取信息时，请按以下映射关系使用：

**负荷特征（loadProfileSummary）：**
- avgLoad: 平均负荷
- peakLoad: 峰值负荷  
- valleyLoad: 谷值负荷
- peakValleyDifferenceDescription: 峰谷差描述
- seasonalPattern: 季节性/评估周期描述

**储能配置（storageConfig）：**
- capacityMWh: 储能容量（MWh）
- powerMW: 储能功率（MW）
- configPerspective: 配置方式（按容/按需）
- efficiencyDescription: 效率描述
- socRangeDescription: SOC 范围描述
- reserveMarginDescription: 充放电余量描述

**储能结果（storageResults）：**
- effectiveAnnualCycles: 年等效循环次数
- dailyCycles: 日均循环次数
- utilizationHoursRangeDetail: 利用小时数
- firstYearRevenueDetail: 首年收益
- revenuePerUnitJudgement: 收益水平判断

**数据质量（qualityFlags）：**
- loadMissingRateDescription: 数据缺失描述
- impactOnConclusion: 对结论的影响

请直接使用这些字段的值，不要修改数值本身。
   - 首年总收益（或其描述）
   - 等效年循环次数 / 日均循环次数
   - 储能利用小时数区间
   - 上传负荷文件数据完整情况
   - 综合结论（经济性与策略合理性）

请根据上述要求，输出最终的 Markdown 报告内容。不要输出其他格式或额外解释，直接给出 Markdown 文本即可。
"""
    return prompt


async def call_deepseek_api(
    prompt: str,
    api_key: Optional[str] = None,
    model: str = "deepseek-chat",
    temperature: float = 0.7,
    max_tokens: int = 8000,
    timeout: float = 120.0,
) -> str:
    """
    调用 DeepSeek API 生成报告。
    
    Args:
        prompt: 构建好的完整 Prompt
        api_key: DeepSeek API Key，如不传则从环境变量 DEEPSEEK_API_KEY 读取
        model: 模型名称，默认 deepseek-chat
        temperature: 生成温度
        max_tokens: 最大 token 数
        timeout: 请求超时时间（秒）
    
    Returns:
        DeepSeek 返回的 Markdown 文本
    
    Raises:
        DeepSeekError: API 调用失败时抛出
    """
    if not api_key:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
    
    if not api_key:
        raise DeepSeekError(
            "DeepSeek API Key 未配置。请在环境变量中设置 DEEPSEEK_API_KEY 或通过参数传入。"
        )
    
    url = "https://api.deepseek.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt,
            }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            logger.info("正在调用 DeepSeek API，模型=%s，max_tokens=%d", model, max_tokens)
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            
            result = response.json()
            if "choices" not in result or len(result["choices"]) == 0:
                raise DeepSeekError(f"DeepSeek API 返回格式异常: {result}")
            
            message = result["choices"][0].get("message", {})
            content = message.get("content", "")
            
            if not content:
                raise DeepSeekError("DeepSeek API 返回内容为空")
            
            logger.info("DeepSeek API 调用成功，返回内容长度=%d 字符", len(content))
            return content
    
    except httpx.HTTPStatusError as exc:
        logger.exception("DeepSeek API 请求失败: status=%s", exc.response.status_code)
        error_detail = exc.response.text
        raise DeepSeekError(
            f"DeepSeek API 请求失败 (HTTP {exc.response.status_code}): {error_detail}"
        ) from exc
    except httpx.RequestError as exc:
        logger.exception("DeepSeek API 网络请求异常")
        raise DeepSeekError(f"DeepSeek API 网络请求异常: {exc}") from exc
    except Exception as exc:
        logger.exception("调用 DeepSeek API 时发生未知错误")
        raise DeepSeekError(f"调用 DeepSeek API 时发生未知错误: {exc}") from exc


async def generate_project_summary(
    project_info: Dict[str, Any],
    load_profile: Optional[Dict[str, Any]] = None,
    tou_config: Optional[Dict[str, Any]] = None,
    storage_config: Optional[Dict[str, Any]] = None,
    storage_results: Optional[Dict[str, Any]] = None,
    quality_report: Optional[Dict[str, Any]] = None,
    api_key: Optional[str] = None,
) -> str:
    """
    生成项目评估报告（高层封装函数）。
    
    Args:
        project_info: 项目基本信息
        load_profile: 负荷特征摘要
        tou_config: TOU 配置
        storage_config: 储能配置
        storage_results: 储能测算结果
        quality_report: 数据质量报告
        api_key: DeepSeek API Key（可选，未传则从环境变量读取）
    
    Returns:
        生成的 Markdown 报告文本
    
    Raises:
        DeepSeekError: 生成失败时抛出
    """
    # 1. 提取数据
    input_data = extract_summary_data(
        project_info=project_info,
        load_profile=load_profile,
        tou_config=tou_config,
        storage_config=storage_config,
        storage_results=storage_results,
        quality_report=quality_report,
    )
    
    # 2. 构建 Prompt
    prompt = build_deepseek_prompt(input_data)
    
    # 3. 调用 DeepSeek API
    markdown_report = await call_deepseek_api(prompt, api_key=api_key)
    
    return markdown_report
