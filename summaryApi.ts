/**
 * 项目评估报告生成相关 API
 */

import { getApiBaseUrl } from './desktopBackend';

const API_BASE = getApiBaseUrl();

export interface ProjectSummaryRequest {
  project_name: string;
  project_location?: string;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  load_profile?: Record<string, any>;
  tou_config?: Record<string, any>;
  storage_config?: Record<string, any>;
  storage_results?: Record<string, any>;
  quality_report?: Record<string, any>;
}

export interface ProjectSummaryResponse {
  report_id: string;
  project_name: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  markdown: string;
  summary: {
    firstYearRevenue?: string;
    dailyCycles?: string;
    utilizationHoursRange?: string;
    loadDataCompleteness?: string;
    overallConclusion?: string;
  };
}

/**
 * 调用后端生成项目评估报告
 */
export async function generateProjectSummary(
  request: ProjectSummaryRequest
): Promise<ProjectSummaryResponse> {
  const response = await fetch(`${API_BASE}/api/deepseek/project-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`生成报告失败 (${response.status}): ${errorText}`);
  }

  return response.json();
}
