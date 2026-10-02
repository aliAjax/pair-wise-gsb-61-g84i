import type { ApprovalProject, EvidenceItem, ProjectInput } from '~/types/certification';
import { acceptanceViolations, currentSnapshot, deriveBlockingIssues } from './snapshots';

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

/** 批准/提交前阻断项：按当前快照与证据实时重算 */
export function validateSubmission(project: ApprovalProject): string[] {
  return deriveBlockingIssues(project);
}

/** 重新确认证据：配置范围必须覆盖当前配置，软件版本必须与项目基线相同 */
export function validateEvidenceAcceptance(project: ApprovalProject, evidence: EvidenceItem): string[] {
  return acceptanceViolations(evidence, currentSnapshot(project));
}

export function validateEvidenceUpgrade(project: ApprovalProject, evidenceIds: string[], note: string) {
  const errors: string[] = [];
  if (!evidenceIds.length) errors.push('至少选择一项待补件证据');
  if (note.trim().length < 6) errors.push('批量补件说明至少 6 个字符');
  const selected = project.evidence.filter((item) => evidenceIds.includes(item.id));
  if (!selected.length) errors.push('所选证据不属于当前项目');
  return errors;
}
