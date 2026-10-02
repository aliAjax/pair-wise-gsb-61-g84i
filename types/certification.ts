export const projectStatuses = [
  'draft',
  'submitted',
  'under_review',
  'supplement_required',
  'approved',
  'rejected'
] as const;

// stale：证据曾被接受，但绑定的版本快照已被项目基线更新覆盖，需要回到待确认
export const evidenceStatuses = ['missing', 'submitted', 'accepted', 'rejected', 'resubmit', 'stale'] as const;

export type ProjectStatus = (typeof projectStatuses)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];

/** 项目版本基线快照：维护版本、软件版本和配置范围的不可变组合 */
export interface BaselineSnapshot {
  maintenanceVersion: string;
  softwareVersion: string;
  configuration: string;
}

/** 审阅结论绑定的快照定位信息 */
export interface SnapshotBinding extends BaselineSnapshot {
  /** 接受该证据时所在的项目版本 ID */
  versionId: string;
  acceptedAt: string;
}

export interface RegulationItem {
  id: string;
  code: string;
  title: string;
  category: '安全' | '环保' | '能耗' | '软件' | '部件';
  required: boolean;
  /** 当前值为种子静态信息，展示时由快照重算覆盖（见 services/snapshot.ts） */
  status: 'complete' | 'missing' | 'conflict';
  coverage: number;
  issues: string[];
}

export interface EvidenceItem {
  id: string;
  projectId: string;
  regulationId: string;
  name: string;
  type: 'test_report' | 'part_list' | 'software_report' | 'exemption' | 'certificate';
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  expiryDate?: string;
  note: string;
  updatedAt: string;
  /** 仅在证据被接受时存在：接受结论绑定的版本快照；基线更新后据此判定是否失效 */
  acceptedSnapshot?: SnapshotBinding;
}

export interface ProjectVersion extends BaselineSnapshot {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

/** 提交包内冻结的证据快照 */
export interface SubmissionPackageEvidence {
  id: string;
  regulationId: string;
  name: string;
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  note: string;
}

/** 提交包内冻结的法规覆盖快照 */
export interface SubmissionPackageRegulation {
  id: string;
  code: string;
  title: string;
  category: RegulationItem['category'];
  required: boolean;
  status: RegulationItem['status'];
  coverage: number;
  issues: string[];
}

/**
 * 历史提交包：提交/批准时刻的不可变快照。
 * 基线更新后当前结论重算，但历史提交包保留提交当时的原样。
 */
export interface SubmissionPackageRecord {
  id: string;
  packageNo: number;
  projectId: string;
  createdAt: string;
  actor: string;
  triggeredBy: ProjectStatus;
  reason: string;
  baseline: BaselineSnapshot;
  versionId: string;
  evidence: SubmissionPackageEvidence[];
  regulations: SubmissionPackageRegulation[];
  blockingIssues: string[];
}

export interface ApprovalProject {
  id: string;
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  status: ProjectStatus;
  progress: number;
  applicant: string;
  reviewer: string;
  agency: string;
  submittedAt?: string;
  updatedAt: string;
  certificateExpiry: string;
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  audit: AuditEntry[];
  /** 当前基线对应的版本 ID */
  baselineVersionId?: string;
  /** 历史提交包，按下发时间倒序，内容不可变 */
  submissionPackages: SubmissionPackageRecord[];
}

export interface ProjectInput {
  name: string;
  modelCode: string;
  vehicleType: string;
  configuration: string;
  maintenanceVersion: string;
  softwareVersion: string;
  applicant: string;
  agency: string;
  certificateExpiry: string;
}

export interface ProjectFilters {
  query: string;
  status: ProjectStatus | 'all';
  agency: string | 'all';
  risk: 'all' | 'expiring' | 'missing' | 'version_conflict' | 'stale';
}
