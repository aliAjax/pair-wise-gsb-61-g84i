import { createPinia, setActivePinia } from 'pinia';
import { useCertificationStore } from '~/stores/certification';
import { loadProjects, getDraft } from '~/services/persistence';
import { deriveBlockingIssues, deriveProgress, deriveRegulations, deriveProjectRisk } from '~/services/snapshots';
import type { ProjectInput } from '~/types/certification';

// --- 内存版 localStorage，可对指定 key 注入写入失败 ---
class FakeStorage {
  data = new Map<string, string>();
  failingKeys = new Set<string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    if (this.failingKeys.has(key)) throw new Error(`QuotaExceededError: ${key}`);
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
    this.failingKeys.clear();
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name} ${extra}`);
  }
}

const storage = new FakeStorage();
(globalThis as any).localStorage = storage;

function freshStore(reset = true) {
  if (reset) storage.clear();
  setActivePinia(createPinia());
  const store = useCertificationStore();
  store.hydrate();
  return store;
}

function edit118(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: '纯电运动轿车 2027 款',
    modelCode: 'EVS-27',
    vehicleType: 'M1',
    configuration: '长续航四驱版',
    maintenanceVersion: 'MY27.1',
    softwareVersion: '8.4.1',
    applicant: '远航汽车工程部',
    agency: '华东认证中心',
    certificateExpiry: '2026-12-16',
    ...over
  };
}

// ============ 场景 0：种子派生基线 ============
console.log('\n[场景0] 种子数据：法规覆盖/进度按当前快照派生');
{
  const store = freshStore();
  const p = store.projectById('TA-2026-118')!;
  const regs = deriveRegulations(p);
  const complete = regs.filter((r) => r.status === 'complete').map((r) => r.code);
  check('BRAKE/BATTERY/EMC/WLTP/COMPONENT 五项完整', complete.join(',') === 'GB 21670,GB 34660,GB 18352.6,GB 38031,R100.2', complete.join(','));
  check('进度派生 63%', deriveProgress(p) === 63, `${deriveProgress(p)}`);
  check('种子状态即含阻断项（未完成法规+证据未完成）', deriveBlockingIssues(p).length > 0);
}

// ============ 场景 1：软件版本变更 → 全部旧软件证据失效；未受影响结论保留 ============
console.log('\n[场景1] 软件版本 8.4.1 → 8.5.0，受影响已接受证据回到待确认');
{
  const store = freshStore();
  const id = 'TA-2026-118';
  const before = store.projectById(id)!;
  const acceptedBefore = before.evidence.filter((e) => e.status === 'accepted').length;
  const result = store.updateProject(id, edit118({ softwareVersion: '8.5.0' }), '软件基线升级测试');
  check('保存成功', result.ok);
  check(`5 项已接受证据全部失效（实际 ${result.invalidatedCount}）`, result.invalidatedCount === 5);
  check('失效计数与已接受数一致', result.invalidatedCount === acceptedBefore);

  const p = store.projectById(id)!;
  check('项目软件版本已更新', p.softwareVersion === '8.5.0');
  check('当前快照指向新版本', p.currentSnapshotId === p.versions[0].snapshot.id && p.versions[0].snapshot.softwareVersion === '8.5.0');
  check('旧快照保留在版本链', p.versions.some((v) => v.snapshot.softwareVersion === '8.3.9') && p.versions.length === 3);
  const ev01 = p.evidence.find((e) => e.id === 'EV-118-01')!;
  check('EV-118-01 待确认且解绑快照', ev01.status === 'pending_confirmation' && ev01.reviewSnapshotId === null);
  check('记录失效原因', ev01.invalidatedReason!.includes('8.5.0'));
  check('rejected/resubmit/submitted 证据状态不变',
    p.evidence.find((e) => e.id === 'EV-118-02')!.status === 'rejected' &&
    p.evidence.find((e) => e.id === 'EV-118-03')!.status === 'resubmit' &&
    p.evidence.find((e) => e.id === 'EV-118-08')!.status === 'submitted');
  check('风险变为待确认', deriveProjectRisk(p) === 'pending_confirmation');
  check('进度按当前快照下跌', deriveProgress(p) === 0, `${deriveProgress(p)}`);
  check('批准阻断项包含重新确认要求', deriveBlockingIssues(p).some((i) => i.includes('重新确认')));

  // 审计记录
  check('审计记录了失效数量', p.audit[0].detail.includes('5 项'));
}

// ============ 场景 2：重新确认的硬性校验 ============
console.log('\n[场景2] 重新确认：软件版本不符/配置不覆盖不能接受；补齐后可接受并绑定新快照');
{
  const store = freshStore();
  const id = 'TA-2026-118';
  store.updateProject(id, edit118({ softwareVersion: '8.5.0' }), '软件基线升级测试');

  // 直接接受软件版本仍为 8.4.1 的证据 → 拒绝
  const bad = store.updateEvidence(id, 'EV-118-01', 'accepted', '尝试接受');
  check('软件版本不符不能接受', !bad.ok && bad.error!.includes('8.4.1') && bad.error!.includes('8.5.0'), bad.error);
  const still = store.projectById(id)!.evidence.find((e) => e.id === 'EV-118-01')!;
  check('被拒后证据仍为待确认', still.status === 'pending_confirmation');

  // 批量补件：软件同步 8.5.0（配置仍覆盖），状态变为 submitted 而非自动接受
  const sup = store.bulkSupplement(id, ['EV-118-01'], '已按 8.5.0 完成回归测试，配置范围不变。');
  check('补件成功', sup.ok && sup.count === 1);
  const afterSup = store.projectById(id)!.evidence.find((e) => e.id === 'EV-118-01')!;
  check('补件后为已提交、软件 8.5.0、未绑定快照', afterSup.status === 'submitted' && afterSup.softwareVersion === '8.5.0' && afterSup.reviewSnapshotId === null);

  // 审阅人按当前快照确认
  const ok = store.updateEvidence(id, 'EV-118-01', 'accepted', '按 8.5.0 快照确认');
  check('匹配基线后可以接受', ok.ok, ok.error);
  const accepted = store.projectById(id)!.evidence.find((e) => e.id === 'EV-118-01')!;
  const snapId = store.projectById(id)!.currentSnapshotId;
  check('接受后绑定当前快照', accepted.status === 'accepted' && accepted.reviewSnapshotId === snapId);

  // 配置不覆盖的场景：照明证据只有标准续航后驱版，软件补到 8.5.0 后仍因配置不能接受
  store.bulkSupplement(id, ['EV-118-03'], '软件同步但未补长续航测试。');
  const lightBad = store.updateEvidence(id, 'EV-118-03', 'accepted', '尝试接受照明');
  check('配置不覆盖不能接受', !lightBad.ok && lightBad.error!.includes('未覆盖当前配置'), lightBad.error);
}

// ============ 场景 3：仅配置变更 → 只影响未覆盖新配置的证据 ============
console.log('\n[场景3] 配置 长续航四驱版 → 标准续航后驱版，只失效覆盖不到的证据');
{
  const store = freshStore();
  const id = 'TA-2026-118';
  const result = store.updateProject(id, edit118({ configuration: '标准续航后驱版' }), '申报配置切换');
  check('保存成功', result.ok);
  const p = store.projectById(id)!;
  const status = (eid: string) => p.evidence.find((e) => e.id === eid)!.status;
  check('双配置证据 EV-118-01 继续有效', status('EV-118-01') === 'accepted');
  check('双配置证据 EV-118-04 继续有效', status('EV-118-04') === 'accepted');
  check('双配置证据 EV-118-05 继续有效', status('EV-118-05') === 'accepted');
  check('仅长续航的 WLTP 证据失效', status('EV-118-06') === 'pending_confirmation');
  check('仅长续航的部件证据失效', status('EV-118-07') === 'pending_confirmation');
  check('失效数量为 2', result.invalidatedCount === 2, `${result.invalidatedCount}`);
  // 继续有效的证据仍绑定原快照（=新当前快照 id 未变化）
  check('继续有效的结论仍绑定当前快照',
    p.evidence.find((e) => e.id === 'EV-118-01')!.reviewSnapshotId === p.currentSnapshotId);
  check('新快照记录配置变更维度', p.versions[0].snapshot.changes.includes('配置范围'));
}

// ============ 场景 4：维护版本变更 → 已接受结论全部失效 ============
console.log('\n[场景4] 维护版本 MY27.1 → MY27.2，全部已接受结论失效');
{
  const store = freshStore();
  const id = 'TA-2026-118';
  const result = store.updateProject(id, edit118({ maintenanceVersion: 'MY27.2' }), '维护版本切换');
  check('5 项已接受全部失效', result.invalidatedCount === 5);
  const p = store.projectById(id)!;
  check('软件/配置未变，快照记录维护版本维度',
    p.versions[0].snapshot.changes.length === 1 && p.versions[0].snapshot.changes[0] === '维护版本' &&
    p.versions[0].snapshot.softwareVersion === '8.4.1');
}

// ============ 场景 5：阻断项存在时不能批准 ============
console.log('\n[场景5] 存在阻断项时批准被拒绝（store 与 validator 双保险）');
{
  const store = freshStore();
  const p = store.projectById('TA-2026-118')!;
  const issues = deriveBlockingIssues(p);
  check('存在阻断项', issues.length > 0);
  const r = store.transition('TA-2026-118', 'approved', '刘珊', '尝试批准');
  check('批准被阻止', !r.ok && r.error!.includes('不能批准'), r.error);
  check('状态未被改成 approved', store.projectById('TA-2026-118')!.status !== 'approved');
}

// ============ 场景 6：已批准项目基线更新 → 回到审阅中；历史提交包不动 ============
console.log('\n[场景6] 已批准项目基线更新回到审阅中，冻结提交包保持原样');
{
  const store = freshStore();
  const id = 'TA-2026-092';
  const pkgBefore = JSON.stringify(store.projectById(id)!.packages[0]);
  store.updateProject(
    id,
    {
      name: '轻型商用车改款',
      modelCode: 'LCV-4',
      vehicleType: 'N1',
      configuration: '高顶货运版',
      maintenanceVersion: 'MY26.1',
      softwareVersion: '3.2.4',
      applicant: '西岭商用车',
      agency: '华北认证中心',
      certificateExpiry: '2027-08-29'
    },
    '维护版本升级'
  );
  const p = store.projectById(id)!;
  check('已批准 → 审阅中', p.status === 'under_review');
  check('历史提交包数量不变', p.packages.length === 1);
  check('历史提交包内容原样保留', JSON.stringify(p.packages[0]) === pkgBefore);
  check('历史包仍冻结在旧快照 MY26.0', p.packages[0].snapshot.maintenanceVersion === 'MY26.0');
}

// ============ 场景 7：提交时冻结新提交包；后续基线变化不改变它 ============
console.log('\n[场景7] 提交按当前快照冻结提交包，基线更新后包内容不变');
{
  const store = freshStore();
  const id = 'TA-2026-109'; // supplement_required
  const t = store.transition(id, 'submitted', '北辰汽车', '补件完成重新提交');
  check('重交成功', t.ok);
  const p1 = store.projectById(id)!;
  check('生成 resubmit 提交包', p1.packages.length === 1 && p1.packages[0].trigger === 'resubmit');
  check('提交包冻结当前快照 5.7.0', p1.packages[0].snapshot.softwareVersion === '5.7.0');
  const frozenPkg = JSON.stringify(p1.packages[0]);

  store.updateProject(
    id,
    {
      name: '插电式混合动力多用途车',
      modelCode: 'PHV-M9',
      vehicleType: 'M1',
      configuration: '七座旗舰版',
      maintenanceVersion: 'MY26.2',
      softwareVersion: '5.8.0',
      applicant: '北辰汽车',
      agency: '华南认证中心',
      certificateExpiry: '2026-11-20'
    },
    '软件升级'
  );
  const p2 = store.projectById(id)!;
  check('基线已变 5.8.0', p2.softwareVersion === '5.8.0');
  check('冻结包内容未被重算', JSON.stringify(p2.packages[0]) === frozenPkg);
  check('冻结包快照仍为 5.7.0', p2.packages[0].snapshot.softwareVersion === '5.7.0');
}

// ============ 场景 8：保存失败 → 内存回滚无半成品 + 草稿保留可重试 ============
console.log('\n[场景8] 持久化失败：内存回滚、草稿保留；重试成功后一致');
{
  storage.clear();
  const store = freshStore();
  const id = 'TA-2026-118';
  const before = JSON.stringify(store.projectById(id));

  // 主存储写入失败（草稿存储可用，模拟配额只对大数据主 key 失败）
  storage.failingKeys.add('vehicle-type-approval-projects-v2');
  const r = store.updateProject(id, edit118({ softwareVersion: '9.0.0' }), '失败的保存');
  check('保存返回失败', !r.ok && r.draftSaved === true);

  const after = store.projectById(id)!;
  check('内存立即回滚：软件版本仍旧', after.softwareVersion === '8.4.1');
  check('内存立即回滚：没有半成品版本', after.versions.length === 2);
  check('内存立即回滚：证据全部原状', JSON.stringify(after) === before);
  check('草稿已保留', Boolean(getDraft(id)) && getDraft(id)!.input.softwareVersion === '9.0.0');
  storage.failingKeys.clear();

  // 模拟“下次打开”：重新从存储加载
  const reopened = loadProjects();
  const rp = reopened.find((x) => x.id === id)!;
  check('下次打开：持久化数据仍是旧基线', rp.softwareVersion === '8.4.1');
  check('下次打开：没有项目改了证据没改的半成品', rp.versions.length === 2 && rp.evidence.every((e) => e.status !== 'pending_confirmation'));

  // 用草稿重试（不清空存储，草稿与回退后的旧数据都还在）
  const store2 = freshStore(false);
  const retry = store2.retryDraft(id);
  check('重试成功', retry.ok, retry.error);
  const p = store2.projectById(id)!;
  check('重试后基线更新生效', p.softwareVersion === '9.0.0');
  check('重试后证据失效处理生效', p.evidence.filter((e) => e.status === 'pending_confirmation').length === 5);
  check('重试后草稿已清除', !getDraft(id));
}

// ============ 场景 9：v1 → v2 迁移 ============
console.log('\n[场景9] 旧版 v1 数据自动迁移到快照模型');
{
  storage.clear();
  const v1Project = {
    id: 'TA-2026-001',
    name: '迁移测试项目一',
    modelCode: 'MIG-1',
    vehicleType: 'M1',
    configuration: '迁移配置',
    maintenanceVersion: 'MY20.1',
    softwareVersion: '1.0.0',
    status: 'under_review',
    progress: 78,
    applicant: '迁移申请人',
    reviewer: '审阅人',
    agency: '华东认证中心',
    updatedAt: '2026-01-01T00:00:00.000Z',
    certificateExpiry: '2028-01-01',
    regulations: [
      { id: 'REG-BRAKE', code: 'GB 21670', title: '制动', category: '安全', required: true, status: 'missing', coverage: 0, issues: ['x'] }
    ],
    evidence: [
      {
        id: 'EV-1', projectId: 'TA-2026-001', regulationId: 'REG-BRAKE', name: '旧证据',
        type: 'test_report', version: 'R1', softwareVersion: '1.0.0', configurations: ['迁移配置'],
        status: 'accepted', note: '', updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    versions: [
      { id: 'VER-1', label: 'MY20.1 / 1.0.0', author: '迁移申请人', createdAt: '2026-01-01T00:00:00.000Z', summary: '旧版本', changes: ['x'], impactedConfigurations: ['迁移配置'] }
    ],
    audit: []
  };
  storage.setItem('vehicle-type-approval-projects-v2', JSON.stringify([v1Project]));
  const migrated = loadProjects().find((p) => p.id === 'TA-2026-001')!;
  check('补出当前快照 id', Boolean(migrated.currentSnapshotId));
  check('版本带上快照', migrated.versions[0].snapshot.softwareVersion === '1.0.0');
  check('已接受证据绑定迁移快照', migrated.evidence[0].reviewSnapshotId === migrated.currentSnapshotId);
  check('法规退化为目录定义（无 status 字段）', !('status' in migrated.regulations[0]));
  check('提交包数组补齐', Array.isArray(migrated.packages) && migrated.packages.length === 0);

  // 迁移后业务逻辑可直接运行：派生完整、无阻断（证书 2028）
  const regs = deriveRegulations(migrated);
  check('迁移数据可派生：BRAKE 完整', regs[0].status === 'complete' && regs[0].coverage === 100, regs[0].issues.join(';'));
  check('迁移数据无阻断项可批准', deriveBlockingIssues(migrated).length === 0, deriveBlockingIssues(migrated).join(';'));
}

// ============ 场景 10：主存储损坏/写入中断 → 备份兜底，不返回半成品 ============
console.log('\n[场景10] 主存储不可用时回退上一版备份');
{
  storage.clear();
  const store = freshStore();
  // 先制造上一版有效数据
  store.updateProject('TA-2026-118', edit118({ softwareVersion: '8.5.0' }), '上一版数据');
  // 下一次保存中断：备份已写入旧数据，主写入失败（内存回滚）
  storage.failingKeys.add('vehicle-type-approval-projects-v2');
  const r = store.updateProject('TA-2026-118', edit118({ softwareVersion: '9.0.0' }), '中断的保存');
  check('中断的保存报错', !r.ok);
  storage.failingKeys.clear();
  // 模拟主存储随后损坏（或部分写入），加载应回退到备份中的上一版
  storage.setItem('vehicle-type-approval-projects-v2', '{not-json');
  const loaded = loadProjects();
  check('主存储损坏时仍能加载', loaded.some((p) => p.id === 'TA-2026-118'));
  check('回退到上一版基线 8.5.0（不是未提交的 9.0.0）',
    loaded.find((p) => p.id === 'TA-2026-118')!.versions[0].snapshot.softwareVersion === '8.5.0');
  check('回退数据结构完整（含证据与快照链）',
    loaded.find((p) => p.id === 'TA-2026-118')!.evidence.length === 8);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
