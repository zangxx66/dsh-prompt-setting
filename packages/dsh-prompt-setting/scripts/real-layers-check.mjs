#!/usr/bin/env node
/**
 * g-057 / g-058 真机数据核对（只读、一次性、**不属于 `node --test` 套件**）。
 *
 * 为什么要单独一个脚本，而不是一条测试：这个核对读的是**这台机器上负责人自己的
 * 两份活配置文件**（`~/.dsh/prompt-setting/overrides.json` 与
 * `<repo>/.dsh-prompt-setting/overrides.json`），而它们会被随时编辑。把它写成测试
 * 只有两种结局——文件被编辑时**假红**（评审实测过：负责人改了工作区层那条，全量
 * 立刻 1 fail），或者文件缺失时**恒绿且不计数**（clone/CI 上完全没有约束力）。两者
 * 都是"测试依赖外部可变状态"，所以真机核对留在测试套件之外：套件里只留合成夹具
 * （`test/overrides.test.mjs`、`test/route.test.mjs` 与 `test/client.test.mjs` 的
 * g-057 / g-058 用例）。
 *
 * 本脚本读 **宿主自己的纯函数核**（`core/overrides.js` 的 `mergeLayers` /
 * `applyOverrides`），因此验证的是真实代码路径；`/prompt-setting/*` 路由需鉴权
 * （401），不能用 curl 取，这正是改走纯函数的原因。**全程只读，不写任何文件。**
 *
 * g-058 追加的证据（同样只读）：用真机两层的**文本**合成一份"工作区层选叠加"的配置，
 * 走同一条合并＋装配核，打印叠加后的字符数与文本校验结果。于是"两段都生效"的预期
 * 在**不改负责人任何文件**的前提下被核对；真机工作区层真的选了叠加时，脚本还会把
 * 真实装配结果与这个预期逐字对照。
 *
 * 用法：
 *   node scripts/real-layers-check.mjs                 # 打印真机证据（g-057 + g-058）
 *   node scripts/real-layers-check.mjs --require-fallback
 *       # g-057：仅当工作区层保留段为空（2026-10-10 出问题的生产形态）时断言"回退到
 *       # 用户层文本"；不满足则红
 *   node scripts/real-layers-check.mjs --require-append
 *       # g-058：仅当工作区层保留段 action 为 append（叠加）时断言"装配 = 用户层文本 +
 *       # 一个空行 + 工作区层文本"；不满足则红
 *
 * 自证（不改用户任何文件）：两个只读路径可被环境变量覆盖，于是能在临时目录里复现
 * 任意形态并核对脚本自身——
 *   DSH_PS_REAL_USER_FILE=<tmp>/user.json
 *   DSH_PS_REAL_WORKSPACE_FILE=<tmp>/ws.json
 *
 * 退出码：0 = 核对完成（结论如实打印）；1 = 文件缺失/不可解析/配置非法/断言失败。
 * @module dsh-prompt-setting/scripts/real-layers-check
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CUSTOM_SECTION_NAME } from '../core/custom.js';
import { applyOverrides, mergeLayers, validateConfig } from '../core/overrides.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本次 checkout 的仓库根。
 *
 * `PACKAGE_ROOT/../..` 在 `.worktrees/<goal>` 里指向的是 worktree 根，而那里没有
 * 真的工作区层文件；仓库根才有。只读、绝不致命：拿不到 git 就退回相对路径。
 * @returns 绝对仓库根。
 */
function repositoryRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    }).trim().replace(/\/\.git$/, '');
  } catch {
    return join(PACKAGE_ROOT, '..', '..');
  }
}

/** 保留段条目（没有则 `undefined`）。 */
function reservedOf(config) {
  return config.overrides.find((entry) => entry.name === CUSTOM_SECTION_NAME);
}

/** 一个条目声明的模式：`append` 是叠加，其余（含缺字段）都是覆盖。 */
function modeOf(entry) {
  return entry?.action === 'append' ? 'append' : 'replace';
}

/** 一个条目的文本（非字符串按空处理，只用于字符数展示）。 */
function textOf(entry) {
  return typeof entry?.text === 'string' ? entry.text : '';
}

const realUserPath = process.env.DSH_PS_REAL_USER_FILE
  ?? join(homedir(), '.dsh', 'prompt-setting', 'overrides.json');
const realWorkspacePath = process.env.DSH_PS_REAL_WORKSPACE_FILE
  ?? join(repositoryRoot(), '.dsh-prompt-setting', 'overrides.json');

for (const path of [realUserPath, realWorkspacePath]) {
  if (!existsSync(path)) {
    console.error(`[g-057/g-058 真机核对] 文件不存在：${path}`);
    process.exit(1);
  }
}

let userConfig;
let workspaceConfig;
try {
  userConfig = validateConfig(JSON.parse(readFileSync(realUserPath, 'utf8')));
  workspaceConfig = validateConfig(JSON.parse(readFileSync(realWorkspacePath, 'utf8')));
} catch (error) {
  console.error(`[g-057/g-058 真机核对] 配置无法解析/校验：${error?.message ?? error}`);
  process.exit(1);
}

const userEntry = reservedOf(userConfig);
const workspaceEntry = reservedOf(workspaceConfig);
const userText = textOf(userEntry);
const workspaceText = textOf(workspaceEntry);
const userMode = modeOf(userEntry);
const workspaceMode = modeOf(workspaceEntry);
const workspaceBlank = workspaceText.trim() === '';
const userBlank = userText.trim() === '';
/** 2026-10-10 出问题的生产形态：用户层有文本，工作区层保留段是空 `replace`。 */
const productionShape = userText.length > 0 && workspaceBlank;

// 真实的两层，走宿主真实的合并＋装配核。
const liveMerged = mergeLayers(userConfig, workspaceConfig);
const liveEntry = reservedOf({ overrides: liveMerged.overrides });
const liveApplied = applyOverrides([{ name: CUSTOM_SECTION_NAME, text: '' }], liveMerged);
const liveEffective = liveApplied.sections.find((section) => section.name === CUSTOM_SECTION_NAME);

// g-058：用真机两层的**文本**合成一份「工作区层选叠加」的配置，走同一条核。
// 这份配置只存在于内存里，绝不写回任何真机文件。
const stackedConfig = validateConfig({
  version: 1,
  overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: workspaceText }],
});
const stackedMerged = mergeLayers(userConfig, stackedConfig);
const stackedEntry = reservedOf({ overrides: stackedMerged.overrides });
const stackedApplied = applyOverrides([{ name: CUSTOM_SECTION_NAME, text: '' }], stackedMerged);
const stackedEffective = stackedApplied.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
const stackedText = stackedEntry?.text ?? '';
const expectedStacked = userBlank
  ? workspaceText
  : workspaceBlank
    ? userText
    : `${userText}\n\n${workspaceText}`;
/** 真机两层的真实预期：工作区层选叠加时应当装配出的文本。 */
const workspaceStacks = workspaceMode === 'append';

console.log('[g-057/g-058 真机核对] 全程只读');
console.log(`  user 文件        : ${realUserPath}`);
console.log(`  workspace 文件   : ${realWorkspacePath}`);
console.log(`  user 层保留段    : action=${userEntry?.action ?? '(无)'} mode=${userMode} chars=${[...userText].length}`);
console.log(`  ws   层保留段    : action=${workspaceEntry?.action ?? '(无)'} mode=${workspaceMode} chars=${[...workspaceText].length} text=${JSON.stringify(workspaceText)}`);
console.log(`  merged 层归属    : ${JSON.stringify(liveEntry?.layer ?? null)}`);
console.log(`  merged 文本      : chars=${[...(liveEntry?.text ?? '')].length}`);
console.log(`  装配后文本       : chars=${[...(liveEffective?.text ?? '')].length}`);
console.log(`  叠加预期(合成)   : mode=append chars=${[...stackedText].length}（user ${[...userText].length} + 空行 + ws ${[...workspaceText].length}）`);
console.log(`  叠加装配后文本   : chars=${[...(stackedEffective?.text ?? '')].length}`);
console.log(`  生产形态(ws 空)  : ${productionShape ? '是——g-057 修复的直接对象' : '否'}`);
console.log(`  ws 层模式        : ${workspaceStacks ? 'append（叠加）——真机已按 g-058 选了两段都生效' : 'replace（覆盖）——真机当前只生效一层'}`);

let failed = false;
const fail = (message) => {
  console.error(`[g-057/g-058 真机核对] 失败：${message}`);
  failed = true;
};

// ① g-058：合成的「叠加」必须恰好是 用户层文本 + 一个空行 + 工作区层文本（单层为空
// 时不留孤立空行）。这是本次修复要保证的语义，在任何真机内容下都必须成立。
if (stackedText !== expectedStacked) {
  fail(`合成叠加的文本不等于预期（${JSON.stringify(stackedText)} vs ${JSON.stringify(expectedStacked)}）`);
}
if (stackedEffective?.text !== stackedText) {
  fail('合成叠加经 applyOverrides 后与 merged 文本不一致');
}
if (stackedApplied.report.skipped.length > 0) {
  fail(`合成叠加被跳过：${JSON.stringify(stackedApplied.report.skipped)}`);
}
if (stackedMerged.overrides.filter((entry) => entry.name === CUSTOM_SECTION_NAME).length > 1) {
  fail('叠加产生了同名的第二条保留段');
}
const stackedIsSingle = stackedMerged.overrides.length === (userBlank && workspaceBlank ? 0 : 1)
  || stackedMerged.overrides.some((entry) => entry.name !== CUSTOM_SECTION_NAME);
if (!stackedIsSingle) fail('叠加把保留段拆成了多条');

// ② g-057：空值＝该层不声明。工作区层为空时，装配必须回退到用户层文本。
if (productionShape && liveEffective?.text !== userText) {
  fail('工作区层保留段为空，装配结果却不是用户层文本');
}

// ③ 真实装配必须与真机模式自洽：
//    ws append + 两层非空 ⇒ 用户层文本 + 空行 + 工作区层文本；
//    ws 非空且覆盖 ⇒ 工作区层文本；ws 空 ⇒ 用户层文本。
const liveExpected = workspaceStacks
  ? expectedStacked
  : workspaceBlank
    ? userText
    : workspaceText;
if (liveEffective?.text !== liveExpected) {
  fail(`真机装配文本与模式不自洽（${JSON.stringify(liveEffective?.text ?? null)} vs ${JSON.stringify(liveExpected)}）`);
}
if (!workspaceStacks && liveEntry?.layer !== (workspaceBlank ? 'user' : 'workspace')) {
  fail(`覆盖模式下 merged 层归属异常：${JSON.stringify(liveEntry?.layer ?? null)}`);
}

const requireFallback = process.argv.includes('--require-fallback');
if (requireFallback && !productionShape) {
  fail('--require-fallback 要求工作区层保留段为空（生产形态），当前不满足');
}
const requireAppend = process.argv.includes('--require-append');
if (requireAppend && !workspaceStacks) {
  fail('--require-append 要求工作区层保留段是叠加（append），当前不满足');
}

console.log('  ⇒ 叠加语义：' + (stackedText === expectedStacked
  ? `成立（装配文本 = user 文本 + 一个空行 + ws 文本，单条保留段，无跳过）`
  : '不成立（见上方失败行）'));
if (productionShape) {
  console.log('  ⇒ g-057：工作区层保留段为空，装配生效的是用户层文本');
}
if (workspaceStacks) {
  console.log(`  ⇒ g-058：真机工作区层已选叠加，装配同时包含两段（chars=${[...liveEffective?.text ?? ''].length}）`);
} else {
  console.log('  ⇒ g-058：真机工作区层当前是覆盖，故只生效一层；'
    + `把该层模式改成「叠加」后，装配文本将是上面的「叠加预期」（chars=${[...stackedText].length}）`);
}

process.exit(failed ? 1 : 0);
