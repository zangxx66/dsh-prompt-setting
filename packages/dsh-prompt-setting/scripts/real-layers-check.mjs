#!/usr/bin/env node
/**
 * g-057 真机数据核对（只读、一次性、**不属于 `node --test` 套件**）。
 *
 * 为什么要单独一个脚本，而不是一条测试：这个核对读的是**这台机器上负责人自己的
 * 两份活配置文件**（`~/.dsh/prompt-setting/overrides.json` 与
 * `<repo>/.dsh-prompt-setting/overrides.json`），而它们会被随时编辑。把它写成测试
 * 只有两种结局——文件被编辑时**假红**（评审实测过：负责人改了工作区层那条，全量
 * 立刻 1 fail），或者文件缺失时**恒绿且不计数**（clone/CI 上完全没有约束力）。两者
 * 都是"测试依赖外部可变状态"，所以真机核对留在测试套件之外：套件里只留合成夹具
 * （`test/overrides.test.mjs` 与 `test/route.test.mjs` 的 5 个 g-057 用例）。
 *
 * 本脚本读 **宿主自己的纯函数核**（`core/overrides.js` 的 `mergeLayers` /
 * `applyOverrides`），因此验证的是真实代码路径；`/prompt-setting/*` 路由需鉴权
 * （401），不能用 curl 取，这正是改走纯函数的原因。**全程只读，不写任何文件。**
 *
 * 用法：
 *   node scripts/real-layers-check.mjs                 # 打印真机证据
 *   node scripts/real-layers-check.mjs --require-fallback
 *       # 仅当工作区层保留段为空（即 2026-10-10 出问题的生产形态）时断言"回退到
 *       # 用户层文本"；工作区层非空时只断言优先级，退出码仍为 0（不因真机内容变化而红）
 *
 * 自证（不改用户任何文件）：两个只读路径可被环境变量覆盖，于是能在临时目录里复现
 * "生产形态"并核对脚本自身——
 *   DSH_PS_REAL_USER_FILE=<tmp>/user.json
 *   DSH_PS_REAL_WORKSPACE_FILE=<tmp>/ws.json   （其中保留段 text 为 ""）
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

const realUserPath = process.env.DSH_PS_REAL_USER_FILE
  ?? join(homedir(), '.dsh', 'prompt-setting', 'overrides.json');
const realWorkspacePath = process.env.DSH_PS_REAL_WORKSPACE_FILE
  ?? join(repositoryRoot(), '.dsh-prompt-setting', 'overrides.json');

for (const path of [realUserPath, realWorkspacePath]) {
  if (!existsSync(path)) {
    console.error(`[g-057 真机核对] 文件不存在：${path}`);
    process.exit(1);
  }
}

let userConfig;
let workspaceConfig;
try {
  userConfig = validateConfig(JSON.parse(readFileSync(realUserPath, 'utf8')));
  workspaceConfig = validateConfig(JSON.parse(readFileSync(realWorkspacePath, 'utf8')));
} catch (error) {
  console.error(`[g-057 真机核对] 配置无法解析/校验：${error?.message ?? error}`);
  process.exit(1);
}

const userEntry = reservedOf(userConfig);
const workspaceEntry = reservedOf(workspaceConfig);
const userText = typeof userEntry?.text === 'string' ? userEntry.text : '';
const workspaceText = typeof workspaceEntry?.text === 'string' ? workspaceEntry.text : '';
const workspaceBlank = workspaceText.trim() === '';
/** 2026-10-10 出问题的生产形态：用户层有文本，工作区层保留段是空 `replace`。 */
const productionShape = userText.length > 0 && workspaceBlank;

// 真实的两层，走宿主真实的合并＋装配核。
const liveMerged = mergeLayers(userConfig, workspaceConfig);
const liveEntry = reservedOf({ overrides: liveMerged.overrides });
const liveApplied = applyOverrides([{ name: CUSTOM_SECTION_NAME, text: '' }], liveMerged);
const liveEffective = liveApplied.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
const expectedLayer = workspaceBlank ? 'user' : 'workspace';
const expectedText = workspaceBlank ? userText : workspaceText;

console.log('[g-057 真机核对] 全程只读');
console.log(`  user 文件      : ${realUserPath}`);
console.log(`  workspace 文件 : ${realWorkspacePath}`);
console.log(`  user 层保留段  : action=${userEntry?.action ?? '(无)'} chars=${[...userText].length}`);
console.log(`  ws   层保留段  : action=${workspaceEntry?.action ?? '(无)'} text=${JSON.stringify(workspaceText)} chars=${[...workspaceText].length}`);
console.log(`  merged 层归属  : ${JSON.stringify(liveEntry?.layer ?? null)}`);
console.log(`  merged 文本    : chars=${[...(liveEntry?.text ?? '')].length}`);
console.log(`  装配后文本     : chars=${[...(liveEffective?.text ?? '')].length}`);
console.log(`  生产形态(ws 空): ${productionShape ? '是——本次修复的直接对象' : '否——真机 ws 层已有非空文本'}`);

let failed = false;
if (userEntry?.action === 'replace') {
  // 优先级（Revision 35 未移动它）在任何真机内容下都必须成立。
  if (liveEntry?.layer !== expectedLayer || liveEntry?.text !== expectedText) {
    console.error(`[g-057 真机核对] 失败：期望 layer=${expectedLayer}，实得 ${liveEntry?.layer}`);
    failed = true;
  }
  if (liveEffective?.text !== expectedText) {
    console.error('[g-057 真机核对] 失败：装配结果既不是用户层文本也不是工作区层文本');
    failed = true;
  }
}

const requireFallback = process.argv.includes('--require-fallback');
if (requireFallback && !productionShape) {
  console.error('[g-057 真机核对] --require-fallback 要求工作区层保留段为空（生产形态），当前不满足');
  failed = true;
}

if (productionShape) {
  console.log('  ⇒ 工作区层保留段为空，装配生效的是用户层文本（g-057 修复的直接证据）');
} else {
  console.log('  ⇒ 工作区层保留段非空，按既有优先级覆盖用户层（Revision 35 未改优先级）');
  console.log('     想要"空值回退"的直接证据，可临时把工作区层那条改成 "text": "" 再跑一次');
  console.log('     （或直接看 NOTES §131 里 2026-10-10 的原始输出，那时它确实是 ""）');
}

process.exit(failed ? 1 : 0);
