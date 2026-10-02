<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';
import { deriveBlockingIssues, deriveProgress, deriveRegulations } from '~/services/snapshots';

const store = useCertificationStore();
const selectedProject = ref('all');
onMounted(() => store.hydrate());

const projectOptions = computed(() => [
  { label: '全部项目', value: 'all' },
  ...store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
]);

const selectedProjects = computed(() =>
  store.projects.filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value)
);

const entries = computed(() =>
  selectedProjects.value
    .flatMap((project) =>
      project.audit.map((entry) => ({
        ...entry,
        projectId: project.id,
        projectName: project.name
      }))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

const packageCount = computed(() => selectedProjects.value.reduce((sum, project) => sum + project.packages.length, 0));

function exportAudit() {
  // 当前视图按当前快照重算；历史提交包原样带出，不做重算
  const payload = {
    generatedAt: new Date().toISOString(),
    scope: selectedProject.value,
    currentView: selectedProjects.value.map((project) => ({
      id: project.id,
      status: project.status,
      currentSnapshotId: project.currentSnapshotId,
      maintenanceVersion: project.maintenanceVersion,
      softwareVersion: project.softwareVersion,
      configuration: project.configuration,
      progress: deriveProgress(project),
      regulations: deriveRegulations(project),
      blockingIssues: deriveBlockingIssues(project),
      evidence: project.evidence,
      versions: project.versions
    })),
    // 历史提交包：冻结时的快照与覆盖结论，保持原样
    submissionPackages: selectedProjects.value.flatMap((project) => project.packages),
    audit: selectedProjects.value.flatMap((project) => project.audit)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vehicle-type-approval-audit-package.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">审计与提交包</h1>
      <p class="mt-1 text-sm text-slate-600">当前结论按最新快照重算；历史提交包冻结归档、保留原样，轨迹完整可追溯。</p>
    </div>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-[300px]">
        <UFormGroup label="审计范围">
          <USelect v-model="selectedProject" :options="projectOptions" />
        </UFormGroup>
      </div>
      <UButton color="primary" @click="exportAudit">导出提交包</UButton>
    </div>
  </div>

  <section class="mb-6 border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">冻结的历史提交包（{{ packageCount }} 份）</h2>
      <p class="mt-1 text-xs text-slate-500">提交/批准时按当时快照归档，基线更新不改变其内容。</p>
    </div>
    <div class="divide-y divide-slate-200">
      <article
        v-for="pkg in selectedProjects.flatMap((p) => p.packages)"
        :key="pkg.id"
        class="px-4 py-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium">{{ pkg.id }} · {{ pkg.label }}</p>
            <p class="mt-1 font-mono text-xs text-slate-400">冻结快照 {{ pkg.snapshot.id }}</p>
          </div>
          <div class="text-right text-xs text-slate-500">
            <p>{{ pkg.submittedAt.slice(0, 16).replace('T', ' ') }}</p>
            <p>{{ pkg.evidence.length }} 项证据 · 完整度 {{ pkg.progress }}%</p>
          </div>
        </div>
      </article>
      <p v-if="!packageCount" class="px-4 py-8 text-center text-sm text-slate-500">当前范围内暂无冻结提交包。</p>
    </div>
  </section>

  <section class="border border-slate-200 bg-white">
    <div class="border-b border-slate-200 px-4 py-3">
      <h2 class="font-semibold">审批时间线</h2>
      <p class="mt-1 text-xs text-slate-500">共 {{ entries.length }} 条记录</p>
    </div>
    <div class="space-y-5 p-5">
      <article v-for="entry in entries" :key="entry.id" class="audit-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{{ entry.action }} · {{ entry.actor }}</p>
          <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>
        <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        <p class="mt-1 text-xs text-slate-500">{{ entry.projectId }} · {{ entry.projectName }}</p>
      </article>
      <p v-if="!entries.length" class="py-10 text-center text-sm text-slate-500">没有符合条件的审计记录。</p>
    </div>
  </section>
</template>
