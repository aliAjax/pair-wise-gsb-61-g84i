import type {
  ApprovalProject,
  BaselineSnapshot,
  EvidenceItem,
  RegulationCatalogItem,
  RegulationItem
} from '~/types/certification';
import { regulationCatalog } from '~/data/seed';

interface LegacyProject extends Partial<ApprovalProject> {
  id: string;
}

function isV2Project(project: ApprovalProject) {
  return Boolean(project.currentSnapshotId && project.versions?.[0]?.snapshot && Array.isArray(project.packages));
}

function buildSnapshot(project: ApprovalProject, createdAt: string, reason: string): BaselineSnapshot {
  return {
    id: `SNAP-${project.id}-${createdAt.replace(/[^0-9]/g, '').slice(0, 14) || 'init'}`,
    maintenanceVersion: project.maintenanceVersion,
    softwareVersion: project.softwareVersion,
    configuration: project.configuration,
    createdAt,
    author: project.applicant,
    reason,
    changes: ['维护版本', '软件版本', '配置范围'],
    impactedConfigurations: [project.configuration]
  };
}

/** 旧的 RegulationItem[] 退化为目录定义，覆盖结论改由当前快照派生 */
function toCatalog(regulations: RegulationItem[] | RegulationCatalogItem[] | undefined): RegulationCatalogItem[] {
  if (!regulations || !regulations.length) {
    return regulationCatalog.map(({ id, code, title, category, required }) => ({ id, code, title, category, required }));
  }
  return regulations.map((item) => ({
    id: item.id,
    code: item.code,
    title: item.title,
    category: item.category,
    required: item.required
  }));
}

function migrateEvidence(evidence: EvidenceItem[] | undefined, snapshotId: string) {
  return (evidence ?? []).map((item) => ({
    ...item,
    reviewSnapshotId:
      typeof item.reviewSnapshotId === 'string'
        ? item.reviewSnapshotId
        : item.status === 'accepted'
          ? snapshotId
          : null
  }));
}

/** v1 → v2：补出快照链、提交包数组和证据的快照绑定 */
export function migrateProjects(rawProjects: ApprovalProject[]): ApprovalProject[] {
  return (rawProjects as LegacyProject[] as ApprovalProject[]).map((project) => {
    if (isV2Project(project)) return project;

    const createdAt = project.versions?.[0]?.createdAt ?? project.updatedAt ?? new Date().toISOString();
    const snapshot = buildSnapshot(project, createdAt, '历史基线快照（数据迁移生成）');

    const versions = (project.versions ?? []).map((version, index) =>
      index === 0
        ? { ...version, snapshot }
        : {
            ...version,
            snapshot: {
              ...snapshot,
              id: `SNAP-${project.id}-${index}`,
              createdAt: version.createdAt
            }
          }
    );

    return {
      ...project,
      regulations: toCatalog(project.regulations as RegulationItem[]),
      evidence: migrateEvidence(project.evidence, snapshot.id),
      versions: versions.length ? versions : [{
        id: `VER-${project.id}-init`,
        label: `${project.maintenanceVersion} / ${project.softwareVersion}`,
        author: project.applicant,
        createdAt,
        summary: '历史基线快照（数据迁移生成）。',
        changes: ['维护版本', '软件版本', '配置范围'],
        impactedConfigurations: [project.configuration],
        snapshot
      }],
      currentSnapshotId: snapshot.id,
      packages: Array.isArray(project.packages) ? project.packages : []
    };
  });
}
