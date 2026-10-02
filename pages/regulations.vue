<script setup lang="ts">
import { regulationCatalog } from '~/data/seed';
import { useCertificationStore } from '~/stores/certification';
import { recomputeRegulations } from '~/services/snapshot';

const store = useCertificationStore();
const selectedCategory = ref('全部');
const selectedProjectId = ref('TA-2026-118');

const categories = computed(() => ['全部', ...Array.from(new Set(regulationCatalog.map((item) => item.category)))]);

const selectedProject = computed(() => store.projectById(selectedProjectId.value));
const projectOptions = computed(() => store.projects.map((project) => ({ label: `${project.id} · ${project.name}`, value: project.id })));

// 法规覆盖始终按所选项目的当前快照重算，而不是静态目录
const snapshotRegulations = computed(() =>
  selectedProject.value ? recomputeRegulations(selectedProject.value) : []
);
const visible = computed(() =>
  selectedCategory.value === '全部'
    ? snapshotRegulations.value
    : snapshotRegulations.value.filter((item) => item.category === selectedCategory.value)
);

onMounted(() => store.hydrate());
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">法规项目树</h1>
      <p class="mt-1 text-sm text-slate-600">覆盖、阻断均按项目当前版本快照重算；旧基线失效证据不计入覆盖。</p>
    </div>
    <div class="min-w-[320px]">
      <UFormGroup label="查看认证项目">
        <USelect v-model="selectedProjectId" :options="projectOptions" />
      </UFormGroup>
    </div>
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
    :project="selectedProject"
  />
  <div v-else class="border border-red-200 bg-red-50 p-6 text-red-900">未找到所选认证项目。</div>
</template>
