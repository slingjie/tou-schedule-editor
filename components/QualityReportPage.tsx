import React from 'react';
import type { Schedule, DateRule, BackendAnalysisMeta, BackendQualityReport } from '../types';
import { QualityReportPanel } from './QualityReportPanel';

interface QualityReportPageProps {
  scheduleData: {
    monthlySchedule: Schedule;
    dateRules: DateRule[];
  };
  externalQualityReport?: BackendQualityReport | null;
  externalMetaInfo?: BackendAnalysisMeta | null;
}

export const QualityReportPage: React.FC<QualityReportPageProps> = ({ externalQualityReport, externalMetaInfo }) => {
  const hasData = !!externalQualityReport;
  return (
    <div className="space-y-6">
      {/* 顶部说明与空态提示已按需求移除，仅在有数据时展示报告 */}

      {hasData && externalQualityReport && (
        <QualityReportPanel report={externalQualityReport} meta={externalMetaInfo ?? null} />
      )}

      {/* 本页说明（固定显示在页面底部） */}
      <div id="section-quality-note" className="scroll-mt-24 p-4 bg-slate-50 rounded-lg border border-slate-300 text-sm text-slate-600">
        本页说明：展示数据完整性与异常统计，包括基础信息（时间范围、记录数、采样间隔）、按月缺失统计、缺失日期列表，以及异常值统计（空值/零值/负值）。
        若页面无数据，请先在顶部“负荷文件”处上传；数据量较大时，报告生成可能需要数秒，属正常现象。
      </div>
    </div>
  );
};

export default QualityReportPage;
