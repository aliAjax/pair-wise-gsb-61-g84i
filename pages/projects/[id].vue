<script setup lang="ts">
import type { EvidenceStatus, ProjectInput, ProjectStatus } from '~/types/certification';
import { validateEvidenceUpgrade, validateProjectInput, validateSubmission } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';
import { clearDraft, setFailureSimulation } from '~/services/storage';
import { recomputeRegulations } from '~/services/snapshot';

const route = useRoute();
const store = useCertificationStore();
const id = String(route.params.id);
const project = computed(() => store.projectById(id));
const activeTab = ref(0);
const message = ref('');
const error = ref('');

const editor = reactive<ProjectInput>({
  name: '',
  modelCode: '',
  vehicleType: '',
  configuration: '',
  maintenanceVersion: '',
  softwareVersion: '',
  applicant: '',
  agency: '',
  certificateExpiry: ''
});

// 失败重试时保留的草稿状态
const pendingSave = ref(false);
const simulateFailure = ref(false);
const editReason = ref('');

function syncEditor(value: NonNullable<typeof project.value>) {
  Object.assign(editor, {
    name: value.name,
    modelCode: value.modelCode,
    vehicleType: value.vehicleType,
    configuration: value.configuration,
    maintenanceVersion: value.maintenanceVersion,
    softwareVersion: value.softwareVersion,
    applicant: value.applicant,
    agency: value.agency,
    certificateExpiry: value.certificateExpiry
  });
}

watch(
  project,
  (value) => {
    if (!value) return;
    // 上次保存失败留下的草稿优先恢复，避免“项目和证据各改一半”，也不丢用户输入
    const draft = store.getDraft(id);
    if (draft) {
      Object.assign(editor, draft.input);
      editReason.value = draft.reason;
      pendingSave.value = true;
      message.value = `检测到 ${new Date(draft.savedAt).toLocaleString('zh-CN')} 保存失败的变更草稿，已恢复，请修正后重试。`;
    } else {
      syncEditor(value);
    }
  },
  { immediate: true }
);

const transitionStatus = ref<ProjectStatus>('under_review');
const transitionReason = ref('');
const supplementNote = ref('');
const selectedEvidence = ref<string[]>([]);

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与提交包', icon: 'i-heroicons-arrows-right-left' },
  { label: '审计记录', icon: 'i-heroicons-clock' }
];

const transitionOptions = computed(() => {
  const current = project.value?.status;
  if (current === 'draft') return [{ label: '提交认证机构（冻结提交包）', value: 'submitted' }];
  if (current === 'submitted') return [{ label: '开始审阅', value: 'under_review' }];
  if (current === 'under_review') {
    return [
      { label: '要求补件', value: 'supplement_required' },
      { label: '批准（冻结批准提交包）', value: 'approved' },
      { label: '拒绝', value: 'rejected' }
    ];
  }
  if (current === 'supplement_required') return [{ label: '重新提交补件（冻结提交包）', value: 'submitted' }];
  return [{ label: '重新打开审阅', value: 'under_review' }];
});

// 法规覆盖按当前快照重算
const currentRegulations = computed(() => (project.value ? recomputeRegulations(project.value) : []));
const blockingIssues = computed(() => (project.value ? validateSubmission(project.value) : []));
const staleCount = computed(
  () => project.value?.evidence.filter((item) => item.status === 'stale').length ?? 0
);

function toggleFailureSimulation() {
  setFailureSimulation(simulateFailure.value);
}

function saveEditor() {
  message.value = '';
  error.value = '';
  const errors = validateProjectInput(editor);
  if (Object.keys(errors).length) {
    error.value = Object.values(errors)[0] ?? '项目资料校验失败';
    return;
  }
  if (!editReason.value.trim()) {
    error.value = '请填写本次变更原因';
    return;
  }
  const result = store.updateProject(id, { ...editor }, editReason.value);
  if (!result.ok) {
    pendingSave.value = true;
    error.value = `保存失败，变更草稿已保留：${result.error ?? '未知错误'}。当前审阅结论未受影响，可重试。`;
    return;
  }
  pendingSave.value = false;
  editReason.value = '';
  if (project.value) syncEditor(project.value);
  message.value = '项目基线已更新，受影响证据回到待确认，法规覆盖与阻断项已按当前快照重算。';
}

// 放弃未保存成功的草稿，回到已提交（落盘）状态
function discardDraft() {
  clearDraft(id);
  pendingSave.value = false;
  if (project.value) syncEditor(project.value);
  editReason.value = '';
  message.value = '已放弃未保存的变更草稿。';
  error.value = '';
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  if (pendingSave.value) {
    error.value = '存在保存失败的基线变更草稿，请先重试成功或放弃草稿后再流转。';
    return;
  }
  if (transitionStatus.value === 'approved' && blockingIssues.value.length) {
    error.value = `存在阻断项，不能批准：${blockingIssues.value.join('；')}`;
    return;
  }
  const result = store.transition(
    id,
    transitionStatus.value,
    project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer,
    transitionReason.value
  );
  if (!result.ok) {
    error.value = `流转失败：${result.error ?? '保存失败，请重试'}`;
    return;
  }
  transitionReason.value = '';
  message.value =
    transitionStatus.value === 'submitted' || transitionStatus.value === 'approved'
      ? '审批状态已更新，提交包已按当前快照冻结。'
      : '审批状态已更新。';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  message.value = '';
  error.value = '';
  const result = store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  if (!result.ok) {
    error.value = result.error ?? '证据状态更新失败';
    return;
  }
  message.value =
    status === 'accepted'
      ? '证据已接受，审阅结论绑定到当前版本快照。'
      : '证据审阅状态已更新。';
}

function bulkSupplement() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  const errors = validateEvidenceUpgrade(project.value, selectedEvidence.value, supplementNote.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const count = store.bulkSupplement(id, selectedEvidence.value, supplementNote.value);
  if (!count) {
    error.value = '批量补件保存失败，请重试。';
    return;
  }
  selectedEvidence.value = [];
  supplementNote.value = '';
  message.value = `已将 ${count} 项证据更新至当前软件基线并重新提交，需重新确认接受。`;
}

onMounted(() => store.hydrate());
</script>

<template>
  <div v-if="!project" class="border border-red-200 bg-red-50 p-6 text-red-900">
    未找到认证项目 {{ id }}。
  </div>

  <template v-else>
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <NuxtLink to="/" class="text-sm text-teal-700 hover:underline">返回认证项目</NuxtLink>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <h1 class="text-2xl font-semibold">{{ project.id }}</h1>
          <StatusBadge :status="project.status" />
          <UBadge v-if="staleCount" color="orange" variant="soft">{{ staleCount }} 项证据待重新确认</UBadge>
        </div>
        <p class="mt-2 text-lg font-medium">{{ project.name }}</p>
        <p class="mt-1 text-sm text-slate-500">
          {{ project.modelCode }} · {{ project.vehicleType }} · {{ project.configuration }} · {{ project.maintenanceVersion }} / SW {{ project.softwareVersion }}
        </p>
      </div>
      <div class="min-w-[240px] border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-500">当前快照证据有效率</span>
          <span class="metric-value font-semibold">{{ project.progress }}%</span>
        </div>
        <UProgress class="mt-2" :value="project.progress" size="sm" />
        <p class="mt-2 text-xs text-slate-500">证书到期：{{ project.certificateExpiry }}</p>
      </div>
    </div>

    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      {{ error }}
      <template v-if="pendingSave">
        <UButton size="xs" color="red" variant="ghost" class="ml-3" @click="saveEditor">重试保存</UButton>
        <UButton size="xs" color="gray" variant="ghost" @click="discardDraft">放弃草稿</UButton>
      </template>
    </div>
    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">当前快照下的批准阻断项</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">维护版本、软件版本或配置变化会生成新快照；受影响证据失效并回到待确认。</p>
          </div>
          <label class="flex items-center gap-2 text-xs text-slate-500">
            <input v-model="simulateFailure" type="checkbox" class="mt-0.5" @change="toggleFailureSimulation" />
            模拟保存失败
          </label>
        </div>
        <form class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" @submit.prevent="saveEditor">
          <UFormGroup label="项目名称"><UInput v-model="editor.name" /></UFormGroup>
          <UFormGroup label="车型代码"><UInput v-model="editor.modelCode" /></UFormGroup>
          <UFormGroup label="配置"><UInput v-model="editor.configuration" /></UFormGroup>
          <UFormGroup label="维护版本"><UInput v-model="editor.maintenanceVersion" /></UFormGroup>
          <UFormGroup label="软件版本"><UInput v-model="editor.softwareVersion" /></UFormGroup>
          <UFormGroup label="证书有效期"><UInput v-model="editor.certificateExpiry" type="date" /></UFormGroup>
          <UFormGroup label="申请主体"><UInput v-model="editor.applicant" /></UFormGroup>
          <UFormGroup label="认证机构"><UInput v-model="editor.agency" /></UFormGroup>
          <UFormGroup label="变更原因"><UInput v-model="editReason" placeholder="说明变更和影响范围" /></UFormGroup>
          <div class="md:col-span-2 xl:col-span-3">
            <UButton type="submit" color="primary">保存并生成版本快照</UButton>
            <UButton v-if="pendingSave" type="button" color="red" variant="soft" class="ml-2" @click="saveEditor">重试保存</UButton>
            <UButton v-if="pendingSave" type="button" color="gray" variant="ghost" class="ml-2" @click="discardDraft">放弃草稿</UButton>
          </div>
        </form>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">审批流转</h2>
        <p class="mt-1 text-xs text-slate-500">批准前按当前快照检查失效证据、软件版本、配置覆盖和法规覆盖。</p>
        <form class="mt-4 space-y-4" @submit.prevent="transition">
          <UFormGroup label="目标状态">
            <USelect v-model="transitionStatus" :options="transitionOptions" />
          </UFormGroup>
          <UFormGroup label="流转依据">
            <UTextarea v-model="transitionReason" :rows="3" placeholder="记录接受、拒绝或补件依据" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">提交审批流转</UButton>
        </form>
      </div>
    </section>

    <UTabs v-model="activeTab" :items="tabs" class="mb-5" />

    <section v-if="activeTab === 0" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">证据文件审阅</h2>
        <p class="mt-1 text-xs text-slate-500">
          审阅结论绑定版本快照；重新确认时配置必须覆盖当前配置、软件版本必须与基线一致，否则不能接受。
        </p>
      </div>
      <EvidenceTable :evidence="project.evidence" :project="project" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖（当前快照重算）</h2>
        <p class="mt-1 text-sm text-slate-500">仅统计配置覆盖当前配置、软件版本与基线一致的已接受证据。</p>
      </div>
      <RegulationTree :regulations="currentRegulations" :evidence="project.evidence" :project="project" />
    </section>

    <section v-else-if="activeTab === 2" class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="space-y-6">
        <div class="border border-slate-200 bg-white">
          <div class="border-b border-slate-200 px-4 py-3">
            <h2 class="font-semibold">版本快照差异</h2>
          </div>
          <div class="divide-y divide-slate-200">
            <article v-for="version in project.versions" :key="version.id" class="p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="font-medium">{{ version.label }} · {{ version.author }}</p>
                  <p class="mt-1 text-xs text-slate-500">{{ version.createdAt.slice(0, 16).replace('T', ' ') }}</p>
                </div>
                <UBadge color="gray" variant="soft">{{ version.impactedConfigurations.join('、') }}</UBadge>
              </div>
              <p class="mt-3 text-sm">{{ version.summary }}</p>
              <ul class="mt-2 list-inside list-disc text-sm text-slate-600">
                <li v-for="change in version.changes" :key="change">{{ change }}</li>
              </ul>
            </article>
          </div>
        </div>

        <div class="border border-slate-200 bg-white">
          <div class="border-b border-slate-200 px-4 py-3">
            <h2 class="font-semibold">历史提交包（冻结，保留原样）</h2>
            <p class="mt-1 text-xs text-slate-500">每次提交/批准按当时快照冻结；基线更新不改变历史包内容。</p>
          </div>
          <div v-if="project.submissionPackages.length" class="divide-y divide-slate-200">
            <article v-for="pkg in project.submissionPackages" :key="pkg.id" class="p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="font-medium">提交包 #{{ pkg.packageNo }}</p>
                <StatusBadge :status="pkg.triggeredBy" />
              </div>
              <p class="mt-1 text-xs text-slate-500">
                {{ pkg.createdAt.slice(0, 16).replace('T', ' ') }} · {{ pkg.actor }}
              </p>
              <p class="mt-2 text-sm text-slate-600">{{ pkg.reason }}</p>
              <div class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div class="border border-slate-200 p-2">
                  <p class="text-slate-500">冻结基线</p>
                  <p class="mt-1 font-medium">{{ pkg.baseline.maintenanceVersion }} / SW {{ pkg.baseline.softwareVersion }} / {{ pkg.baseline.configuration }}</p>
                </div>
                <div class="border border-slate-200 p-2">
                  <p class="text-slate-500">证据 / 法规覆盖</p>
                  <p class="mt-1 font-medium">{{ pkg.evidence.length }} 项证据 · {{ pkg.regulations.filter((r) => r.status === 'complete').length }}/{{ pkg.regulations.length }} 项法规完整</p>
                </div>
              </div>
              <p v-if="pkg.blockingIssues.length" class="mt-2 text-xs text-amber-800">
                冻结时阻断项：{{ pkg.blockingIssues.join('；') }}
              </p>
            </article>
          </div>
          <p v-else class="p-6 text-sm text-slate-500">尚无提交包，提交或批准时按当前快照冻结。</p>
        </div>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">批量补件</h2>
        <p class="mt-1 text-xs text-slate-500">将退回、待重交或快照失效证据更新到当前软件基线并重新提交。</p>
        <form class="mt-4 space-y-4" @submit.prevent="bulkSupplement">
          <label
            v-for="item in project.evidence.filter((evidence) => ['rejected', 'resubmit', 'missing', 'stale'].includes(evidence.status))"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="flex items-center gap-2">
                <span class="block text-sm font-medium">{{ item.name }}</span>
                <StatusBadge :status="item.status" />
              </span>
              <span class="mt-1 block text-xs text-slate-500">{{ item.id }} · 当前 SW {{ item.softwareVersion }}</span>
            </span>
          </label>
          <p v-if="!project.evidence.some((evidence) => ['rejected', 'resubmit', 'missing', 'stale'].includes(evidence.status))" class="text-sm text-slate-500">
            当前没有待补件证据。
          </p>
          <UFormGroup label="补件说明">
            <UTextarea v-model="supplementNote" :rows="3" placeholder="说明已完成的测试、配置覆盖和版本更新" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">批量更新并重新提交</UButton>
        </form>
      </div>
    </section>

    <section v-else class="border border-slate-200 bg-white p-5">
      <h2 class="font-semibold">项目审计记录</h2>
      <div class="mt-5 space-y-5">
        <article v-for="entry in project.audit" :key="entry.id" class="audit-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{{ entry.action }} · {{ entry.actor }}</p>
            <span class="text-xs text-slate-500">{{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-600">{{ entry.detail }}</p>
        </article>
      </div>
    </section>
  </template>
</template>
