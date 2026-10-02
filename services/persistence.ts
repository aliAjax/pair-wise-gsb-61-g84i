import { isProxy, toRaw } from 'vue';
import { seedProjects } from '~/data/seed';
import type { ApprovalProject } from '~/types/certification';
import { migrateProjects } from '~/services/migrate';

const PROJECTS_KEY = 'vehicle-type-approval-projects-v2';
const BACKUP_KEY = 'vehicle-type-approval-projects-v2-backup';

/** 保存失败时保留的基线变更草稿（每个项目一份） */
export interface BaselineDraft {
  projectId: string;
  input: import('~/types/certification').ProjectInput;
  reason: string;
  savedAt: string;
  error: string;
}

const DRAFT_KEY = 'vehicle-type-approval-baseline-drafts-v1';

function cloneSeed() {
  return structuredClone(seedProjects);
}

/** 深拷贝，兼容 Pinia/Vue 的响应式 Proxy（structuredClone 无法直接克隆代理） */
export function deepClone<T>(value: T): T {
  const unwrapped = unwrap(value);
  try {
    return structuredClone(unwrapped);
  } catch {
    return JSON.parse(JSON.stringify(unwrapped)) as T;
  }
}

/** 递归剥离 Vue 响应式代理（structuredClone 在部分运行时会拒绝 Proxy） */
function unwrap<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const raw = isProxy(value) ? toRaw(value) : value;
  if (seen.has(raw as object)) return seen.get(raw as object) as T;
  if (Array.isArray(raw)) {
    const arr: unknown[] = [];
    seen.set(raw as object, arr);
    raw.forEach((item, index) => {
      arr[index] = unwrap(item, seen);
    });
    return arr as T;
  }
  const obj: Record<string, unknown> = {};
  seen.set(raw as object, obj);
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    obj[key] = unwrap((raw as Record<string, unknown>)[key], seen);
  }
  return obj as T;
}function parseProjects(raw: string | null): ApprovalProject[] {
  if (!raw) return cloneSeed();
  const parsed = JSON.parse(raw) as unknown;
  // v2：{ version: 2, projects: [...] }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const wrapper = parsed as { version?: number; projects?: ApprovalProject[] };
    if (wrapper.version === 2 && Array.isArray(wrapper.projects)) {
      return migrateProjects(wrapper.projects);
    }
  }
  // v1：ApprovalProject[]
  if (Array.isArray(parsed)) {
    return migrateProjects(parsed as ApprovalProject[]);
  }
  throw new Error('无法识别的本地数据结构');
}

/**
 * 读取项目数据：主存储 → 备份 → 种子。
 * 任何一层损坏都不会返回半成品结构。
 */
export function loadProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') return cloneSeed();
  for (const key of [PROJECTS_KEY, BACKUP_KEY]) {
    try {
      return parseProjects(localStorage.getItem(key));
    } catch {
      // 继续尝试下一层
    }
  }
  return cloneSeed();
}

/**
 * 原子提交：先整体序列化（失败则内存尚未变动），再用“先备份后写主”的方式落盘。
 * 写入主存储抛错时由调用方回滚内存，并把变更保留为草稿。
 */
export function commitProjects(projects: ApprovalProject[]): void {
  const serialized = JSON.stringify({ version: 2, projects });
  if (typeof localStorage === 'undefined') return;
  let previousRaw: string | null = null;
  try {
    previousRaw = localStorage.getItem(PROJECTS_KEY);
    if (previousRaw) localStorage.setItem(BACKUP_KEY, previousRaw);
    localStorage.setItem(PROJECTS_KEY, serialized);
    try {
      localStorage.removeItem(BACKUP_KEY);
    } catch {
      // 备份残留不影响一致性，下次写入会覆盖
    }
  } catch (error) {
    throw new Error(`本地保存失败：${error instanceof Error ? error.message : '存储不可用'}`);
  }
}

export function loadDrafts(): BaselineDraft[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as BaselineDraft[]) : [];
  } catch {
    return [];
  }
}

function saveDrafts(drafts: BaselineDraft[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    // 草稿写不进去时不阻断回滚提示（通常配额已满，主数据本身也未被破坏）
  }
}

export function saveDraft(draft: BaselineDraft) {
  const drafts = loadDrafts().filter((item) => item.projectId !== draft.projectId);
  drafts.unshift(draft);
  saveDrafts(drafts);
}

export function removeDraft(projectId: string) {
  saveDrafts(loadDrafts().filter((item) => item.projectId !== projectId));
}

export function getDraft(projectId: string): BaselineDraft | undefined {
  return loadDrafts().find((item) => item.projectId === projectId);
}
