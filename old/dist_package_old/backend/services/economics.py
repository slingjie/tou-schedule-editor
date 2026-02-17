"""
储能经济性测算服务模块

提供 IRR、静态回收期、年度现金流序列等核心计算功能。
基于需求文档 docs/1130经济性测算需求.md 设计。
"""

from __future__ import annotations

import math
import csv
import os
import zipfile
from datetime import datetime
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class YearlyCashflowItem:
    """年度现金流单条记录"""
    year_index: int  # 第几年，1..N
    year_revenue: float  # 年度收益（已扣电费、按衰减计算）
    annual_om_cost: float  # 当年运维成本
    cell_replacement_cost: float  # 当年电芯更换成本（无则为 0）
    net_cashflow: float  # 年度净现金流 = 年收益 - 运维 - 更换成本
    cumulative_net_cashflow: float  # 累计净现金流


@dataclass
class EconomicsResult:
    """经济性测算结果"""
    capex_total: float  # 总投资 CAPEX（元）
    irr: Optional[float]  # 内部收益率（0–1，如 0.12 表示 12%），无法收敛则为 None
    static_payback_years: Optional[float]  # 静态回收期（年），可带小数
    final_cumulative_net_cashflow: float  # 项目周期末累计净现金流
    yearly_cashflows: List[YearlyCashflowItem]  # 年度现金流序列
    static_lcoe: Optional[float] = None  # 静态平均度电成本（元/kWh）
    annual_energy_kwh: Optional[float] = None  # 年均发电能量（kWh）
    annual_revenue_yuan: Optional[float] = None  # 年均收益（元）
    revenue_per_kwh: Optional[float] = None  # 度电平均收益（元/kWh）
    lcoe_ratio: Optional[float] = None  # 经济可行性比值
    screening_result: Optional[str] = None  # 筛选结论：'pass' 或 'fail'


def build_cashflows(
    first_year_revenue: float,
    project_years: int,
    annual_om_cost: float,
    first_year_decay_rate: float,
    subsequent_decay_rate: float,
    cell_replacement_year: Optional[int] = None,
    cell_replacement_cost: Optional[float] = None,
    second_phase_first_year_revenue: Optional[float] = None,
) -> List[YearlyCashflowItem]:
    """
    构建年度现金流序列。

    参数:
        first_year_revenue: 首年收益 R₁（已扣电费、未扣运维）
        project_years: 项目年限 N
        annual_om_cost: 每年运维成本
        first_year_decay_rate: 首年衰减率（0–1，如 0.03 表示 3%）
        subsequent_decay_rate: 次年至末年衰减率（0–1，如 0.015 表示 1.5%）
        cell_replacement_year: 电芯更换发生的年份（第 T 年），可选
        cell_replacement_cost: 电芯更换成本，可选
        second_phase_first_year_revenue: 更换后新的首年收益 R′₁，可选，默认与 R₁ 相同

        衰减计算逻辑（按阶段，含首年衰减）:
                - 每个阶段的"首年"（含项目第 1 年和更换电芯当年）均视为已发生首年衰减:
                    R₁,eff = R₁ × (1 - first_year_decay_rate)
                - 阶段内第 t 年的收益为:
                    R_t = R₁,eff × (1 - subsequent_decay_rate)^(t-1)

    返回:
        List[YearlyCashflowItem]: 长度为 project_years 的年度现金流列表
    """
    if second_phase_first_year_revenue is None:
        second_phase_first_year_revenue = first_year_revenue

    cashflows: List[YearlyCashflowItem] = []
    cumulative = 0.0

    # 当前阶段的首年收益基准与起始年份
    current_base_revenue = first_year_revenue
    phase_start_year = 1

    for t in range(1, project_years + 1):
        # 判断是否在本年度发生电芯更换：
        # 业务期望：更换当年收益应视为“新阶段首年”，即恢复到新的首年收益水平，
        # 而不是继续沿用更换前已衰减多年的值。
        if cell_replacement_year and t == cell_replacement_year:
            # 更换当年视为新阶段第 1 年
            current_base_revenue = second_phase_first_year_revenue
            phase_start_year = t
            replacement = cell_replacement_cost or 0.0
        else:
            replacement = 0.0

        # 计算当年收益（考虑衰减）
        years_in_phase = t - phase_start_year  # 距离阶段开始的年数（0 表示阶段首年）

        # 所有年份均视为已包含首年衰减：
        # R_t = R₁ × (1 - first_year_decay_rate) × (1 - subsequent_decay_rate)^years_in_phase
        year_revenue = current_base_revenue * (1 - first_year_decay_rate) * (
            (1 - subsequent_decay_rate) ** years_in_phase
        )

        net_cf = year_revenue - annual_om_cost - replacement
        cumulative += net_cf

        cashflows.append(
            YearlyCashflowItem(
                year_index=t,
                year_revenue=round(year_revenue, 2),
                annual_om_cost=round(annual_om_cost, 2),
                cell_replacement_cost=round(replacement, 2),
                net_cashflow=round(net_cf, 2),
                cumulative_net_cashflow=round(cumulative, 2),
            )
        )

    return cashflows


def compute_static_payback(
    cashflows: List[YearlyCashflowItem],
    capex_total: float,
) -> Optional[float]:
    """
    计算静态回收期（不折现）。

    参数:
        cashflows: 年度现金流序列
        capex_total: 总投资 CAPEX

    返回:
        静态回收期（年，可带小数），如果在项目周期内无法回本则返回 None
    """
    if capex_total <= 0:
        return 0.0  # 无投资则立即回本

    cumulative = 0.0
    prev_cumulative = 0.0

    for cf in cashflows:
        prev_cumulative = cumulative
        cumulative += cf.net_cashflow

        if cumulative >= capex_total:
            # 在当年内线性插值
            year_idx = cf.year_index
            if cf.net_cashflow > 0:
                # 还需多少才能回本
                shortfall = capex_total - prev_cumulative
                fraction = shortfall / cf.net_cashflow
                return round(year_idx - 1 + fraction, 2)
            else:
                return float(year_idx)

    # 项目周期内无法回本
    return None


def compute_irr(
    cashflows: List[YearlyCashflowItem],
    capex_total: float,
    max_iterations: int = 100,
    tolerance: float = 1e-6,
) -> Optional[float]:
    """
    计算 IRR（内部收益率）。

    使用牛顿迭代法求解 NPV(r) = 0。
    
    现金流序列：
        CF₀ = -capex_total
        CF₁..CFₙ = 各年 net_cashflow

    参数:
        cashflows: 年度现金流序列
        capex_total: 总投资 CAPEX
        max_iterations: 最大迭代次数
        tolerance: 收敛精度

    返回:
        IRR（0–1 之间的小数），如 0.12 表示 12%；无法收敛则返回 None
    """
    if not cashflows or capex_total <= 0:
        return None

    # 构造现金流数组 [CF0, CF1, ..., CFn]
    cf_list = [-capex_total] + [cf.net_cashflow for cf in cashflows]
    n = len(cf_list)

    def npv(r: float) -> float:
        """计算给定折现率 r 下的 NPV"""
        total = 0.0
        for t, cf in enumerate(cf_list):
            total += cf / ((1 + r) ** t)
        return total

    def npv_derivative(r: float) -> float:
        """NPV 对 r 的导数"""
        total = 0.0
        for t, cf in enumerate(cf_list):
            if t > 0:
                total -= t * cf / ((1 + r) ** (t + 1))
        return total

    # 初始猜测
    r = 0.1

    for _ in range(max_iterations):
        npv_val = npv(r)
        if abs(npv_val) < tolerance:
            return round(r, 6)

        deriv = npv_derivative(r)
        if abs(deriv) < 1e-12:
            # 导数过小，无法继续迭代
            break

        r_new = r - npv_val / deriv

        # 限制 r 在合理范围内
        if r_new < -0.99:
            r_new = -0.99
        elif r_new > 10.0:
            r_new = 10.0

        if abs(r_new - r) < tolerance:
            return round(r_new, 6)

        r = r_new

    # 尝试二分法作为备用
    return _irr_bisection(cf_list, tolerance, max_iterations)


def _irr_bisection(
    cf_list: List[float],
    tolerance: float = 1e-6,
    max_iterations: int = 100,
) -> Optional[float]:
    """二分法求 IRR（备用方法）"""
    
    def npv(r: float) -> float:
        total = 0.0
        for t, cf in enumerate(cf_list):
            total += cf / ((1 + r) ** t)
        return total

    # 找到一个使 NPV 为正和为负的区间
    low, high = -0.99, 2.0
    npv_low = npv(low)
    npv_high = npv(high)

    # 如果同号，说明可能没有实数解
    if npv_low * npv_high > 0:
        return None

    for _ in range(max_iterations):
        mid = (low + high) / 2
        npv_mid = npv(mid)

        if abs(npv_mid) < tolerance:
            return round(mid, 6)

        if npv_mid * npv_low < 0:
            high = mid
            npv_high = npv_mid
        else:
            low = mid
            npv_low = npv_mid

        if high - low < tolerance:
            return round((low + high) / 2, 6)

    return None


def compute_economics(
    first_year_revenue: float,
    project_years: int,
    annual_om_cost: float,
    first_year_decay_rate: float,
    subsequent_decay_rate: float,
    capex_per_wh: float,
    installed_capacity_kwh: float,
    first_year_energy_kwh: Optional[float] = None,
    cell_replacement_year: Optional[int] = None,
    cell_replacement_cost: Optional[float] = None,
    second_phase_first_year_revenue: Optional[float] = None,
) -> EconomicsResult:
    """
    主入口：计算储能项目经济性指标。

    参数:
        first_year_revenue: 首年收益（已扣电费、未扣运维）
        project_years: 项目年限
        annual_om_cost: 年运维成本
        first_year_decay_rate: 首年衰减率（0–1）
        subsequent_decay_rate: 次年至末年衰减率（0–1）
        capex_per_wh: 单 Wh 投资（元/Wh）
        installed_capacity_kwh: 储能装机容量（kWh）
        first_year_energy_kwh: 首年发电能量（kWh），来自 Storage Cycles。若提供，用于精确计算静态指标
        cell_replacement_year: 电芯更换年份（可选）
        cell_replacement_cost: 电芯更换成本（可选）
        second_phase_first_year_revenue: 更换后新的首年收益（可选）

    返回:
        EconomicsResult: 包含 CAPEX、IRR、静态回收期、累计净现金流、年度现金流序列
    """
    # 计算总投资 CAPEX（kWh -> Wh）
    capex_total = capex_per_wh * installed_capacity_kwh * 1000

    # 构建年度现金流
    cashflows = build_cashflows(
        first_year_revenue=first_year_revenue,
        project_years=project_years,
        annual_om_cost=annual_om_cost,
        first_year_decay_rate=first_year_decay_rate,
        subsequent_decay_rate=subsequent_decay_rate,
        cell_replacement_year=cell_replacement_year,
        cell_replacement_cost=cell_replacement_cost,
        second_phase_first_year_revenue=second_phase_first_year_revenue,
    )

    # 计算静态回收期
    static_payback = compute_static_payback(cashflows, capex_total)

    # 计算 IRR
    irr = compute_irr(cashflows, capex_total)

    # 最终累计净现金流
    final_cumulative = cashflows[-1].cumulative_net_cashflow if cashflows else 0.0

    # 计算静态指标（第一步快速筛选）
    static_metrics = compute_static_metrics(
        cashflows=cashflows,
        capex_total=capex_total,
        project_years=project_years,
        first_year_energy_kwh=first_year_energy_kwh,
        first_year_decay_rate=first_year_decay_rate,
        subsequent_decay_rate=subsequent_decay_rate,
    )

    return EconomicsResult(
        capex_total=round(capex_total, 2),
        irr=irr,
        static_payback_years=static_payback,
        final_cumulative_net_cashflow=round(final_cumulative, 2),
        yearly_cashflows=cashflows,
        static_lcoe=static_metrics.get('static_lcoe'),
        annual_energy_kwh=static_metrics.get('annual_energy_kwh'),
        annual_revenue_yuan=static_metrics.get('annual_revenue_yuan'),
        revenue_per_kwh=static_metrics.get('revenue_per_kwh'),
        lcoe_ratio=static_metrics.get('lcoe_ratio'),
        screening_result=static_metrics.get('screening_result'),
    )


def compute_static_metrics(
    cashflows: List[YearlyCashflowItem],
    capex_total: float,
    project_years: int,
    first_year_energy_kwh: Optional[float] = None,
    first_year_decay_rate: float = 0.03,
    subsequent_decay_rate: float = 0.015,
    pass_threshold: float = 1.5,
) -> dict:
    """
    计算静态经济性评估指标（第一步：快速筛选）。

    参数:
        cashflows: 年度现金流序列
        capex_total: 总投资 CAPEX（元）
        project_years: 项目年限（年）
        first_year_energy_kwh: 首年发电能量（kWh），来自 Storage Cycles 计算。若提供，用于精确计算年均能量；否则按衰减模型估算
        first_year_decay_rate: 首年衰减率（0–1），用于估算年均能量的衰减系数
        subsequent_decay_rate: 次年至末年衰减率（0–1），用于估算年均能量的衰减系数
        pass_threshold: 通过阈值（建议 1.5），比值 ≥ threshold 为通过

    返回:
        字典，包含：
        - static_lcoe: 静态度电成本（元/kWh）
        - annual_energy_kwh: 年均发电能量（kWh）
        - annual_revenue_yuan: 年均收益（元）
        - revenue_per_kwh: 度电平均收益（元/kWh）
        - lcoe_ratio: 经济可行性比值
        - screening_result: 筛选结论（'pass' 或 'fail'）
        - pass_threshold: 使用的通过阈值
    """
    if not cashflows or capex_total <= 0 or project_years <= 0:
        return {
            'static_lcoe': 0.0,
            'annual_energy_kwh': 0.0,
            'annual_revenue_yuan': 0.0,
            'revenue_per_kwh': 0.0,
            'lcoe_ratio': 0.0,
            'screening_result': 'fail',
            'pass_threshold': pass_threshold,
        }

    # 计算累计收益（年度现金流中的 year_revenue 之和）
    total_revenue = sum(cf.year_revenue for cf in cashflows)
    annual_revenue = total_revenue / project_years  # 年均收益

    # 计算年均发电能量
    if first_year_energy_kwh is not None and first_year_energy_kwh > 0:
        # 使用实际的首年能量数据（来自 Storage Cycles）
        # 计算能量衰减序列并求平均
        total_energy = 0.0
        energy_current = first_year_energy_kwh
        
        for year_idx in range(1, project_years + 1):
            total_energy += energy_current
            if year_idx == 1:
                # 首年之后应用首年衰减率
                energy_current *= (1 - first_year_decay_rate)
            else:
                # 后续年份应用衰减率
                energy_current *= (1 - subsequent_decay_rate)
        
        annual_energy = total_energy / project_years
    else:
        # 若无实际能量数据，使用收益推算（假设度电收益为 1.0 元/kWh，这是备选方案）
        # 警告：这种方法不准确，应尽量从前端传入实际能量数据
        reference_revenue_per_kwh = 1.0
        annual_energy = annual_revenue / reference_revenue_per_kwh if reference_revenue_per_kwh > 0 else 0.0

    # 计算静态 LCOE（度电成本）
    # LCOE = CAPEX / (年均能量 × 项目年限) = CAPEX / 累计能量
    if annual_energy > 0:
        static_lcoe = capex_total / (annual_energy * project_years)
    else:
        static_lcoe = 0.0

    # 计算度电平均收益
    if annual_energy > 0:
        revenue_per_kwh = annual_revenue / annual_energy
    else:
        revenue_per_kwh = 0.0

    # 计算经济可行性比值
    if static_lcoe > 0:
        lcoe_ratio = revenue_per_kwh / static_lcoe
    else:
        lcoe_ratio = 0.0

    # 判断筛选结论
    screening_result = 'pass' if lcoe_ratio >= pass_threshold else 'fail'

    return {
        'static_lcoe': round(static_lcoe, 4),
        'annual_energy_kwh': round(annual_energy, 2),
        'annual_revenue_yuan': round(annual_revenue, 2),
        'revenue_per_kwh': round(revenue_per_kwh, 4),
        'lcoe_ratio': round(lcoe_ratio, 4),
        'screening_result': screening_result,
        'pass_threshold': pass_threshold,
    }


def export_economics_cashflow_report(
    result: EconomicsResult,
    user_share_percent: float = 0.0,
    yearly_discharge_energy_kwh: Optional[List[float]] = None,
    output_dir: str = None,
    filename_prefix: str = "经济性现金流报表"
) -> str:
    """
    导出多年期经济性现金流明细报表（CSV格式）
    
    Args:
        result: 经济性测算结果对象
        user_share_percent: 用户收益分成比例（0-100）
        yearly_discharge_energy_kwh: 各年度储能放电量（kWh）列表，长度应与项目年限一致
        output_dir: 输出目录（默认使用 app_paths.OUTPUTS_DIR）
        filename_prefix: 文件名前缀
    
    Returns:
        生成的ZIP文件路径（相对于outputs目录）
    """
    from .app_paths import OUTPUTS_DIR
    if output_dir is None:
        output_dir = str(OUTPUTS_DIR)
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_filename = f"{filename_prefix}_{timestamp}.zip"
    zip_path = os.path.join(output_dir, zip_filename)
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # 1. 年度现金流明细表
        cashflow_csv = f"年度现金流明细_{timestamp}.csv"
        cashflow_path = os.path.join(output_dir, cashflow_csv)
        
        with open(cashflow_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            # 表头
            writer.writerow([
                '年份',
                '原年度总收益(元)',
                '用户方年度收益(元)',
                '项目方年度收益(元)',
                '储能放电量(kWh)',
                '运维成本(元)',
                '电芯更换成本(元)',
                '年度净现金流(元)',
                '累计净现金流(元)'
            ])
            
            # 计算用户分成比例（0-1）
            share_ratio = user_share_percent / 100.0 if user_share_percent else 0.0
            
            # 数据行
            for idx, item in enumerate(result.yearly_cashflows):
                # 项目方年度收益（result中存储的就是项目方的）
                project_revenue = item.year_revenue
                # 反推原年度总收益：项目方收益 / (1 - 分成比例)
                total_revenue = project_revenue / (1 - share_ratio) if share_ratio < 1.0 else project_revenue
                # 用户方年度收益
                user_revenue = total_revenue * share_ratio
                # 储能放电量
                discharge_kwh = yearly_discharge_energy_kwh[idx] if yearly_discharge_energy_kwh and idx < len(yearly_discharge_energy_kwh) else 0.0
                
                writer.writerow([
                    item.year_index,
                    round(total_revenue, 2),
                    round(user_revenue, 2),
                    round(project_revenue, 2),
                    round(discharge_kwh, 2),
                    round(item.annual_om_cost, 2),
                    round(item.cell_replacement_cost, 2),
                    round(item.net_cashflow, 2),
                    round(item.cumulative_net_cashflow, 2)
                ])
        
        zipf.write(cashflow_path, cashflow_csv)
        os.remove(cashflow_path)
        
        # 2. 经济性指标汇总表
        summary_csv = f"经济性指标汇总_{timestamp}.csv"
        summary_path = os.path.join(output_dir, summary_csv)
        
        with open(summary_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(['指标名称', '数值', '单位'])
            writer.writerow(['总投资(CAPEX)', round(result.capex_total, 2), '元'])
            writer.writerow([
                '内部收益率(IRR)', 
                f"{round(result.irr * 100, 2)}%" if result.irr is not None else '无法收敛',
                '-'
            ])
            writer.writerow([
                '静态回收期', 
                f"{round(result.static_payback_years, 2)}年" if result.static_payback_years is not None else '超出项目周期',
                '-'
            ])
            writer.writerow([
                '项目末累计净现金流', 
                round(result.final_cumulative_net_cashflow, 2), 
                '元'
            ])
            
            # 可选指标（如果存在）
            if result.static_lcoe is not None:
                writer.writerow(['静态平均度电成本(LCOE)', round(result.static_lcoe, 4), '元/kWh'])
            if result.annual_energy_kwh is not None:
                writer.writerow(['年均发电能量', round(result.annual_energy_kwh, 2), 'kWh'])
            if result.annual_revenue_yuan is not None:
                writer.writerow(['年均收益', round(result.annual_revenue_yuan, 2), '元'])
            if result.revenue_per_kwh is not None:
                writer.writerow(['度电平均收益', round(result.revenue_per_kwh, 4), '元/kWh'])
            if result.lcoe_ratio is not None:
                writer.writerow(['经济可行性比值', round(result.lcoe_ratio, 4), '-'])
            if result.screening_result is not None:
                writer.writerow(['筛选结论', result.screening_result, '-'])
        
        zipf.write(summary_path, summary_csv)
        os.remove(summary_path)
    
    # 返回相对路径（用于前端下载）
    return zip_filename
