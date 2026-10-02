<script setup lang="ts">
import type { ApprovalProject, EvidenceItem, EvidenceStatus } from '~/types/certification';
import { currentSnapshot, evidenceCoversConfiguration } from '~/services/snapshots';

const props = defineProps<{
  evidence: EvidenceItem[];
  project?: ApprovalProject;
  editable?: boolean;
}>();

const emit = defineEmits<{
  update: [evidenceId: string, status: EvidenceStatus];
}>();

const typeLabels: Record<EvidenceItem['type'], string> = {
  test_report: '测试报告',
  part_list: '部件清单',
  software_report: '软件报告',
  exemption: '豁免材料',
  certificate: '证书'
};

const snapshot = computed(() => (props.project ? currentSnapshot(props.project) : null));

function softwareMismatch(item: EvidenceItem) {
  return Boolean(snapshot.value && item.softwareVersion !== snapshot.value.softwareVersion);
}

function configurationMismatch(item: EvidenceItem) {
  return Boolean(snapshot.value && !evidenceCoversConfiguration(item, snapshot.value.configuration));
}

function bindingState(item: EvidenceItem) {
  if (!snapshot.value || !item.reviewSnapshotId) return null;
  if (item.reviewSnapshotId === snapshot.value.id) return 'current';
  return 'stale';
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[1120px]">
      <thead>
        <tr>
          <th>证据文件</th>
          <th>法规项</th>
          <th>文件 / 软件版本</th>
          <th>配置覆盖</th>
          <th>结论快照</th>
          <th>状态</th>
          <th>审阅说明</th>
          <th v-if="editable">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in evidence" :key="item.id">
          <td>
            <p class="font-medium">{{ item.name }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ typeLabels[item.type] }} · {{ item.id }}</p>
          </td>
          <td class="font-mono text-sm">{{ item.regulationId }}</td>
          <td>
            <p>文件 {{ item.version }}</p>
            <p class="mt-1 text-xs" :class="softwareMismatch(item) ? 'font-medium text-red-700' : 'text-slate-500'">
              软件 {{ item.softwareVersion }}
              <span v-if="softwareMismatch(item)">（基线 {{ snapshot?.softwareVersion }}）</span>
            </p>
          </td>
          <td class="max-w-[240px] text-sm">
            <span :class="configurationMismatch(item) ? 'font-medium text-red-700' : ''">
              {{ item.configurations.join('、') }}
            </span>
            <p v-if="configurationMismatch(item)" class="mt-1 text-xs text-red-700">
              未覆盖当前配置 {{ snapshot?.configuration }}
            </p>
          </td>
          <td class="text-xs">
            <UBadge v-if="bindingState(item) === 'current'" color="green" variant="soft">当前快照有效</UBadge>
            <UBadge v-else-if="bindingState(item) === 'stale'" color="gray" variant="soft">旧快照结论</UBadge>
            <span v-else class="text-slate-400">—</span>
          </td>
          <td>
            <StatusBadge :status="item.status" />
            <p v-if="item.status === 'pending_confirmation' && item.invalidatedReason" class="mt-1 max-w-[220px] text-xs text-purple-800">
              {{ item.invalidatedReason }}
            </p>
          </td>
          <td class="max-w-[300px] text-sm text-slate-600">{{ item.note }}</td>
          <td v-if="editable">
            <div class="flex min-w-[200px] flex-wrap gap-2">
              <UButton
                size="xs"
                color="green"
                variant="soft"
                :disabled="Boolean(softwareMismatch(item) || configurationMismatch(item))"
                @click="emit('update', item.id, 'accepted')"
              >
                {{ item.status === 'pending_confirmation' ? '按当前快照确认' : '接受' }}
              </UButton>
              <UButton size="xs" color="red" variant="soft" @click="emit('update', item.id, 'rejected')">拒绝</UButton>
              <UButton size="xs" color="amber" variant="soft" @click="emit('update', item.id, 'resubmit')">重新抽样</UButton>
            </div>
            <p v-if="softwareMismatch(item) || configurationMismatch(item)" class="mt-1 max-w-[200px] text-xs text-red-700">
              软件版本或配置范围不满足当前基线，不能接受
            </p>
          </td>
        </tr>
        <tr v-if="!evidence.length">
          <td :colspan="editable ? 8 : 7" class="py-12 text-center text-slate-500">当前项目尚未关联证据。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
