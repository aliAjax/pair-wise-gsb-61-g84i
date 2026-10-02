<script setup lang="ts">
import { useCertificationStore } from '~/stores/certification';

const store = useCertificationStore();
const selectedProject = ref('all');
const projectOptions = computed(() => [
  { label: '全部项目', value: 'all' },
  ...store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id }))
]);

const scopedProjects = computed(() =>
  store.projects.filter((project) => selectedProject.value === 'all' || project.id === selectedProject.value)
);

const entries = computed(() =>
  scopedProjects.value
    .flatMap((project) =>
      project.audit.map((entry) => ({
        ...entry,
        projectId: project.id,
        projectName: project.name
      }))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
);

// 历史提交包：冻结内容，不因当前基线变化而改变
const packages = computed(() =>
  scopedProjects.value
    .flatMap((project) =>
      project.submissionPackages.map((pkg) => ({ pkg, projectId: project.id, projectName: project.name }))
    )
    .sort((a, b) => b.pkg.createdAt.localeCompare(a.pkg.createdAt))
);

function exportAudit() {
  const payload = {
    generatedAt: new Date().toISOString(),
    scope: selectedProject.value,
    note: '历史提交包为冻结快照，保留提交当时原样；当前快照字段按最新基线重算。',
    projects: scopedProjects.value.map((project) => ({
      id: project.id,
      status: project.status,
      currentBaseline: {
        maintenanceVersion: project.maintenanceVersion,
        softwareVersion: project.softwareVersion,
        configuration: project.configuration
      },
      versions: project.versions,
      evidence: project.evidence,
      submissionPackages: project.submissionPackages,
      audit: project.audit
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vehicle-type-approval-audit-package.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">审计与提交包</h1>
      <p class="mt-1 text-sm text-slate-600">历史提交包按当时快照冻结保留；项目变更、证据审阅和状态流转轨迹完整可溯。</p>
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
      <h2 class="font-semibold">历史提交包（冻结）</h2>
      <p class="mt-1 text-xs text-slate-500">共 {{ packages.length }} 份，基线更新后当前结论重算，历史包保留原样。</p>
    </div>
    <div class="divide-y divide-slate-200">
      <article v-for="{ pkg, projectId, projectName } in packages" :key="pkg.id" class="p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{{ projectId }} · {{ projectName }} — 提交包 #{{ pkg.packageNo }}</p>
          <StatusBadge :status="pkg.triggeredBy" />
        </div>
        <p class="mt-1 text-xs text-slate-500">
          {{ pkg.createdAt.slice(0, 16).replace('T', ' ') }} · {{ pkg.actor }}
        </p>
        <p class="mt-2 text-sm text-slate-600">{{ pkg.reason }}</p>
        <p class="mt-2 text-xs text-slate-500">
          冻结基线 {{ pkg.baseline.maintenanceVersion }} / SW {{ pkg.baseline.softwareVersion }} / {{ pkg.baseline.configuration }}
          · {{ pkg.evidence.length }} 项证据
          · {{ pkg.regulations.filter((r) => r.status === 'complete').length }}/{{ pkg.regulations.length }} 项法规完整
        </p>
      </article>
      <p v-if="!packages.length" class="p-6 text-center text-sm text-slate-500">当前范围尚无冻结提交包。</p>
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
