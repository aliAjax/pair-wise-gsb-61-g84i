import type { ApprovalProject, ProjectInput } from '~/types/certification';
import { seedProjects } from '~/data/seed';
import { currentSnapshot, recomputeRegulations, computeProgress } from './snapshot';

const STORAGE_KEY = 'vehicle-type-approval-projects-v2';
const LEGACY_KEY = 'vehicle-type-approval-projects-v1';
const DRAFT_KEY = 'vehicle-type-approval-project-drafts-v1';

export interface ProjectDraft {
  input: ProjectInput;
  reason: string;
  savedAt: string;
}

/**
 * 故障注入：置为 true 后，后续整包写入一律抛错，
 * 用于验证“保存失败保留草稿 + 不出现项目和证据各改一半”。
 */
let failureSimulation = false;

export function setFailureSimulation(value: boolean) {
  failureSimulation = value;
}

export function getFailureSimulation() {
  return failureSimulation;
}

function cloneSeed() {
  return structuredClone(seedProjects);
}

/**
 * 迁移旧版本（v1）数据：
 * - 已接受证据若没有快照绑定，视为在当前基线下接受（种子/既有数据兼容）；
 * - 版本记录补齐快照字段；
 * - 补齐提交包与基线版本 ID 字段。
 */
function migrate(projects: ApprovalProject[]): ApprovalProject[] {
  for (const project of projects) {
    if (!project.submissionPackages) project.submissionPackages = [];
    if (!project.baselineVersionId) project.baselineVersionId = project.versions[0]?.id;

    for (const version of project.versions) {
      if (!version.maintenanceVersion || !version.softwareVersion || !version.configuration) {
        const snapshot = currentSnapshot(project);
        version.maintenanceVersion ??= snapshot.maintenanceVersion;
        version.softwareVersion ??= snapshot.softwareVersion;
        version.configuration ??= snapshot.configuration;
      }
    }

    for (const evidence of project.evidence) {
      if (evidence.status === 'accepted' && !evidence.acceptedSnapshot) {
        const snapshot = currentSnapshot(project);
        evidence.acceptedSnapshot = {
          ...snapshot,
          versionId: project.baselineVersionId ?? project.versions[0]?.id ?? '',
          acceptedAt: evidence.updatedAt
        };
      }
    }
  }
  return projects;
}

function parse(raw: string): ApprovalProject[] {
  const parsed = JSON.parse(raw) as ApprovalProject[];
  return migrate(Array.isArray(parsed) ? parsed : []);
}

/** 读取项目整包；SSR/无存储时返回种子克隆 */
export function loadProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') return cloneSeed();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parse(raw);
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = parse(legacy);
      saveProjects(migrated);
      return migrated;
    }
  } catch {
    /* 损坏数据回退种子 */
  }
  return cloneSeed();
}

/**
 * 整包原子写入：要么整个 projects 文档落盘成功，要么抛错且调用方内存态保持不变。
 * 绝不允许出现项目字段已改、证据/法规未改的半包状态。
 */
export function saveProjects(projects: ApprovalProject[]): void {
  if (typeof localStorage === 'undefined') return;
  if (failureSimulation) {
    throw new DOMException('模拟的持久化失败：存储空间不可用', 'QuotaExceededError');
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

/** 读入后按当前快照刷新派生字段（法规覆盖、完整度），不改历史提交包 */
export function refreshDerived(projects: ApprovalProject[]): ApprovalProject[] {
  for (const project of projects) {
    project.regulations = recomputeRegulations(project);
    project.progress = computeProgress(project);
  }
  return projects;
}

export function loadDrafts(): Record<string, ProjectDraft> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProjectDraft>) : {};
  } catch {
    return {};
  }
}

export function saveDraft(projectId: string, draft: ProjectDraft): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const drafts = loadDrafts();
    drafts[projectId] = draft;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    /* 草稿写入失败不影响内存中的表单草稿与已提交态一致性 */
  }
}

export function clearDraft(projectId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const drafts = loadDrafts();
    delete drafts[projectId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    /* ignore */
  }
}
