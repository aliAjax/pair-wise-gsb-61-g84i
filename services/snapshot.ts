import type {
  ApprovalProject,
  BaselineSnapshot,
  EvidenceItem,
  RegulationItem
} from '~/types/certification';

/** 项目当前基线快照，始终指向最新维护版本 / 软件版本 / 配置 */
export function currentSnapshot(project: ApprovalProject): BaselineSnapshot {
  return {
    maintenanceVersion: project.maintenanceVersion,
    softwareVersion: project.softwareVersion,
    configuration: project.configuration
  };
}

export function snapshotEqual(a: BaselineSnapshot, b: BaselineSnapshot) {
  return (
    a.maintenanceVersion === b.maintenanceVersion &&
    a.softwareVersion === b.softwareVersion &&
    a.configuration === b.configuration
  );
}

/**
 * 判断证据覆盖的配置范围是否覆盖当前申报配置。
 * 证据可以覆盖多个配置；当前配置必须落在覆盖集合内。
 */
export function coversConfiguration(evidence: EvidenceItem, configuration: string) {
  return evidence.configurations.includes(configuration);
}

/** 证据软件版本是否与项目基线一致 */
export function softwareMatchesBaseline(evidence: EvidenceItem, project: ApprovalProject) {
  return evidence.softwareVersion === project.softwareVersion;
}

/**
 * 已接受证据是否仍绑定在当前快照上。
 * 只有配置范围覆盖当前配置、软件版本与基线相同，旧基线接受结论才继续有效。
 */
export function isAcceptanceCurrent(evidence: EvidenceItem, project: ApprovalProject) {
  if (evidence.status !== 'accepted' || !evidence.acceptedSnapshot) return false;
  return (
    coversConfiguration(evidence, project.configuration) &&
    softwareMatchesBaseline(evidence, project)
  );
}

/**
 * 基线更新后判定一条已接受证据是否受影响（需要失效回到待确认）。
 * - 软件版本变化：全部已接受证据失效（软件基线变了，旧审阅结论不再代表当前结论）
 * - 维护版本变化：全部已接受证据失效
 * - 配置变化：未覆盖新配置的证据失效；覆盖集合包含新配置的证据继续有效
 */
export function isEvidenceImpacted(
  evidence: EvidenceItem,
  previous: BaselineSnapshot,
  next: BaselineSnapshot
) {
  if (evidence.status !== 'accepted' || !evidence.acceptedSnapshot) return false;

  const softwareChanged = previous.softwareVersion !== next.softwareVersion;
  const maintenanceChanged = previous.maintenanceVersion !== next.maintenanceVersion;
  if (softwareChanged || maintenanceChanged) return true;

  if (previous.configuration !== next.configuration) {
    return !coversConfiguration(evidence, next.configuration);
  }
  return false;
}

export interface RegulationCoverage {
  status: RegulationItem['status'];
  coverage: number;
  issues: string[];
}

/**
 * 按当前快照重算单个法规项的覆盖结论：
 * - 关联证据中存在已接受且仍绑定当前快照（配置覆盖 + 软件版本一致）才算覆盖；
 * - 存在证据软件版本与基线不一致 → conflict；
 * - 存在已接受但配置未覆盖当前配置 → conflict；
 * - 存在已接受但因基线更新失效（stale）→ missing；
 * - 其余缺口 → missing。
 */
export function computeRegulationCoverage(
  regulation: RegulationItem,
  evidence: EvidenceItem[],
  project: ApprovalProject
): RegulationCoverage {
  const linked = evidence.filter((item) => item.regulationId === regulation.id);
  const issues: string[] = [];

  const acceptedCurrent = linked.filter((item) => isAcceptanceCurrent(item, project));
  const staleAccepted = linked.filter(
    (item) => item.status === 'accepted' && !isAcceptanceCurrent(item, project)
  );
  const staleMarked = linked.filter((item) => item.status === 'stale');
  const versionMismatch = linked.filter((item) => !softwareMatchesBaseline(item, project));
  const configGaps = linked.filter(
    (item) =>
      item.status === 'accepted' &&
      item.acceptedSnapshot &&
      softwareMatchesBaseline(item, project) &&
      !coversConfiguration(item, project.configuration)
  );
  const openItems = linked.filter((item) =>
    ['missing', 'submitted', 'rejected', 'resubmit'].includes(item.status)
  );

  if (!linked.length) {
    return { status: 'missing', coverage: 0, issues: ['当前快照下尚未关联证据文件'] };
  }

  if (acceptedCurrent.length) {
    const coverage = acceptedCurrent.length === linked.filter((item) => item.status === 'accepted').length
      ? 100
      : Math.round((acceptedCurrent.length / linked.length) * 100);
    if (versionMismatch.length) {
      issues.push(`${versionMismatch.length} 项证据软件版本与当前基线 ${project.softwareVersion} 不一致`);
    }
    if (staleAccepted.length || staleMarked.length) {
      issues.push(`${staleAccepted.length + staleMarked.length} 项旧基线接受结论已失效，待重新确认`);
    }
    if (openItems.length) {
      issues.push(`${openItems.length} 项证据尚未在当前快照下完成审阅`);
    }
    const status: RegulationItem['status'] =
      versionMismatch.length || configGaps.length ? 'conflict' : issues.length ? 'missing' : 'complete';
    return {
      status,
      coverage: issues.length ? Math.max(coverage, 60) : 100,
      issues
    };
  }

  if (versionMismatch.length) {
    issues.push(`关联证据软件版本与当前基线 ${project.softwareVersion} 不一致`);
  }
  if (staleAccepted.length || staleMarked.length) {
    issues.push('旧基线接受的证据已随基线更新失效，需重新确认');
  }
  if (openItems.length) {
    issues.push(`${openItems.length} 项证据缺失、被拒或待补件`);
  }
  return { status: versionMismatch.length ? 'conflict' : 'missing', coverage: 0, issues };
}

/** 按当前快照重算项目全部法规项覆盖，返回新数组，不改原对象 */
export function recomputeRegulations(project: ApprovalProject): RegulationItem[] {
  return project.regulations.map((regulation) => {
    const result = computeRegulationCoverage(regulation, project.evidence, project);
    return { ...regulation, ...result };
  });
}

/** 列表/批准阻断项：按当前快照重算 */
export function computeBlockingIssues(project: ApprovalProject, regulations: RegulationItem[]) {
  const issues: string[] = [];

  const requiredRegulations = regulations.filter((item) => item.required);
  const incomplete = requiredRegulations.filter((item) => item.status !== 'complete');
  if (incomplete.length) {
    issues.push(
      `法规项 ${incomplete.map((item) => item.code).join('、')} 在当前快照下未完整覆盖`
    );
  }

  const stale = project.evidence.filter(
    (item) => item.status === 'stale' || (item.status === 'accepted' && !isAcceptanceCurrent(item, project))
  );
  if (stale.length) {
    issues.push(`${stale.length} 项证据的旧基线审阅结论已失效，回到待确认`);
  }

  const openEvidence = project.evidence.filter((item) =>
    ['missing', 'rejected', 'resubmit', 'submitted'].includes(item.status)
  );
  if (openEvidence.length) {
    issues.push(`${openEvidence.length} 项证据缺失、被拒、待补件或尚未完成审阅`);
  }

  const mismatch = project.evidence.filter((item) => !softwareMatchesBaseline(item, project));
  if (mismatch.length) {
    issues.push(`${mismatch.length} 项证据软件版本与项目基线 ${project.softwareVersion} 不一致`);
  }

  const uncoveredConfig = project.evidence.filter(
    (item) => item.status === 'accepted' && !coversConfiguration(item, project.configuration)
  );
  if (uncoveredConfig.length) {
    issues.push(`${uncoveredConfig.length} 项已接受证据未覆盖当前配置 ${project.configuration}`);
  }

  if (new Date(project.certificateExpiry) <= new Date('2026-12-31')) {
    issues.push('证书有效期不足 90 天，需先确认续证安排');
  }

  return issues;
}

/** 列表风险标签：按当前快照重算 */
export function computeRiskLabel(project: ApprovalProject, regulations: RegulationItem[]) {
  if (
    project.evidence.some(
      (item) =>
        item.status === 'stale' ||
        (item.status === 'accepted' && !isAcceptanceCurrent(item, project))
    )
  ) {
    return '基线更新待确认';
  }
  if (project.evidence.some((item) => !softwareMatchesBaseline(item, project))) return '软件版本冲突';
  if (regulations.some((item) => item.status !== 'complete')) return '法规覆盖缺失';
  if (new Date(project.certificateExpiry) <= new Date('2026-12-31')) return '证书临近到期';
  return '未见阻断项';
}

/** 证据完整度：只统计在当前快照下仍然有效的接受结论 */
export function computeProgress(project: ApprovalProject) {
  if (!project.evidence.length) return project.status === 'draft' ? 18 : 0;
  const currentAccepted = project.evidence.filter((item) => isAcceptanceCurrent(item, project)).length;
  return Math.round((currentAccepted / project.evidence.length) * 100);
}
