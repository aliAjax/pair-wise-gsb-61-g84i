<script setup lang="ts">
import type { ApprovalProject, EvidenceItem, RegulationItem } from '~/types/certification';
import { isAcceptanceCurrent } from '~/services/snapshot';

const props = defineProps<{
  regulations: RegulationItem[];
  evidence: EvidenceItem[];
  project?: ApprovalProject;
}>();

const expanded = ref<string[]>([]);

watch(
  () => props.regulations,
  (items) => {
    expanded.value = items.map((item) => item.id);
  },
  { immediate: true }
);

function toggle(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((item) => item !== id)
    : [...expanded.value, id];
}

function linkedEvidence(id: string) {
  return props.evidence.filter((item) => item.regulationId === id);
}

function evidenceCurrent(item: EvidenceItem) {
  return props.project ? isAcceptanceCurrent(item, props.project) : true;
}
</script>

<template>
  <div class="divide-y divide-slate-200 border-y border-slate-200 bg-white">
    <section v-for="regulation in regulations" :key="regulation.id">
      <button
        type="button"
        class="flex w-full items-start justify-between gap-4 px-4 py-4 text-left hover:bg-slate-50"
        @click="toggle(regulation.id)"
      >
        <span class="min-w-0">
          <span class="flex flex-wrap items-center gap-2">
            <strong class="font-mono text-sm">{{ regulation.code }}</strong>
            <UBadge color="gray" variant="soft">{{ regulation.category }}</UBadge>
            <UBadge
              :color="regulation.status === 'complete' ? 'green' : regulation.status === 'conflict' ? 'red' : 'amber'"
              variant="soft"
            >
              {{ regulation.status === 'complete' ? '完整' : regulation.status === 'conflict' ? '版本冲突' : '缺失' }}
            </UBadge>
          </span>
          <span class="mt-1 block text-sm font-medium text-slate-800">{{ regulation.title }}</span>
        </span>
        <span class="shrink-0 text-sm text-slate-500">{{ regulation.coverage }}% · {{ expanded.includes(regulation.id) ? '收起' : '展开' }}</span>
      </button>

      <div v-if="expanded.includes(regulation.id)" class="border-t border-slate-100 bg-slate-50 px-4 py-4">
        <div class="mb-3">
          <div class="mb-1 flex items-center justify-between gap-3 text-xs text-slate-500">
            <span>当前快照配置覆盖</span><span>{{ regulation.coverage }}%</span>
          </div>
          <UProgress :value="regulation.coverage" size="xs" />
        </div>

        <div v-if="regulation.issues.length" class="mb-4 space-y-1">
          <p v-for="issue in regulation.issues" :key="issue" class="border-l-2 border-amber-500 pl-3 text-sm text-amber-900">
            {{ issue }}
          </p>
        </div>

        <div v-if="linkedEvidence(regulation.id).length" class="space-y-2">
          <div
            v-for="item in linkedEvidence(regulation.id)"
            :key="item.id"
            class="flex flex-wrap items-center justify-between gap-3 border bg-white px-3 py-3"
            :class="evidenceCurrent(item) ? 'border-slate-200' : 'border-orange-300'"
          >
            <div>
              <p class="text-sm font-medium">{{ item.name }}</p>
              <p class="mt-1 text-xs text-slate-500">
                文件版本 {{ item.version }} · 软件 {{ item.softwareVersion }} · {{ item.configurations.join('、') }}
              </p>
              <p v-if="!evidenceCurrent(item)" class="mt-1 text-xs font-medium text-orange-700">
                审阅结论绑定旧快照，当前快照下不计入覆盖
              </p>
            </div>
            <StatusBadge :status="item.status" />
          </div>
        </div>
        <p v-else class="text-sm text-slate-500">当前快照下尚未关联证据文件。</p>
      </div>
    </section>
  </div>
</template>
