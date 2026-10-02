<script setup lang="ts">
import { regulationCatalog } from '~/data/seed';
import { useCertificationStore } from '~/stores/certification';
import { deriveRegulations } from '~/services/snapshots';

const store = useCertificationStore();
const selectedCategory = ref('全部');
const selectedProjectId = ref('TA-2026-118');

onMounted(() => store.hydrate());

const categories = computed(() => ['全部', ...Array.from(new Set(regulationCatalog.map((item) => item.category)))]);

const selectedProject = computed(() => store.projectById(selectedProjectId.value));

// 目录负责分类筛选，覆盖结论按所选项目的当前快照实时派生
const derivedMap = computed(() => {
  if (!selectedProject.value) return new Map<string, ReturnType<typeof deriveRegulations>[number]>();
  return new Map(deriveRegulations(selectedProject.value).map((item) => [item.id, item]));
});

const visible = computed(() =>
  (selectedCategory.value === '全部'
    ? regulationCatalog
    : regulationCatalog.filter((item) => item.category === selectedCategory.value)
  ).map((catalog) => derivedMap.value.get(catalog.id) ?? { ...catalog, status: 'missing' as const, coverage: 0, issues: ['尚未关联'] })
);

const projectOptions = computed(() => store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id })));
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">法规项目树</h1>
      <p class="mt-1 text-sm text-slate-600">按安全、环保、能耗、软件和部件分类查看证据覆盖与配置完整性，结论按当前快照重算。</p>
    </div>
    <div class="min-w-[320px]">
      <UFormGroup label="查看认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
    </div>
  </div>

  <div v-if="selectedProject" class="mb-4 text-xs text-slate-500">
    当前快照：{{ selectedProject.currentSnapshotId }} · {{ selectedProject.maintenanceVersion }} / SW {{ selectedProject.softwareVersion }} / {{ selectedProject.configuration }}
  </div>

  <div class="mb-5 flex flex-wrap gap-2">
    <UButton
      v-for="category in categories"
      :key="category"
      size="xs"
      :variant="selectedCategory === category ? 'solid' : 'soft'"
      :color="selectedCategory === category ? 'primary' : 'gray'"
      @click="selectedCategory = category"
    >
      {{ category }}
    </UButton>
  </div>

  <RegulationTree
    v-if="selectedProject"
    :regulations="visible"
    :evidence="selectedProject.evidence"
  />
  <div v-else class="border border-red-200 bg-red-50 p-6 text-red-900">未找到所选认证项目。</div>
</template>
