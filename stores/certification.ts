import { defineStore } from 'pinia';
import { seedProjects } from '~/data/seed';
import type {
  ApprovalProject,
  AuditEntry,
  BaselineSnapshot,
  EvidenceStatus,
  ProjectInput,
  ProjectStatus,
  ProjectVersion
} from '~/types/certification';
import {
  acceptanceViolations,
  baselineChanged,
  buildSubmissionPackage,
  currentSnapshot,
  deriveBlockingIssues,
  deriveProgress,
  isEvidenceAffected,
  snapshotFromProject
} from '~/services/snapshots';
import {
  commitProjects,
  deepClone,
  getDraft,
  loadDrafts,
  loadProjects,
  removeDraft,
  saveDraft,
  type BaselineDraft
} from '~/services/persistence';

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  invalidatedCount?: number;
  draftSaved?: boolean;
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function audit(actor: string, action: string, detail: string): AuditEntry {
  return { id: makeId('AUD'), actor, action, detail, createdAt: new Date().toISOString() };
}

export const useCertificationStore = defineStore('certification', {
  state: () => ({
    projects: structuredClone(seedProjects),
    hydrated: false,
    draftNotice: '' as string,
    draftList: loadDrafts() as BaselineDraft[]
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
      )
  },

  actions: {
    hydrate(projectId?: string) {
      if (!this.hydrated && typeof localStorage !== 'undefined') {
        this.projects = loadProjects();
        this.hydrated = true;
      }
      this.draftList = loadDrafts();
      if (projectId) {
        const draft = this.draftList.find((item) => item.projectId === projectId);
        if (draft) {
          this.draftNotice = `检测到未保存的基线变更草稿（${draft.savedAt.slice(0, 16).replace('T', ' ')}），已恢复到表单，可重试保存或放弃。`;
        }
      }
    },

    /**
     * 所有变更的唯一提交入口：
     * mutate 直接在内存草稿上操作；落盘失败则整体回滚到上次一致状态，
     * 保证“项目”和“证据”不会各改一半。
     */
    commit(mutate: (projects: ApprovalProject[]) => void): ActionOutcome {
      const checkpoint = deepClone(this.projects);
      try {
        mutate(this.projects);
        commitProjects(this.projects);
        return { ok: true };
      } catch (error) {
        this.projects = checkpoint;
        return { ok: false, error: error instanceof Error ? error.message : '保存失败' };
      }
    },

    createProject(input: ProjectInput): string {
      const createdAt = new Date().toISOString();
      const id = `TA-${new Date().getFullYear()}-${String(this.projects.length + 121).padStart(3, '0')}`;
      const snapshot: BaselineSnapshot = {
        id: makeId('SNAP'),
        maintenanceVersion: input.maintenanceVersion,
        softwareVersion: input.softwareVersion,
        configuration: input.configuration,
        createdAt,
        author: input.applicant,
        reason: '创建认证证据包草稿',
        changes: ['维护版本', '软件版本', '配置范围'],
        impactedConfigurations: [input.configuration]
      };
      const project: ApprovalProject = {
        id,
        ...input,
        status: 'draft',
        progress: 0,
        reviewer: '待分派',
        updatedAt: createdAt,
        regulations: seedProjects.length
          ? structuredClone(seedProjects[0].regulations)
          : [],
        evidence: [],
        versions: [
          {
            id: makeId('VER'),
            label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
            author: input.applicant,
            createdAt,
            summary: '创建认证证据包草稿。',
            changes: ['录入车型、配置和维护版本', '建立基础法规项'],
            impactedConfigurations: [input.configuration],
            snapshot
          } satisfies ProjectVersion
        ],
        currentSnapshotId: snapshot.id,
        packages: [],
        audit: [audit(input.applicant, '建立项目', '创建型式认证证据包草稿。')]
      };
      const outcome = this.commit((projects) => {
        projects.unshift(project);
      });
      if (!outcome.ok) {
        throw new Error(outcome.error);
      }
      return id;
    },

    updateProject(id: string, input: ProjectInput, reason: string): ActionOutcome {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };

      const previous = {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      };
      const changed = baselineChanged(previous, input);
      const hasBaselineChange = changed.maintenance || changed.software || changed.configuration;

      const outcome = this.commit((projects) => {
        const target = projects.find((item) => item.id === id)!;
        const now = new Date().toISOString();
        Object.assign(target, {
          name: input.name,
          modelCode: input.modelCode,
          vehicleType: input.vehicleType,
          configuration: input.configuration,
          maintenanceVersion: input.maintenanceVersion,
          softwareVersion: input.softwareVersion,
          applicant: input.applicant,
          agency: input.agency,
          certificateExpiry: input.certificateExpiry,
          updatedAt: now
        });

        if (!hasBaselineChange) {
          target.audit.unshift(audit(target.applicant, '更新项目资料', reason));
          target.progress = deriveProgress(target);
          return;
        }

        // 生成新的基线快照（不可变，旧快照保留在 versions 中）
        const changedDims: BaselineSnapshot['changes'] = [];
        if (changed.maintenance) changedDims.push('维护版本');
        if (changed.software) changedDims.push('软件版本');
        if (changed.configuration) changedDims.push('配置范围');

        const snapshot = snapshotFromProject(
          { maintenanceVersion: input.maintenanceVersion, softwareVersion: input.softwareVersion, configuration: input.configuration },
          { author: target.applicant, reason, changes: changedDims, impactedConfigurations: [input.configuration] }
        );
        const version: ProjectVersion = {
          id: makeId('VER'),
          label: `${input.maintenanceVersion} / ${input.softwareVersion}`,
          author: target.applicant,
          createdAt: snapshot.createdAt,
          summary: `更新${changedDims.join('、')}：${reason}`,
          changes: changedDims,
          impactedConfigurations: [input.configuration],
          snapshot
        };
        target.versions.unshift(version);
        target.currentSnapshotId = snapshot.id;

        // 受影响的已接受证据失效，回到待确认；未受影响的审阅结论继续有效并重绑到新快照
        let invalidated = 0;
        target.evidence.forEach((evidence) => {
          if (evidence.status !== 'accepted') return;
          const result = isEvidenceAffected(evidence, previous, snapshot, changed);
          if (!result.affected) {
            evidence.reviewSnapshotId = snapshot.id;
            evidence.updatedAt = now;
            return;
          }
          evidence.status = 'pending_confirmation';
          evidence.invalidatedReason = result.reason;
          evidence.reviewSnapshotId = null;
          evidence.updatedAt = now;
          invalidated += 1;
        });

        target.audit.unshift(
          audit(
            target.applicant,
            '更新项目版本',
            `基线快照 ${snapshot.id}：${changedDims.join('、')}变更；${invalidated} 项已接受证据受影响回到待确认，未受影响结论继续有效。`
          )
        );

        // 旧结论不再支撑当前基线：已批准/已拒绝项目回到审阅中（历史提交包保持原样）
        if (target.status === 'approved' || target.status === 'rejected') {
          const from = target.status;
          target.status = 'under_review';
          target.audit.unshift(
            audit('系统', '基线更新重开审阅', `项目原为 ${from}，基线更新后结论失效，回到审阅中；历史提交包不变。`)
          );
        }

        target.progress = deriveProgress(target);
      });

      if (!outcome.ok) {
        // 内存已回滚，保留变更草稿供重试，避免出现项目和证据各改一半
        const draft: BaselineDraft = {
          projectId: id,
          input: { ...input },
          reason,
          savedAt: new Date().toISOString(),
          error: outcome.error ?? '保存失败'
        };
        saveDraft(draft);
        this.draftList = loadDrafts();
        return { ...outcome, draftSaved: true };
      }

      removeDraft(id);
      this.draftList = loadDrafts();
      if (hasBaselineChange) {
        const fresh = this.projects.find((item) => item.id === id);
        return { ok: true, invalidatedCount: fresh?.evidence.filter((e) => e.status === 'pending_confirmation').length };
      }
      return { ok: true };
    },

    transition(id: string, status: ProjectStatus, actor: string, reason: string): ActionOutcome {
      const project = this.projects.find((item) => item.id === id);
      if (!project) return { ok: false, error: '项目不存在' };

      if (status === 'approved') {
        const issues = deriveBlockingIssues(project);
        if (issues.length) {
          return { ok: false, error: `存在阻断项，不能批准：${issues.join('；')}` };
        }
      }

      const previousStatus = project.status;
      const outcome = this.commit((projects) => {
        const target = projects.find((item) => item.id === id)!;
        const now = new Date().toISOString();
        target.status = status;
        target.updatedAt = now;
        if (status === 'submitted') target.submittedAt = now.slice(0, 10);
        if (status === 'approved') target.progress = 100;
        if (status === 'supplement_required') target.progress = Math.min(deriveProgress(target), 82);

        // 提交 / 补件重交 / 批准时，按当前快照冻结提交包；历史包不可变
        if (status === 'submitted' || status === 'approved') {
          const trigger = status === 'approved' ? 'approve' : previousStatus === 'supplement_required' ? 'resubmit' : 'submit';
          const pkg = buildSubmissionPackage(target, trigger, reason, now);
          target.packages.unshift(pkg);
          target.audit.unshift(
            audit('系统', '冻结提交包', `${pkg.id} 已按快照 ${pkg.label} 归档，历史提交包保持原样。`)
          );
        }
        target.audit.unshift(audit(actor, '审批状态流转', `${status}；${reason}`));
      });
      if (!outcome.ok) return outcome;
      return { ok: true };
    },

    updateEvidence(
      projectId: string,
      evidenceId: string,
      status: EvidenceStatus,
      note: string
    ): ActionOutcome {
      const project = this.projects.find((item) => item.id === projectId);
      const evidence = project?.evidence.find((item) => item.id === evidenceId);
      if (!project || !evidence) return { ok: false, error: '证据不存在' };

      // 重新确认（接受）时强制校验：配置覆盖当前配置且软件版本等于基线
      if (status === 'accepted') {
        const violations = acceptanceViolations(evidence, currentSnapshot(project));
        if (violations.length) {
          return { ok: false, error: `不能接受：${violations.join('；')}` };
        }
      }

      const outcome = this.commit((projects) => {
        const targetProject = projects.find((item) => item.id === projectId)!;
        const targetEvidence = targetProject.evidence.find((item) => item.id === evidenceId)!;
        const now = new Date().toISOString();
        targetEvidence.status = status;
        if (note) targetEvidence.note = note;
        targetEvidence.updatedAt = now;
        delete targetEvidence.invalidatedReason;
        if (status === 'accepted') {
          targetEvidence.reviewSnapshotId = currentSnapshot(targetProject).id;
          targetEvidence.reviewedAt = now;
        } else if (status === 'pending_confirmation') {
          targetEvidence.reviewSnapshotId = null;
        }
        targetProject.updatedAt = now;
        targetProject.progress = deriveProgress(targetProject);
        targetProject.audit.unshift(
          audit(targetProject.reviewer, '更新证据审阅', `${targetEvidence.name}：${status}（快照 ${currentSnapshot(targetProject).id}）`)
        );
      });
      return outcome;
    },

    bulkSupplement(projectId: string, evidenceIds: string[], note: string): ActionOutcome & { count?: number } {
      const project = this.projects.find((item) => item.id === projectId);
      if (!project) return { ok: false, error: '项目不存在' };

      let count = 0;
      const outcome = this.commit((projects) => {
        const target = projects.find((item) => item.id === projectId)!;
        const now = new Date().toISOString();
        const baseline = currentSnapshot(target);
        target.evidence.forEach((evidence) => {
          if (!evidenceIds.includes(evidence.id)) return;
          evidence.status = 'submitted';
          evidence.softwareVersion = baseline.softwareVersion;
          evidence.note = note;
          evidence.updatedAt = now;
          // 补件后需审阅人按当前快照重新确认，不能自动接受
          evidence.reviewSnapshotId = null;
          count += 1;
        });
        if (count) {
          target.progress = deriveProgress(target);
          target.updatedAt = now;
          target.audit.unshift(
            audit(target.applicant, '批量补件', `${count} 项证据同步到软件基线 ${baseline.softwareVersion}，等待按当前快照重新确认。${note}`)
          );
        }
      });
      if (!outcome.ok) return { ...outcome, count: 0 };
      return { ok: true, count };
    },

    retryDraft(projectId: string): ActionOutcome {
      const draft = getDraft(projectId);
      if (!draft) return { ok: false, error: '没有待重试的草稿' };
      const result = this.updateProject(projectId, draft.input, draft.reason);
      if (result.ok) this.draftNotice = '';
      return result;
    },

    discardDraft(projectId: string) {
      removeDraft(projectId);
      this.draftList = loadDrafts();
      this.draftNotice = '';
    },

    getDraftFor(projectId: string) {
      return getDraft(projectId);
    },

    reset() {
      this.projects = structuredClone(seedProjects);
      try {
        commitProjects(this.projects);
      } catch {
        // 重置场景下忽略持久化失败
      }
      this.draftNotice = '';
      this.draftList = [];
    }
  }
});
