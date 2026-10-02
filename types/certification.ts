export const projectStatuses = [
  'draft',
  'submitted',
  'under_review',
  'supplement_required',
  'approved',
  'rejected'
] as const;

// pending_confirmation：证据曾在旧快照下被接受，基线更新后结论失效，等待审阅人按当前快照重新确认
export const evidenceStatuses = [
  'missing',
  'submitted',
  'accepted',
  'pending_confirmation',
  'rejected',
  'resubmit'
] as const;

export type ProjectStatus = (typeof projectStatuses)[number];
export type EvidenceStatus = (typeof evidenceStatuses)[number];

/** 不可变的项目基线快照：审阅结论与提交包都绑定到具体快照 */
export interface BaselineSnapshot {
  id: string;
  maintenanceVersion: string;
  softwareVersion: string;
  configuration: string;
  createdAt: string;
  author: string;
  reason: string;
  /** 相对上一快照发生变化的基线维度 */
  changes: Array<'维护版本' | '软件版本' | '配置范围'>;
  impactedConfigurations: string[];
}

export interface RegulationItem {
  id: string;
  code: string;
  title: string;
  category: '安全' | '环保' | '能耗' | '软件' | '部件';
  required: boolean;
  status: 'complete' | 'missing' | 'conflict';
  coverage: number;
  issues: string[];
}

/** 法规目录定义（静态）；覆盖状态/百分比/问题按当前快照派生，不再直接信任存储值 */
export type RegulationCatalogItem = Pick<RegulationItem, 'id' | 'code' | 'title' | 'category' | 'required'>;

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
  /** 当前审阅结论所绑定的基线快照；null 表示结论尚未在任何快照下确认 */
  reviewSnapshotId: string | null;
  /** 结论失效（回到待确认）时记录原因与来源快照 */
  invalidatedReason?: string;
  reviewedAt?: string;
}

export interface ProjectVersion {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  changes: string[];
  impactedConfigurations: string[];
  /** 该版本记录对应的基线快照 */
  snapshot: BaselineSnapshot;
}

/** 提交包内冻结的证据视图 */
export interface PackageEvidence {
  id: string;
  regulationId: string;
  name: string;
  type: EvidenceItem['type'];
  version: string;
  softwareVersion: string;
  configurations: string[];
  status: EvidenceStatus;
  reviewSnapshotId: string | null;
  note: string;
}

/** 提交包内冻结的法规覆盖视图（归档时按当时快照计算） */
export interface PackageRegulation {
  id: string;
  code: string;
  title: string;
  category: RegulationItem['category'];
  required: boolean;
  status: RegulationItem['status'];
  coverage: number;
  issues: string[];
}

/** 冻结的历史提交包：一经归档不可修改，基线更新不影响其内容 */
export interface SubmissionPackage {
  id: string;
  projectId: string;
  label: string;
  submittedAt: string;
  trigger: 'submit' | 'resubmit' | 'approve';
  snapshot: BaselineSnapshot;
  status: ProjectStatus;
  progress: number;
  evidence: PackageEvidence[];
  regulations: PackageRegulation[];
  blockingIssues: string[];
  note: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
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
  /** 法规目录定义；展示时按当前快照与证据实时派生覆盖结论 */
  regulations: RegulationCatalogItem[];
  evidence: EvidenceItem[];
  versions: ProjectVersion[];
  /** 当前基线快照 id（versions[0].snapshot.id 的冗余，便于持久化迁移与读取） */
  currentSnapshotId: string;
  packages: SubmissionPackage[];
  audit: AuditEntry[];
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
  risk: 'all' | 'expiring' | 'missing' | 'version_conflict' | 'pending_confirmation';
}
