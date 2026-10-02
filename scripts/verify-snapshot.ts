// @ts-nocheck
// 端到端冒烟验证：快照绑定 / 失效 / 重算 / 阻断 / 草稿原子性 / 提交包冻结（独立 Node 脚本，由 jiti 运行）
import { createPinia, setActivePinia } from 'pinia';
import { useCertificationStore } from '~/stores/certification';
import { setFailureSimulation } from '~/services/storage';
import { validateSubmission } from '~/services/validators';
import { recomputeRegulations, isAcceptanceCurrent } from '~/services/snapshot';

// ---- 浏览器环境桩 ----
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear()
};
// Node 20 自带 crypto.randomUUID

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

setActivePinia(createPinia());
const store = useCertificationStore();
store.hydrate();

const pid = 'TA-2026-118';

console.log('\n[1] 初始：已接受证据绑定当前快照，法规覆盖按快照计算');
{
  const p = store.projectById(pid);
  const brake = p.evidence.find((e) => e.id === 'EV-118-01')!;
  check('制动证据在当前快照下有效', isAcceptanceCurrent(brake, p));
  check('制动证据带 acceptedSnapshot', !!brake.acceptedSnapshot);
  const regs = recomputeRegulations(p);
  const brakeReg = regs.find((r) => r.id === 'REG-BRAKE')!;
  check('REG-BRAKE 当前快照完整', brakeReg.status === 'complete', brakeReg.status);
}

console.log('\n[2] 软件版本基线更新：全部已接受证据失效回到待确认');
{
  const before = JSON.stringify(store.projectById(pid).evidence);
  const p0 = store.projectById(pid);
  const input = {
    name: p0.name, modelCode: p0.modelCode, vehicleType: p0.vehicleType,
    configuration: p0.configuration, maintenanceVersion: p0.maintenanceVersion,
    softwareVersion: '8.5.0', applicant: p0.applicant, agency: p0.agency,
    certificateExpiry: p0.certificateExpiry
  };
  const r = store.updateProject(pid, input, 'OTA 升级软件基线');
  check('基线更新成功', r.ok, r.error ?? '');
  const p = store.projectById(pid);
  const accepted = p.evidence.filter((e) => e.status === 'accepted');
  const stale = p.evidence.filter((e) => e.status === 'stale');
  check('原有 2 项已接受证据全部 stale', accepted.length === 0 && stale.length === 2, `accepted=${accepted.length} stale=${stale.length}`);
  check('rejected 的软件报告不被重复处理', p.evidence.find((e) => e.id === 'EV-118-02')!.status === 'rejected');
  check('版本快照数 +1', p.versions.length === 3);
  check('baselineVersionId 指向新版本', p.baselineVersionId === p.versions[0].id);
  check('审计记录含证据失效', p.audit[0].detail.includes('证据回到待确认'));
  check('完整度下降', p.progress < 50, `progress=${p.progress}`);
  check('阻断项包含失效证据', validateSubmission(p).some((i) => i.includes('失效')));
  void before;
}

console.log('\n[3] 旧软件版本的证据不能接受（版本不一致 + 配置不覆盖双重校验）');
{
  const p = store.projectById(pid);
  const brake = p.evidence.find((e) => e.id === 'EV-118-01')!;
  // 仍是旧软件 8.4.1，当前基线 8.5.0
  const r1 = store.updateEvidence(pid, brake.id, 'accepted', '尝试直接接受');
  check('软件版本不一致时接受被拒', !r1.ok && /软件版本/.test(r1.error ?? ''), r1.error ?? '');
  check('证据保持 stale', store.projectById(pid).evidence.find((e) => e.id === brake.id)!.status === 'stale');
}

console.log('\n[4] 补件更新到当前基线，但配置未覆盖时仍不能接受');
{
  const p = store.projectById(pid);
  const light = p.evidence.find((e) => e.id === 'EV-118-03')!;
  // 照明证据配置只有标准续航后驱版，当前配置长续航四驱版；软件先补到 8.5.0
  const n = store.bulkSupplement(pid, [light.id], '更新软件版本但暂未补长续航配置测试，用于验证配置校验。');
  check('补件成功计数 1', n === 1);
  const p2 = store.projectById(pid);
  const light2 = p2.evidence.find((e) => e.id === 'EV-118-03')!;
  check('补件后软件版本=基线', light2.softwareVersion === '8.5.0');
  check('补件后状态 submitted', light2.status === 'submitted');
  const r = store.updateEvidence(pid, light.id, 'accepted', '尝试接受');
  check('配置未覆盖当前配置时接受被拒', !r.ok && /配置范围/.test(r.error ?? ''), r.error ?? '');
}

console.log('\n[5] 配置+软件都满足后接受成功，结论绑定新快照；未受影响/重确认后重新计入覆盖');
{
  const p = store.projectById(pid);
  const brake = p.evidence.find((e) => e.id === 'EV-118-01')!;
  // 制动证据配置已覆盖当前配置，补件把软件升到 8.5.0 再接受
  store.bulkSupplement(pid, [brake.id], '按 8.5.0 重新出具制动报告。');
  const r = store.updateEvidence(pid, brake.id, 'accepted', '8.5.0 制动报告重新确认');
  check('满足条件后接受成功', r.ok, r.error ?? '');
  const p2 = store.projectById(pid);
  const b2 = p2.evidence.find((e) => e.id === 'EV-118-01')!;
  check('接受结论绑定 8.5.0 快照', b2.acceptedSnapshot?.softwareVersion === '8.5.0' && b2.acceptedSnapshot?.versionId === p2.baselineVersionId);
  check('接受后在当前快照有效', isAcceptanceCurrent(b2, p2));
}

console.log('\n[6] 配置变更：仅未覆盖新配置的已接受证据失效，覆盖的继续有效');
{
  const p0 = store.projectById(pid);
  // 制动证据配置含长续航四驱+标准续航后驱；电池证据当前 stale（8.4.1）
  const input = {
    name: p0.name, modelCode: p0.modelCode, vehicleType: p0.vehicleType,
    configuration: '标准续航后驱版', maintenanceVersion: p0.maintenanceVersion,
    softwareVersion: p0.softwareVersion, applicant: p0.applicant, agency: p0.agency,
    certificateExpiry: p0.certificateExpiry
  };
  const r = store.updateProject(pid, input, '申报配置切换为标准续航后驱版');
  check('配置变更成功', r.ok, r.error ?? '');
  const p = store.projectById(pid);
  const brake = p.evidence.find((e) => e.id === 'EV-118-01')!;
  // 制动证据覆盖集合包含新配置且软件=8.5.0，应继续有效
  check('覆盖新配置的证据保持 accepted', brake.status === 'accepted', brake.status);
  check('保持有效的证据在新快照下仍有效', isAcceptanceCurrent(brake, p));
  const staleNames = p.evidence.filter((e) => e.status === 'stale').map((e) => e.id);
  check('其它未重确认证据仍为 stale', staleNames.includes('EV-118-04'));
}

console.log('\n[7] 存在失效/未接受证据时不能批准（store 硬阻断）');
{
  const p0 = store.projectById(pid);
  const r = store.transition(pid, 'approved', '刘珊', '尝试批准');
  check('批准被阻断', !r.ok && /阻断/.test(r.error ?? ''), r.error ?? '');
  check('状态未被改为 approved', store.projectById(pid).status === p0.status);
}

console.log('\n[8] 提交时冻结提交包；之后基线更新，历史提交包保留原样');
{
  const p0 = store.projectById(pid);
  const r = store.transition(pid, 'submitted', p0.applicant, '重新提交当前快照');
  check('提交成功', r.ok, r.error ?? '');
  const p = store.projectById(pid);
  check('生成 1 份提交包', p.submissionPackages.length === 1);
  const pkg = p.submissionPackages[0];
  check('提交包冻结基线=标准续航后驱版/8.5.0',
    pkg.baseline.configuration === '标准续航后驱版' && pkg.baseline.softwareVersion === '8.5.0');
  const frozenEvidenceCount = pkg.evidence.length;

  // 再改基线
  const input = {
    name: p.name, modelCode: p.modelCode, vehicleType: p.vehicleType,
    configuration: '长续航四驱版', maintenanceVersion: 'MY27.2',
    softwareVersion: '9.0.0', applicant: p.applicant, agency: p.agency,
    certificateExpiry: p.certificateExpiry
  };
  store.updateProject(pid, input, '大版本升级');
  const p2 = store.projectById(pid);
  check('历史提交包数量仍为 1 且证据数不变',
    p2.submissionPackages.length === 1 && p2.submissionPackages[0].evidence.length === frozenEvidenceCount);
  check('历史包冻结基线未被改写', p2.submissionPackages[0].baseline.softwareVersion === '8.5.0');
  check('当前基线已是 9.0.0', p2.softwareVersion === '9.0.0');
}

console.log('\n[9] 保存失败：已提交态不变 + 草稿保留可重试，无各改一半');
{
  const snapshotBefore = JSON.stringify(store.projectById(pid));
  const p0 = store.projectById(pid);
  const input = {
    name: p0.name, modelCode: p0.modelCode, vehicleType: p0.vehicleType,
    configuration: p0.configuration, maintenanceVersion: 'MY28.0',
    softwareVersion: '9.1.0', applicant: p0.applicant, agency: p0.agency,
    certificateExpiry: p0.certificateExpiry
  };
  setFailureSimulation(true);
  const r = store.updateProject(pid, input, '应当失败的一次保存');
  setFailureSimulation(false);
  check('保存返回失败', !r.ok);
  check('内存已提交态完全不变（无半包）', JSON.stringify(store.projectById(pid)) === snapshotBefore);
  const draft = store.getDraft(pid);
  check('草稿已保留', !!draft && draft.input.softwareVersion === '9.1.0' && draft.input.maintenanceVersion === 'MY28.0');
  // 证据没有被改成 stale（项目字段也没变）
  const p = store.projectById(pid);
  check('失败后项目软件版本仍为 9.0.0', p.softwareVersion === '9.0.0');

  // 重试成功
  const r2 = store.updateProject(pid, draft.input, draft.reason);
  check('重试保存成功', r2.ok, r2.error ?? '');
  check('草稿已清除', store.getDraft(pid) === null);
  const p2 = store.projectById(pid);
  check('重试后基线为 9.1.0/MY28.0', p2.softwareVersion === '9.1.0' && p2.maintenanceVersion === 'MY28.0');
}

console.log('\n[10] 重新确认接受的强制条件在 9.1.0 下依旧成立');
{
  const p = store.projectById(pid);
  const brake = p.evidence.find((e) => e.id === 'EV-118-01')!;
  // 大版本升级后应 stale
  check('大版本升级后制动证据 stale', brake.status === 'stale', brake.status);
  // 未补件直接接受：软件不符
  const r = store.updateEvidence(pid, brake.id, 'accepted', 'x');
  check('软件未更新不能重新确认', !r.ok);
  store.bulkSupplement(pid, [brake.id], '升级到 9.1.0 重新测试，配置覆盖长续航四驱。');
  const r2 = store.updateEvidence(pid, brake.id, 'accepted', '9.1.0 重新确认');
  check('补件并满足配置后重新确认成功', r2.ok, r2.error ?? '');
}

console.log('\n[11] 跨刷新持久化：localStorage 中的数据可重新 hydrate 且派生口径一致');
{
  setActivePinia(createPinia());
  const fresh = useCertificationStore();
  fresh.hydrate();
  const p = fresh.projectById(pid);
  check('重新 hydrate 后基线保持 9.1.0', p.softwareVersion === '9.1.0');
  check('重新 hydrate 后制动证据 accepted 且绑定 9.1.0',
    p.evidence.find((e) => e.id === 'EV-118-01')!.acceptedSnapshot?.softwareVersion === '9.1.0');
  check('历史提交包仍存在且冻结', p.submissionPackages[0]?.baseline.softwareVersion === '8.5.0');
}

console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n${failures} 个断言失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
