<script setup lang="ts">
import type { EvidenceStatus, ProjectInput, ProjectStatus } from '~/types/certification';
import { validateEvidenceUpgrade, validateProjectInput } from '~/services/validators';
import { useCertificationStore } from '~/stores/certification';
import { currentSnapshot, deriveBlockingIssues, deriveProgress, deriveRegulations } from '~/services/snapshots';

const route = useRoute();
const store = useCertificationStore();
const id = String(route.params.id);
onMounted(() => store.hydrate(id));

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

const transitionStatus = ref<ProjectStatus>('under_review');
const transitionReason = ref('');
const editReason = ref('');
const supplementNote = ref('');
const selectedEvidence = ref<string[]>([]);

const draft = computed(() => store.draftList.find((item) => item.projectId === id));

watch(
  project,
  (value) => {
    if (!value) return;
    // 有未保存草稿时回填草稿（保留变更），否则回填当前已保存项目
    const draftValue = store.draftList.find((item) => item.projectId === id);
    const source = draftValue?.input ?? value;
    Object.assign(editor, {
      name: source.name,
      modelCode: source.modelCode,
      vehicleType: source.vehicleType,
      configuration: source.configuration,
      maintenanceVersion: source.maintenanceVersion,
      softwareVersion: source.softwareVersion,
      applicant: source.applicant,
      agency: source.agency,
      certificateExpiry: source.certificateExpiry
    });
    if (draftValue) editReason.value = draftValue.reason;
  },
  { immediate: true }
);

const tabs = [
  { label: '证据文件', icon: 'i-heroicons-document-text' },
  { label: '法规项目', icon: 'i-heroicons-list-bullet' },
  { label: '版本与影响', icon: 'i-heroicons-arrows-right-left' },
  { label: '历史提交包', icon: 'i-heroicons-archive-box' },
  { label: '审计记录', icon: 'i-heroicons-clock' }
];

const transitionOptions = computed(() => {
  const current = project.value?.status;
  if (current === 'draft') return [{ label: '提交认证机构', value: 'submitted' }];
  if (current === 'submitted') return [{ label: '开始审阅', value: 'under_review' }];
  if (current === 'under_review') {
    return [
      { label: '要求补件', value: 'supplement_required' },
      { label: '批准', value: 'approved' },
      { label: '拒绝', value: 'rejected' }
    ];
  }
  if (current === 'supplement_required') return [{ label: '重新提交补件', value: 'submitted' }];
  return [{ label: '重新打开审阅', value: 'under_review' }];
});

// 法规覆盖、阻断项、进度全部按当前快照实时重算
const derivedRegulations = computed(() => (project.value ? deriveRegulations(project.value) : []));
const blockingIssues = computed(() => (project.value ? deriveBlockingIssues(project.value) : []));
const derivedProgress = computed(() => (project.value ? deriveProgress(project.value) : 0));
const snapshot = computed(() => (project.value ? currentSnapshot(project.value) : null));
const pendingCount = computed(
  () => project.value?.evidence.filter((item) => item.status === 'pending_confirmation').length ?? 0
);

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
  const outcome = store.updateProject(id, { ...editor }, editReason.value);
  if (!outcome.ok) {
    error.value = outcome.draftSaved
      ? `${outcome.error} 变更已保留为草稿，可点击“重试保存”；当前项目数据保持上次一致状态。`
      : outcome.error ?? '保存失败';
    return;
  }
  editReason.value = '';
  store.draftNotice = '';
  message.value = outcome.invalidatedCount
    ? `项目资料与新版本快照已保存。${outcome.invalidatedCount} 项受影响证据已回到待确认，未受影响结论继续有效。`
    : '项目资料已保存，现有审阅结论继续有效。';
}

function retryDraft() {
  message.value = '';
  error.value = '';
  const outcome = store.retryDraft(id);
  if (!outcome.ok) {
    error.value = `${outcome.error} 草稿仍保留，可继续修改后重试。`;
    return;
  }
  editReason.value = '';
  message.value = '草稿已成功保存，基线快照与证据失效处理已完成。';
}

function discardDraft() {
  store.discardDraft(id);
  error.value = '';
  message.value = '未保存的变更草稿已放弃，表单恢复为当前已保存基线。';
}

function transition() {
  if (!project.value) return;
  message.value = '';
  error.value = '';
  if (!transitionReason.value.trim()) {
    error.value = '请填写审批流转依据';
    return;
  }
  if (transitionStatus.value === 'approved' && blockingIssues.value.length) {
    error.value = `存在阻断项，不能批准：${blockingIssues.value.join('；')}`;
    return;
  }
  const outcome = store.transition(
    id,
    transitionStatus.value,
    project.value.reviewer === '待分派' ? '认证机构审阅人' : project.value.reviewer,
    transitionReason.value
  );
  if (!outcome.ok) {
    error.value = outcome.error ?? '状态流转失败';
    return;
  }
  transitionReason.value = '';
  message.value = '审批状态已更新';
}

function updateEvidence(evidenceId: string, status: EvidenceStatus) {
  message.value = '';
  error.value = '';
  const outcome = store.updateEvidence(id, evidenceId, status, `审阅人将证据标记为${status}`);
  if (!outcome.ok) {
    error.value = outcome.error ?? '证据状态更新失败';
    return;
  }
  message.value =
    status === 'accepted'
      ? '证据已按当前基线快照重新确认并接受。'
      : '证据审阅状态已更新。';
}

function bulkSupplement() {
  message.value = '';
  error.value = '';
  if (!project.value) return;
  const errors = validateEvidenceUpgrade(project.value, selectedEvidence.value, supplementNote.value);
  if (errors.length) {
    error.value = errors.join('；');
    return;
  }
  const outcome = store.bulkSupplement(id, selectedEvidence.value, supplementNote.value);
  if (!outcome.ok) {
    error.value = outcome.error ?? '批量补件失败';
    return;
  }
  selectedEvidence.value = [];
  supplementNote.value = '';
  message.value = `已将 ${outcome.count} 项证据更新至当前软件基线并重新提交，等待审阅人按当前快照确认。`;
}
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
        </div>
        <p class="mt-2 text-lg font-medium">{{ project.name }}</p>
        <p class="mt-1 text-sm text-slate-500">
          {{ project.modelCode }} · {{ project.vehicleType }} · {{ snapshot?.configuration }} · {{ snapshot?.maintenanceVersion }} / SW {{ snapshot?.softwareVersion }}
        </p>
        <p class="mt-1 text-xs text-slate-400">当前基线快照：{{ project.currentSnapshotId }}</p>
      </div>
      <div class="min-w-[240px] border border-slate-200 bg-white p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="text-slate-500">证据完整度（按当前快照）</span>
          <span class="metric-value font-semibold">{{ derivedProgress }}%</span>
        </div>
        <UProgress class="mt-2" :value="derivedProgress" size="sm" />
        <p class="mt-2 text-xs text-slate-500">证书到期：{{ project.certificateExpiry }}</p>
        <p v-if="pendingCount" class="mt-2 text-xs font-medium text-purple-800">{{ pendingCount }} 项证据等待按当前快照确认</p>
      </div>
    </div>

    <div v-if="message" class="mb-4 border border-green-200 bg-green-50 p-3 text-sm text-green-900">{{ message }}</div>
    <div v-if="error" class="mb-4 border border-red-200 bg-red-50 p-3 text-sm text-red-900">{{ error }}</div>

    <div v-if="store.draftNotice || draft" class="mb-4 border border-purple-200 bg-purple-50 p-4">
      <p class="text-sm font-semibold text-purple-950">存在未保存的基线变更草稿</p>
      <p class="mt-1 text-sm text-purple-900">{{ store.draftNotice || '上次保存未完成，变更已保留。' }}</p>
      <p v-if="draft" class="mt-1 text-xs text-purple-800">失败原因：{{ draft.error }} · 保留时间 {{ draft.savedAt.slice(0, 16).replace('T', ' ') }}</p>
      <div class="mt-3 flex gap-3">
        <UButton size="sm" color="primary" @click="retryDraft">重试保存</UButton>
        <UButton size="sm" color="gray" variant="ghost" @click="discardDraft">放弃草稿</UButton>
      </div>
    </div>

    <div v-if="blockingIssues.length" class="mb-5 border border-amber-200 bg-amber-50 p-4">
      <p class="text-sm font-semibold text-amber-950">批准前阻断项（按当前快照 {{ project.currentSnapshotId }} 重算）</p>
      <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-amber-900">
        <li v-for="issue in blockingIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>

    <section class="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white p-5">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="font-semibold">项目与版本基线</h2>
            <p class="mt-1 text-xs text-slate-500">维护版本、软件版本或配置变更会生成新快照；受影响证据回到待确认，未受影响结论继续有效。</p>
          </div>
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
            <UButton type="submit" color="primary">保存并生成新版本快照</UButton>
          </div>
        </form>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">审批流转</h2>
        <p class="mt-1 text-xs text-slate-500">批准前按当前快照检查待确认证据、软件版本、配置覆盖和法规覆盖；存在阻断项不能批准。</p>
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
          结论绑定基线快照。重新确认时配置范围必须覆盖 {{ snapshot?.configuration }}、软件版本必须为 {{ snapshot?.softwareVersion }}，否则不能接受。
        </p>
      </div>
      <EvidenceTable :evidence="project.evidence" :project="project" editable @update="updateEvidence" />
    </section>

    <section v-else-if="activeTab === 1">
      <div class="mb-4">
        <h2 class="font-semibold">法规项目覆盖</h2>
        <p class="mt-1 text-sm text-slate-500">覆盖状态按当前快照与证据实时重算，不沿用历史结论。</p>
      </div>
      <RegulationTree :regulations="derivedRegulations" :evidence="project.evidence" />
    </section>

    <section v-else-if="activeTab === 2" class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div class="border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">版本差异与基线快照</h2>
        </div>
        <div class="divide-y divide-slate-200">
          <article v-for="version in project.versions" :key="version.id" class="p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="font-medium">{{ version.label }} · {{ version.author }}</p>
                <p class="mt-1 text-xs text-slate-500">{{ version.createdAt.slice(0, 16).replace('T', ' ') }}</p>
                <p class="mt-1 font-mono text-xs text-slate-400">快照 {{ version.snapshot.id }}<span v-if="version.snapshot.id === project.currentSnapshotId">（当前）</span></p>
              </div>
              <UBadge color="gray" variant="soft">{{ version.impactedConfigurations.join('、') }}</UBadge>
            </div>
            <p class="mt-3 text-sm">{{ version.summary }}</p>
            <ul class="mt-2 list-inside list-disc text-sm text-slate-600">
              <li v-for="change in version.changes" :key="change">{{ change }}</li>
            </ul>
            <p v-if="version.snapshot.reason" class="mt-2 text-xs text-slate-500">变更原因：{{ version.snapshot.reason }}</p>
          </article>
        </div>
      </div>

      <div class="border border-slate-200 bg-white p-5">
        <h2 class="font-semibold">批量补件</h2>
        <p class="mt-1 text-xs text-slate-500">将缺失、被拒或待重交证据更新到当前软件基线，提交后由审阅人按当前快照重新确认。</p>
        <form class="mt-4 space-y-4" @submit.prevent="bulkSupplement">
          <label
            v-for="item in project.evidence.filter((evidence) => ['rejected', 'resubmit', 'missing', 'pending_confirmation'].includes(evidence.status))"
            :key="item.id"
            class="flex gap-3 border border-slate-200 p-3"
          >
            <input v-model="selectedEvidence" type="checkbox" :value="item.id" class="mt-1" />
            <span>
              <span class="block text-sm font-medium">{{ item.name }}</span>
              <span class="mt-1 block text-xs text-slate-500">{{ item.id }} · 当前 SW {{ item.softwareVersion }}</span>
            </span>
          </label>
          <p v-if="!project.evidence.some((evidence) => ['rejected', 'resubmit', 'missing', 'pending_confirmation'].includes(evidence.status))" class="text-sm text-slate-500">
            当前没有待补件证据。
          </p>
          <UFormGroup label="补件说明">
            <UTextarea v-model="supplementNote" :rows="3" placeholder="说明已完成的测试、配置覆盖和版本更新" />
          </UFormGroup>
          <UButton type="submit" color="primary" class="w-full justify-center">批量更新并重新提交</UButton>
        </form>
      </div>
    </section>

    <section v-else-if="activeTab === 3" class="border border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-4 py-3">
        <h2 class="font-semibold">历史提交包</h2>
        <p class="mt-1 text-xs text-slate-500">提交包在提交/批准时按当时快照冻结归档；基线更新后历史包保留原样，当前覆盖以“法规项目”页实时重算为准。</p>
      </div>
      <div v-if="project.packages.length" class="divide-y divide-slate-200">
        <article v-for="pkg in project.packages" :key="pkg.id" class="p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="font-medium">{{ pkg.id }} · {{ pkg.label }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ pkg.submittedAt.slice(0, 16).replace('T', ' ') }} · 触发：{{ pkg.trigger === 'approve' ? '批准归档' : pkg.trigger === 'resubmit' ? '补件重交' : '首次提交' }}</p>
              <p class="mt-1 font-mono text-xs text-slate-400">冻结快照 {{ pkg.snapshot.id }}</p>
            </div>
            <StatusBadge :status="pkg.status" />
          </div>
          <p class="mt-3 text-sm text-slate-600">{{ pkg.note }}</p>
          <div class="mt-3 grid gap-3 text-xs md:grid-cols-2">
            <div class="border border-slate-200 p-3">
              <p class="font-medium text-slate-700">归档时法规覆盖（{{ pkg.regulations.filter((r) => r.status === 'complete').length }}/{{ pkg.regulations.filter((r) => r.required).length }} 完整）</p>
              <ul class="mt-2 space-y-1 text-slate-500">
                <li v-for="reg in pkg.regulations" :key="reg.id">
                  {{ reg.code }} · {{ reg.status === 'complete' ? '完整' : reg.status === 'conflict' ? '冲突' : '缺失' }} · {{ reg.coverage }}%
                </li>
              </ul>
            </div>
            <div class="border border-slate-200 p-3">
              <p class="font-medium text-slate-700">归档时阻断项</p>
              <ul v-if="pkg.blockingIssues.length" class="mt-2 list-inside list-disc space-y-1 text-amber-800">
                <li v-for="issue in pkg.blockingIssues" :key="issue">{{ issue }}</li>
              </ul>
              <p v-else class="mt-2 text-green-700">无阻断项</p>
            </div>
          </div>
          <details class="mt-3 text-xs text-slate-500">
            <summary class="cursor-pointer">归档证据清单（{{ pkg.evidence.length }} 项）</summary>
            <ul class="mt-2 space-y-1">
              <li v-for="item in pkg.evidence" :key="item.id">
                {{ item.name }} · 文件 {{ item.version }} · SW {{ item.softwareVersion }} · {{ item.configurations.join('、') }} · {{ item.status }}
              </li>
            </ul>
          </details>
        </article>
      </div>
      <p v-else class="p-10 text-center text-sm text-slate-500">尚未冻结过提交包（提交或批准时按当前快照归档）。</p>
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
