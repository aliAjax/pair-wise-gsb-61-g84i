import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import {
  clearDraft,
  loadDrafts,
  loadProjects,
  saveDraft,
  saveProjects
} from '~/services/storage';
import {
  computeBlockingIssues,
  currentSnapshot,
  isEvidenceImpacted,
  recomputeRegulations,
  computeProgress
} from '~/services/snapshot';
import type {
  ApprovalProject,
  AuditEntry,
  BaselineSnapshot,
  EvidenceItem,
  ProjectInput,
  ProjectStatus,
  ProjectVersion,
  SubmissionPackageRecord
} from '~/types/certification';

function cloneSeed() {
  return structuredClone(seedProjects);
}

// Pinia state 是响应式 Proxy，structuredClone 无法序列化；领域数据均为 JSON 结构
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function audit(actor: string, action: string, detail: string): AuditEntry {
  return {
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: new Date().toISOString()
  };
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: cloneSeed() as ApprovalProject[],
    hydrated: false
  }),

  getters: {
    projectById: (state) => (id: string) => state.projects.find((project) => project.id === id),
    agencies: (state) => Array.from(new Set(state.projects.map((project) => project.agency))).sort(),
    expiringEvidence: (state) =>
      state.projects.flatMap((project) =>
        project.evidence
          .filter((item) => item.expiryDate)
          .map((item) => ({ project, evidence: item }))
          .filter(({ evidence }) => new Date(evidence.expiryDate!) <= new Date('2027-01-31'))
      ),
    /** 基线更新后失效待确认的证据（跨项目） */
    staleEvidence: (state) =>
      state.projects.flatMap((project) =>
        project.evidence
          .filter((item) => item.status === 'stale')
          .map((item) => ({ project, evidence: item }))
      )
  },

  actions: {
    hydrate() {
      if (this.hydrated) return;
      this.projects = loadProjects();
      this.hydrated = true;
    },

    /**
     * 原子变更入口：先在项目深拷贝上完成“项目字段 + 证据失效 + 版本 + 审计 +
     * 派生重算”的全部修改，再整包落盘。落盘失败则直接丢弃草稿拷贝、
     * 保留 this.projects 原状，调用方负责保存变更草稿供重试。
     */
    commitProject(projectId: string, mutate: (draft: ApprovalProject) => void): MutationResult {
      const index = this.projects.findIndex((item) => item.id === projectId);
      if (index === -1) return { ok: false, error: '项目不存在' };

      const candidate = deepClone(this.projects[index]);
      mutate(candidate);
      candidate.updatedAt = new Date().toISOString();
      candidate.regulations = recomputeRegulations(candidate);
      candidate.progress = computeProgress(candidate);

      try {
        const all = deepClone(this.projects);
        all[index] = candidate;
        saveProjects(all);
      } catch (error) {
        // 落盘失败：候选草稿被丢弃，已提交态完全不变，不会出现各改一半
        return { ok: false, error: error instanceof Error ? error.message : '保存失败，请重试' };
      }
      this.projects[index] = candidate;
      return { ok: true };
    },

    createProject(input: ProjectInput): string | null {
      const createdAt = new Date().toISOString();
      const baseline: BaselineSnapshot = {
        maintenanceVersion: input.maintenanceVersion,
        softwareVersion: input.softwareVersion,
        configuration: input.configuration
      };
      const initialVersion: ProjectVersion = {
        id: makeId('VER'),
        ...baseline,
        label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
        author: input.applicant,
        createdAt,
        summary: '创建认证证据包草稿。',
        changes: ['录入车型、配置和维护版本', '建立基础法规项'],
        impactedConfigurations: [input.configuration]
      };
      const project: ApprovalProject = {
        id: `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`,
        ...input,
        status: 'draft',
        progress: 18,
        reviewer: '待分派',
        updatedAt: createdAt,
        regulations: [
          {
            id: 'REG-BRAKE',
            code: 'GB 21670',
            title: '乘用车制动系统技术要求',
            category: '安全',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['当前快照下尚未关联证据文件']
          },
          {
            id: 'REG-EMC',
            code: 'GB 34660',
            title: '道路车辆电磁兼容性要求',
            category: '环保',
            required: true,
            status: 'missing',
            coverage: 0,
            issues: ['当前快照下尚未关联证据文件']
          }
        ],
        evidence: [],
        versions: [initialVersion],
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。')],
        baselineVersionId: initialVersion.id,
        submissionPackages: []
      };
      try {
        const all = [project, ...deepClone(this.projects)];
        saveProjects(all);
        this.projects.unshift(project);
        return project.id;
      } catch {
        return null;
      }
    },

    /**
     * 更新项目基线。若维护版本 / 软件版本 / 配置发生变化：
     * - 生成新版本快照；
     * - 受影响的已接受证据失效（stale），回到待确认；
     * - 未受影响的已接受证据保留旧结论，继续有效；
     * - 法规覆盖、阻断项、完整度按当前快照重算。
     * 保存失败时把表单变更写入草稿存储，允许重试；已提交态不变。
     */
    updateProject(id: string, input: ProjectInput, reason: string): MutationResult {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };

      const previous = currentSnapshot(project);
      const next: BaselineSnapshot = {
        maintenanceVersion: input.maintenanceVersion,
        softwareVersion: input.softwareVersion,
        configuration: input.configuration
      };
      const changedFields: string[] = [];
      if (previous.maintenanceVersion !== next.maintenanceVersion) changedFields.push('维护版本');
      if (previous.softwareVersion !== next.softwareVersion) changedFields.push('软件版本');
      if (previous.configuration !== next.configuration) changedFields.push('配置范围');

      const result = this.commitProject(id, (draft) => {
        Object.assign(draft, {
          name: input.name,
          modelCode: input.modelCode,
          vehicleType: input.vehicleType,
          configuration: input.configuration,
          maintenanceVersion: input.maintenanceVersion,
          softwareVersion: input.softwareVersion,
          applicant: input.applicant,
          agency: input.agency,
          certificateExpiry: input.certificateExpiry
        });

        if (changedFields.length) {
          const version: ProjectVersion = {
            id: makeId('VER'),
            ...next,
            label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
            author: draft.applicant,
            createdAt: new Date().toISOString(),
            summary: `更新${changedFields.join('、')}：${reason}`,
            changes: changedFields,
            impactedConfigurations:
              previous.configuration !== next.configuration
                ? [previous.configuration, next.configuration]
                : [next.configuration]
          };
          draft.versions.unshift(version);
          draft.baselineVersionId = version.id;

          const impactedNames: string[] = [];
          for (const evidence of draft.evidence) {
            if (isEvidenceImpacted(evidence, previous, next)) {
              evidence.status = 'stale';
              evidence.note = `项目基线由 ${previous.softwareVersion}/${previous.configuration} 更新为 ${next.softwareVersion}/${next.configuration}，旧接受结论失效，回到待确认。`;
              evidence.updatedAt = new Date().toISOString();
              impactedNames.push(evidence.name);
            }
          }

          draft.audit.unshift(
            audit(
              draft.applicant,
              '更新项目版本',
              `${changedFields.join('、')}；影响配置：${version.impactedConfigurations.join('、')}` +
                (impactedNames.length ? `；${impactedNames.length} 项证据回到待确认：${impactedNames.join('、')}` : '；无已接受证据受影响')
            )
          );
        } else {
          draft.audit.unshift(audit(draft.applicant, '更新项目资料', reason));
        }
      });

      if (!result.ok) {
        // 保存失败：保留变更草稿（内存表单由页面持有，同时落盘以便下次打开恢复）
        saveDraft(id, { input: { ...input }, reason, savedAt: new Date().toISOString() });
      } else {
        clearDraft(id);
      }
      return result;
    },

    /** 读取该项目尚未保存成功的基线变更草稿 */
    getDraft(id: string) {
      return loadDrafts()[id] ?? null;
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string): MutationResult {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };
      if (status === 'approved') {
        const issues = computeBlockingIssues(project, recomputeRegulations(project));
        if (issues.length) {
          return { ok: false, error: `存在阻断项，不能批准：${issues.join('；')}` };
        }
      }
      return this.commitProject(id, (draft) => {
        draft.status = status;
        if (status === 'submitted') {
          draft.submittedAt = new Date().toISOString().slice(0, 10);
          this.freezeSubmissionPackage(draft, actor, 'submitted', reason);
        }
        if (status === 'approved') {
          this.freezeSubmissionPackage(draft, actor, 'approved', reason);
        }
        if (status === 'supplement_required') draft.progress = Math.min(draft.progress, 82);
        draft.audit.unshift(audit(actor, '审批状态流转', `${status}；${reason}`));
      });
    },

    /**
     * 冻结当前快照的提交包：证据、法规覆盖、阻断项均按此刻快照复制，
     * 之后基线再变化也不会改动历史提交包。
     */
    freezeSubmissionPackage(
      draft: ApprovalProject,
      actor: string,
      triggeredBy: ProjectStatus,
      reason: string
    ) {
      const regulations = recomputeRegulations(draft);
      const record: SubmissionPackageRecord = {
        id: makeId('PKG'),
        packageNo: draft.submissionPackages.length + 1,
        projectId: draft.id,
        createdAt: new Date().toISOString(),
        actor,
        triggeredBy,
        reason,
        baseline: currentSnapshot(draft),
        versionId: draft.baselineVersionId ?? draft.versions[0]?.id ?? '',
        evidence: draft.evidence.map((item) => ({
          id: item.id,
          regulationId: item.regulationId,
          name: item.name,
          version: item.version,
          softwareVersion: item.softwareVersion,
          configurations: [...item.configurations],
          status: item.status,
          note: item.note
        })),
        regulations: regulations.map((item) => ({
          id: item.id,
          code: item.code,
          title: item.title,
          category: item.category,
          required: item.required,
          status: item.status,
          coverage: item.coverage,
          issues: [...item.issues]
        })),
        blockingIssues: computeBlockingIssues(draft, regulations)
      };
      draft.submissionPackages.unshift(record);
      draft.audit.unshift(
        audit(actor, triggeredBy === 'approved' ? '冻结批准提交包' : '冻结提交包', `提交包 #${record.packageNo} 已按当前快照冻结，历史包保留原样。`)
      );
    },

    /**
     * 更新证据审阅结论。
     * 接受（重新确认）时强制：配置覆盖当前配置 + 软件版本与基线相同，否则拒绝接受。
     * 接受结论绑定当前快照；基线再更新时据此判定失效。
     */
    updateEvidence(
      projectId: string,
      evidenceId: string,
      status: EvidenceItem['status'],
      note: string
    ): MutationResult {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return { ok: false, error: '证据不存在' };

      if (status === 'accepted') {
        const errors: string[] = [];
        if (!evidence.configurations.includes(project.configuration)) {
          errors.push(`配置范围未覆盖当前配置「${project.configuration}」`);
        }
        if (evidence.softwareVersion !== project.softwareVersion) {
          errors.push(`软件版本 ${evidence.softwareVersion} 与项目基线 ${project.softwareVersion} 不一致`);
        }
        if (errors.length) {
          return { ok: false, error: `不能接受：${errors.join('；')}` };
        }
      }

      return this.commitProject(projectId, (draft) => {
        const target = draft.evidence.find((item) => item.id === evidenceId)!;
        target.status = status;
        if (note.trim()) target.note = note.trim();
        target.updatedAt = new Date().toISOString();
        if (status === 'accepted') {
          target.acceptedSnapshot = {
            ...currentSnapshot(draft),
            versionId: draft.baselineVersionId ?? draft.versions[0]?.id ?? '',
            acceptedAt: target.updatedAt
          };
        } else if (status === 'rejected' || status === 'resubmit') {
          target.acceptedSnapshot = undefined;
        }
        draft.audit.unshift(
          audit(
            draft.reviewer,
            status === 'accepted' ? '接受证据（绑定快照）' : '更新证据状态',
            `${target.name}：${status}${status === 'accepted' ? `；快照 ${draft.maintenanceVersion} / ${draft.softwareVersion} / ${draft.configuration}` : ''}`
          )
        );
      });
    },

    /**
     * 批量补件：把退回 / 待重交 / 失效证据更新到当前软件基线并重新提交。
     * 证据配置范围不变；是否覆盖当前配置在重新确认（接受）时强制校验。
     */
    bulkSupplement(projectId: string, evidenceIds: string[], note: string): number {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return 0;
      let count = 0;
      const result = this.commitProject(projectId, (draft) => {
        for (const evidence of draft.evidence) {
          if (!evidenceIds.includes(evidence.id)) continue;
          evidence.status = 'submitted';
          evidence.softwareVersion = draft.softwareVersion;
          evidence.acceptedSnapshot = undefined;
          evidence.note = note;
          evidence.updatedAt = new Date().toISOString();
          count += 1;
        }
        if (count) {
          draft.audit.unshift(
            audit(draft.applicant, '批量补件', `${count} 项证据更新至 ${draft.softwareVersion} 并重新提交。${note}`)
          );
        }
      });
      return result.ok ? count : 0;
    },

    reset() {
      this.projects = cloneSeed();
      try {
        saveProjects(this.projects);
      } catch {
        /* reset 仅本地演示用途 */
      }
    }
  }
});
