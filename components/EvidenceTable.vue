<script setup lang="ts">
import type { ApprovalProject, EvidenceItem, EvidenceStatus } from '~/types/certification';
import { isAcceptanceCurrent } from '~/services/snapshot';

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

function softwareStale(item: EvidenceItem) {
  return props.project ? item.softwareVersion !== props.project.softwareVersion : false;
}

function configMissing(item: EvidenceItem) {
  return props.project ? !item.configurations.includes(props.project.configuration) : false;
}

function acceptanceValid(item: EvidenceItem) {
  return props.project ? isAcceptanceCurrent(item, props.project) : true;
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="data-table min-w-[1080px]">
      <thead>
        <tr>
          <th>证据文件</th>
          <th>法规项</th>
          <th>文件 / 软件版本</th>
          <th>配置覆盖</th>
          <th>审阅快照</th>
          <th>状态</th>
          <th>审阅说明</th>
          <th v-if="editable">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in evidence" :key="item.id" :class="item.status === 'stale' ? 'bg-orange-50/60' : ''">
          <td>
            <p class="font-medium">{{ item.name }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ typeLabels[item.type] }} · {{ item.id }}</p>
          </td>
          <td class="font-mono text-sm">{{ item.regulationId }}</td>
          <td>
            <p>文件 {{ item.version }}</p>
            <p class="mt-1 text-xs" :class="softwareStale(item) ? 'font-medium text-red-700' : 'text-slate-500'">
              软件 {{ item.softwareVersion }}
              <span v-if="softwareStale(item)" class="ml-1">（基线 {{ project?.softwareVersion }}）</span>
            </p>
          </td>
          <td class="max-w-[220px] text-sm">
            <p>{{ item.configurations.join('、') }}</p>
            <p v-if="configMissing(item)" class="mt-1 text-xs font-medium text-red-700">
              未覆盖当前配置「{{ project?.configuration }}」
            </p>
          </td>
          <td class="max-w-[200px] text-xs">
            <template v-if="item.acceptedSnapshot">
              <p class="text-slate-600">{{ item.acceptedSnapshot.maintenanceVersion }} / SW {{ item.acceptedSnapshot.softwareVersion }}</p>
              <p class="mt-1 text-slate-500">{{ item.acceptedSnapshot.configuration }}</p>
              <p
                class="mt-1 font-medium"
                :class="acceptanceValid(item) ? 'text-green-700' : 'text-orange-700'"
              >
                {{ acceptanceValid(item) ? '与当前快照一致' : '绑定旧快照·已失效' }}
              </p>
            </template>
            <span v-else class="text-slate-400">尚未接受</span>
          </td>
          <td><StatusBadge :status="item.status" /></td>
          <td class="max-w-[280px] text-sm text-slate-600">{{ item.note }}</td>
          <td v-if="editable">
            <div class="flex min-w-[180px] flex-wrap gap-2">
              <UButton size="xs" color="green" variant="soft" @click="emit('update', item.id, 'accepted')">
                {{ item.status === 'stale' ? '重新确认接受' : '接受' }}
              </UButton>
              <UButton size="xs" color="red" variant="soft" @click="emit('update', item.id, 'rejected')">拒绝</UButton>
              <UButton size="xs" color="amber" variant="soft" @click="emit('update', item.id, 'resubmit')">重新抽样</UButton>
            </div>
          </td>
        </tr>
        <tr v-if="!evidence.length">
          <td :colspan="editable ? 8 : 7" class="py-12 text-center text-slate-500">当前项目尚未关联证据。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
