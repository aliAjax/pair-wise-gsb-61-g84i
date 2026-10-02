import type {
  ApprovalProject,
  BaselineSnapshot,
  EvidenceItem,
  PackageEvidence,
  PackageRegulation,
  ProjectInput,
  RegulationCatalogItem,
  RegulationItem,
  SubmissionPackage
} from '~/types/certification';

export interface BaselineLike {
  maintenanceVersion: string;
  softwareVersion: string;
  configuration: string;
}

/** 证据配置范围是否覆盖基线配置 */
export function evidenceCoversConfiguration(evidence: { configurations: string[] }, configuration: string) {
  return evidence.configurations.includes(configuration);
}

/** 证据是否与某个基线快照匹配：软件版本相同且配置范围覆盖 */
export function evidenceMatchesBaseline(
  evidence: { softwareVersion: string; configurations: string[] },
  baseline: BaselineLike
) {
  return (
    evidence.softwareVersion === baseline.softwareVersion &&
    evidenceCoversConfiguration(evidence, baseline.configuration)
  );
}

/** 证据结论是否在指定快照下有效：已接受且绑定该快照 */
export function evidenceAcceptedAt(evidence: EvidenceItem, snapshotId: string) {
  return evidence.status === 'accepted' && evidence.reviewSnapshotId === snapshotId;
}

export function currentSnapshot(project: ApprovalProject): BaselineSnapshot {
  return project.versions[0]?.snapshot ?? snapshotFromProject(project);
}

export function snapshotFromProject(
  project: BaselineLike & { applicant?: string },
  extra?: Partial<BaselineSnapshot>
): BaselineSnapshot {
  return {
    id: extra?.id ?? `SNAP-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
    maintenanceVersion: project.maintenanceVersion,
    softwareVersion: project.softwareVersion,
    configuration: project.configuration,
    createdAt: extra?.createdAt ?? new Date().toISOString(),
    author: extra?.author ?? project.applicant ?? '',
    reason: extra?.reason ?? '',
    changes: extra?.changes ?? [],
    impactedConfigurations: extra?.impactedConfigurations ?? [project.configuration]
  };
}

function cloneSnapshot(snapshot: BaselineSnapshot): BaselineSnapshot {
  return {
    ...snapshot,
    changes: [...snapshot.changes],
    impactedConfigurations: [...snapshot.impactedConfigurations]
  };
}

export function baselineChanged(previous: BaselineLike, input: ProjectInput) {
  return {
    maintenance: previous.maintenanceVersion !== input.maintenanceVersion,
    software: previous.softwareVersion !== input.softwareVersion,
    configuration: previous.configuration !== input.configuration
  };
}

/**
 * 判断一项已接受证据是否受基线变更影响（结论失效）。
 * - 维护版本变化：所有已接受结论都需要在新基线上重新确认；
 * - 软件版本变化：证据软件版本与新基线不一致时失效；
 * - 配置变化：证据配置范围不覆盖新配置时失效。
 */
export function isEvidenceAffected(
  evidence: EvidenceItem,
  previous: BaselineLike,
  next: BaselineLike,
  changed: ReturnType<typeof baselineChanged>
): { affected: boolean; reason?: string } {
  if (changed.maintenance) {
    return {
      affected: true,
      reason: `维护版本由 ${previous.maintenanceVersion} 更新为 ${next.maintenanceVersion}，原审阅结论需按新基线重新确认`
    };
  }
  if (changed.software && evidence.softwareVersion !== next.softwareVersion) {
    return {
      affected: true,
      reason: `软件基线由 ${previous.softwareVersion} 更新为 ${next.softwareVersion}，证据软件版本 ${evidence.softwareVersion} 不再匹配`
    };
  }
  if (changed.configuration && !evidenceCoversConfiguration(evidence, next.configuration)) {
    return {
      affected: true,
      reason: `申报配置由 ${previous.configuration} 更新为 ${next.configuration}，证据配置范围未覆盖新配置`
    };
  }
  return { affected: false };
}

/**
 * 重新确认（接受）证据时的硬性条件：
 * 配置范围必须覆盖当前配置，软件版本必须与项目基线相同。
 */
export function acceptanceViolations(
  evidence: { softwareVersion: string; configurations: string[] },
  baseline: BaselineLike
): string[] {
  const violations: string[] = [];
  if (evidence.softwareVersion !== baseline.softwareVersion) {
    violations.push(`证据软件版本 ${evidence.softwareVersion} 与项目基线 ${baseline.softwareVersion} 不一致`);
  }
  if (!evidenceCoversConfiguration(evidence, baseline.configuration)) {
    violations.push(`证据配置范围（${evidence.configurations.join('、') || '空'}）未覆盖当前配置 ${baseline.configuration}`);
  }
  return violations;
}

/** 按当前快照派生单个法规项的覆盖结论 */
export function deriveRegulation(
  catalog: RegulationCatalogItem,
  evidence: EvidenceItem[],
  baseline: BaselineLike
): RegulationItem {
  const linked = evidence.filter((item) => item.regulationId === catalog.id);
  const issues: string[] = [];

  if (!linked.length) {
    return {
      ...catalog,
      status: 'missing',
      coverage: 0,
      issues: ['尚未关联证据文件']
    };
  }

  const accepted = linked.filter((item) => item.status === 'accepted' && evidenceMatchesBaseline(item, baseline));
  const pending = linked.filter((item) => item.status === 'pending_confirmation');
  const wrongVersion = linked.filter((item) => item.softwareVersion !== baseline.softwareVersion);
  const uncovered = linked.filter((item) => !evidenceCoversConfiguration(item, baseline.configuration));
  const notAccepted = linked.filter(
    (item) => ['missing', 'submitted', 'rejected', 'resubmit'].includes(item.status)
  );

  if (wrongVersion.length) {
    issues.push(`${wrongVersion.length} 项证据软件版本与当前基线 ${baseline.softwareVersion} 不一致`);
  }
  if (uncovered.length) {
    issues.push(`${uncovered.length} 项证据配置范围未覆盖当前配置 ${baseline.configuration}`);
  }
  if (pending.length) {
    issues.push(`${pending.length} 项证据的旧审阅结论已失效，等待按当前快照重新确认`);
  }
  if (notAccepted.length) {
    issues.push(`${notAccepted.length} 项证据尚未通过审阅`);
  }

  if (accepted.length) {
    return {
      ...catalog,
      status: issues.length ? 'conflict' : 'complete',
      coverage: issues.length ? 67 : 100,
      issues: issues.length ? issues : []
    };
  }

  if (pending.length || wrongVersion.length || uncovered.length || notAccepted.length) {
    return { ...catalog, status: 'conflict', coverage: 33, issues };
  }

  return { ...catalog, status: 'missing', coverage: 0, issues: issues.length ? issues : ['尚未关联有效证据'] };
}

/** 按当前快照重算全部法规覆盖 */
export function deriveRegulations(project: ApprovalProject): RegulationItem[] {
  const baseline = currentSnapshot(project);
  return project.regulations.map((catalog) => deriveRegulation(catalog, project.evidence, baseline));
}

/** 按当前快照重算批准阻断项 */
export function deriveBlockingIssues(project: ApprovalProject): string[] {
  const issues: string[] = [];
  const baseline = currentSnapshot(project);

  const pending = project.evidence.filter((item) => item.status === 'pending_confirmation');
  if (pending.length) {
    issues.push(`${pending.length} 项证据的旧基线结论已失效，必须按当前快照重新确认`);
  }

  const notAccepted = project.evidence.filter((item) =>
    ['missing', 'rejected', 'resubmit', 'submitted'].includes(item.status)
  );
  if (notAccepted.length) {
    issues.push(`${notAccepted.length} 项证据缺失、被拒、待补件或尚未完成审阅`);
  }

  const mismatched = project.evidence.filter(
    (item) => item.status === 'accepted' && !evidenceMatchesBaseline(item, baseline)
  );
  if (mismatched.length) {
    issues.push(`${mismatched.length} 项已接受证据未与当前基线快照一致（软件版本或配置范围不符）`);
  }

  const regulations = deriveRegulations(project);
  const required = regulations.filter((item) => item.required);
  const incomplete = required.filter((item) => item.status !== 'complete');
  if (incomplete.length) {
    issues.push(`法规项 ${incomplete.map((item) => item.code).join('、')} 尚未按当前快照完整覆盖`);
  }

  if (new Date(project.certificateExpiry) <= new Date('2026-12-31')) {
    issues.push('证书有效期不足 90 天，需先确认续证安排');
  }

  return issues;
}

/** 证据完整度：按当前快照下完整覆盖的必检法规比例计算 */
export function deriveProgress(project: ApprovalProject): number {
  const regulations = deriveRegulations(project);
  const required = regulations.filter((item) => item.required);
  if (!required.length) return project.evidence.length ? 50 : 0;
  const complete = required.filter((item) => item.status === 'complete').length;
  return Math.round((complete / required.length) * 100);
}

export type ProjectRisk = 'all' | 'pending_confirmation' | 'version_conflict' | 'missing' | 'expiring' | 'none';

/** 列表风险按当前快照重算 */
export function deriveProjectRisk(project: ApprovalProject): ProjectRisk {
  const baseline = currentSnapshot(project);
  if (project.evidence.some((item) => item.status === 'pending_confirmation')) return 'pending_confirmation';
  if (project.evidence.some((item) => item.softwareVersion !== baseline.softwareVersion)) return 'version_conflict';
  if (deriveRegulations(project).some((item) => item.required && item.status !== 'complete')) return 'missing';
  if (new Date(project.certificateExpiry) <= new Date('2026-12-31')) return 'expiring';
  return 'none';
}

export function riskMatches(project: ApprovalProject, risk: ProjectRisk) {
  if (risk === 'all') return true;
  return deriveProjectRisk(project) === risk;
}

export function riskLabel(project: ApprovalProject): string {
  switch (deriveProjectRisk(project)) {
    case 'pending_confirmation':
      return '证据待按新基线确认';
    case 'version_conflict':
      return '软件版本冲突';
    case 'missing':
      return '法规覆盖缺失';
    case 'expiring':
      return '证书临近到期';
    default:
      return '未见阻断项';
  }
}

function freezeEvidence(evidence: EvidenceItem[]): PackageEvidence[] {
  return evidence.map((item) => ({
    id: item.id,
    regulationId: item.regulationId,
    name: item.name,
    type: item.type,
    version: item.version,
    softwareVersion: item.softwareVersion,
    configurations: [...item.configurations],
    status: item.status,
    reviewSnapshotId: item.reviewSnapshotId,
    note: item.note
  }));
}

/** 按当前快照冻结一个不可变提交包 */
export function buildSubmissionPackage(
  project: ApprovalProject,
  trigger: SubmissionPackage['trigger'],
  note: string,
  submittedAt = new Date().toISOString()
): SubmissionPackage {
  const snapshot = currentSnapshot(project);
  const regulations = deriveRegulations(project);
  return {
    id: `PKG-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
    projectId: project.id,
    label: `${snapshot.maintenanceVersion} / SW ${snapshot.softwareVersion} / ${snapshot.configuration}`,
    submittedAt,
    trigger,
    snapshot: cloneSnapshot(snapshot),
    status: project.status,
    progress: deriveProgress(project),
    evidence: freezeEvidence(project.evidence),
    regulations: regulations.map((item): PackageRegulation => ({ ...item, issues: [...item.issues] })),
    blockingIssues: deriveBlockingIssues(project),
    note
  };
}
