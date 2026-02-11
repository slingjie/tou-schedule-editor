from __future__ import annotations

import json
import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import httpx

from ..schemas import ReportDataV3, ReportNarrativeV3

logger = logging.getLogger(__name__)


class ReportAiPolishError(Exception):
    pass


_NUM_RE = re.compile(r"(?<![A-Za-z_])(\d+(?:\.\d+)?%?)(?![A-Za-z_])")


def _mask_numbers(text: str) -> Tuple[str, Dict[str, str]]:
    """
    将文本中的数值替换为占位符，避免模型“改数值/编造数值”。
    """
    mapping: Dict[str, str] = {}
    idx = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal idx
        idx += 1
        token = f"{{{{NUM_{idx}}}}}"
        mapping[token] = m.group(1)
        return token

    masked = _NUM_RE.sub(repl, text or "")
    return masked, mapping


def _unmask_numbers(text: str, mapping: Dict[str, str]) -> str:
    out = text or ""
    for token, val in mapping.items():
        out = out.replace(token, val)
    return out


def _validate_placeholders(text: str, mapping: Dict[str, str]) -> bool:
    """
    确保模型输出保留了所有占位符，防止占位符丢失导致数值被改写。
    """
    for token in mapping.keys():
        if token not in (text or ""):
            return False
    return True


async def _call_deepseek(prompt: str, api_key: Optional[str] = None, model: str = "deepseek-chat") -> str:
    if not api_key:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        raise ReportAiPolishError("DeepSeek API Key 未配置（DEEPSEEK_API_KEY）。")

    url = "https://api.deepseek.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 1200,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                raise ReportAiPolishError(f"DeepSeek 返回格式异常: {data}")
            content = (choices[0].get("message") or {}).get("content") or ""
            if not content:
                raise ReportAiPolishError("DeepSeek 返回内容为空")
            return str(content)
    except httpx.HTTPStatusError as exc:
        raise ReportAiPolishError(f"DeepSeek 请求失败 (HTTP {exc.response.status_code}): {exc.response.text}") from exc
    except httpx.RequestError as exc:
        raise ReportAiPolishError(f"DeepSeek 网络请求异常: {exc}") from exc
    except Exception as exc:
        raise ReportAiPolishError(f"DeepSeek 调用异常: {exc}") from exc


async def polish_report_narrative(report: ReportDataV3) -> ReportNarrativeV3:
    """
    对摘要/结论/风险/建议进行文案润色：
    - 仅润色措辞，不新增/不修改任何数值（通过占位符强约束）
    - 失败自动降级：抛出异常由上层捕获后使用原文
    """
    narrative = report.narrative

    summary_masked, summary_map = _mask_numbers(narrative.summary)
    conclusion_masked, conclusion_map = _mask_numbers(narrative.conclusion)

    risks_masked: List[str] = []
    risks_maps: List[Dict[str, str]] = []
    for r in (narrative.risks or []):
        masked, mp = _mask_numbers(str(r))
        risks_masked.append(masked)
        risks_maps.append(mp)

    suggestions_masked: List[str] = []
    suggestions_maps: List[Dict[str, str]] = []
    for s in (narrative.suggestions or []):
        masked, mp = _mask_numbers(str(s))
        suggestions_masked.append(masked)
        suggestions_maps.append(mp)

    input_json = {
        "summary": summary_masked,
        "conclusion": conclusion_masked,
        "risks": risks_masked,
        "suggestions": suggestions_masked,
    }

    prompt = f"""你是一名资深储能与电价分析报告编辑，请对下面 JSON 中的中文文案进行润色，使表达更专业、结构更清晰、语气更适合正式交付报告。

硬性约束（必须遵守）：
1) 你不得新增任何数字或比例；你不得修改任何数字或单位。
2) 你必须原样保留并输出所有占位符（形如 {{{{NUM_1}}}} ），占位符不能改写、不能移动到别的字段、不能丢失。
3) 只输出 JSON（不要 Markdown、不要解释），字段必须包含 summary/conclusion/risks/suggestions，risks/suggestions 仍为字符串数组。

输入 JSON：
{json.dumps(input_json, ensure_ascii=False)}
"""

    raw = await _call_deepseek(prompt)
    # 允许模型前后夹杂少量空白，提取第一段 JSON
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        raise ReportAiPolishError(f"AI 返回非 JSON: {raw[:200]}")
    cleaned = raw[start : end + 1]
    try:
        parsed = json.loads(cleaned)
    except Exception as exc:
        raise ReportAiPolishError(f"AI JSON 解析失败: {exc}; raw={cleaned[:200]}") from exc

    out_summary = str(parsed.get("summary") or "")
    out_conclusion = str(parsed.get("conclusion") or "")
    out_risks = parsed.get("risks") or []
    out_suggestions = parsed.get("suggestions") or []

    if not _validate_placeholders(out_summary, summary_map):
        raise ReportAiPolishError("AI 输出 summary 占位符不完整，已拒绝应用。")
    if not _validate_placeholders(out_conclusion, conclusion_map):
        raise ReportAiPolishError("AI 输出 conclusion 占位符不完整，已拒绝应用。")

    fixed_risks: List[str] = []
    for i, x in enumerate(out_risks if isinstance(out_risks, list) else []):
        t = str(x)
        if not _validate_placeholders(t, risks_maps[i] if i < len(risks_maps) else {}):
            raise ReportAiPolishError("AI 输出 risks 占位符不完整，已拒绝应用。")
        fixed_risks.append(_unmask_numbers(t, risks_maps[i] if i < len(risks_maps) else {}))

    fixed_suggestions: List[str] = []
    for i, x in enumerate(out_suggestions if isinstance(out_suggestions, list) else []):
        t = str(x)
        if not _validate_placeholders(t, suggestions_maps[i] if i < len(suggestions_maps) else {}):
            raise ReportAiPolishError("AI 输出 suggestions 占位符不完整，已拒绝应用。")
        fixed_suggestions.append(_unmask_numbers(t, suggestions_maps[i] if i < len(suggestions_maps) else {}))

    return ReportNarrativeV3(
        summary=_unmask_numbers(out_summary, summary_map),
        conclusion=_unmask_numbers(out_conclusion, conclusion_map),
        risks=fixed_risks,
        suggestions=fixed_suggestions,
    )

