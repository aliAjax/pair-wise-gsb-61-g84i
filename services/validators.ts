import type { ApprovalProject, EvidenceItem, ProjectInput } from '~/types/certification';
import {
  computeBlockingIssues,
  coversConfiguration,
  recomputeRegulations,
  softwareMatchesBaseline
} from './snapshot';

export function validateProjectInput(input: ProjectInput) {
  const errors: Partial<Record<keyof ProjectInput, string>> = {};

  if (input.name.trim().length < 3) errors.name = '项目名称至少 3 个字符';
  if (!/^[A-Za-z0-9-]{3,}$/.test(input.modelCode.trim())) errors.modelCode = '车型代码只能包含字母、数字和连字符';
  if (!input.vehicleType.trim()) errors.vehicleType = '请选择车辆类别';
  if (input.configuration.trim().length < 2) errors.configuration = '请填写配置名称';
  if (!/^MY\d{2}\.\d+$/.test(input.maintenanceVersion.trim())) errors.maintenanceVersion = '维护版本格式应类似 MY27.1';
  if (!/^\d+\.\d+\.\d+$/.test(input.softwareVersion.trim())) errors.softwareVersion = '软件版本格式应类似 8.4.1';
  if (input.applicant.trim().length < 2) errors.applicant = '请填写申请主体';
  if (input.agency.trim().length < 2) errors.agency = '请选择认证机构';
  if (!input.certificateExpiry) errors.certificateExpiry = '请选择证书有效期';

  return errors;
}

/** 批准前阻断项：法规覆盖、失效证据、版本错配、配置覆盖全部按当前快照重算 */
export function validateSubmission(project: ApprovalProject) {
  return computeBlockingIssues(project, recomputeRegulations(project));
}

/**
 * 重新确认（接受）证据的强制条件：
 * 1. 配置范围必须覆盖项目当前配置；
 * 2. 证据软件版本必须与项目基线相同。
 * 任一不满足都不能接受，相应证据也会阻断项目批准。
 */
export function validateEvidenceAcceptance(project: ApprovalProject, evidence: EvidenceItem) {
  const errors: string[] = [];
  if (!coversConfiguration(evidence, project.configuration)) {
    errors.push(
      `配置范围未覆盖当前配置「${project.configuration}」（证据覆盖：${evidence.configurations.join('、') || '无'}）`
    );
  }
  if (!softwareMatchesBaseline(evidence, project)) {
    errors.push(
      `软件版本 ${evidence.softwareVersion} 与项目基线 ${project.softwareVersion} 不一致`
    );
  }
  return errors;
}

export function validateEvidenceUpgrade(project: ApprovalProject, evidenceIds: string[], note: string) {
  const errors: string[] = [];
  if (!evidenceIds.length) errors.push('至少选择一项待补件证据');
  if (note.trim().length < 6) errors.push('批量补件说明至少 6 个字符');
  const selected = project.evidence.filter((item) => evidenceIds.includes(item.id));
  if (!selected.length) errors.push('所选证据不属于当前项目');
  return errors;
}
