#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的 `prepare` 钩子 — pnpm 在 **从 git 安装之后**运行它。
 *
 * 为什么要有这个脚本：`dsh plugin --profile demo add github:you/repo` 这条路，
 * 官方发布文档称之为「从 GitHub 安装：构建脚本这道坎」—— 插件作者必须自己保证
 * 装到用户机器上的东西是完整的。
 *
 * 本包是零构建包（`index.js` / `client.js` / `core/*.js` 本身就是发布入口），所以这道坎
 * 在这里不是「编译」，而是**打包**：本机实测（pnpm 12.3.4，2026-09-30）
 *   pnpm add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
 * 装到 `node_modules` 里的**恰好是 `files` 白名单**加上 npm 永远保留的两项
 * （`package.json`、`LICENSE`）—— `test/`、`.dsh-graph/` 都不在，体积与 `npm pack`
 * 一致（968K vs 958.2 kB），而不是整个 checkout。于是真正的风险是反方向的：
 * **声明了、但没被白名单覆盖（或压根没提交）的文件，在用户机器上一定不存在**，
 * 而失败会在 `dsh` 启动时才以模块解析错误的形式炸出来。
 *
 * 所以这里在**安装现场**证明这个 checkout 装得住：所有声明入口都在、且都在 `files`
 * 白名单里，bundle patch 的每一行都能在本包解析，构建戳区间可用。结论只依赖包目录里的
 * 字节：不看 monorepo、不联网、不用 git、不读时钟。
 *
 * 与 `scripts/check-compat.mjs` 的区别：那个是**诊断**，退出码恒 0；这个是**门禁**，
 * 不通过的 checkout 会以非零退出码让安装失败 —— 这正是我们要的：宁可装不上，
 * 也不要装上一个起不来的插件。
 *
 * 用法：`node scripts/prepare.mjs`（`pnpm install` 与 git 安装会自动触发）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREPARE_FAIL, PREPARE_OK, PREPARE_WARN, inspectPackage } from '../core/prepare.js';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 读一个文件，绝不抛。
 * @param relPath - 相对包根的路径。
 * @returns 文件文本，或 null。
 */
function readText(relPath) {
  const path = resolve(PACKAGE_DIR, relPath);
  // 拒绝逃出包根：manifest 里写 `../x` 不是「本包的内容」，不该被算作可用入口。
  if (path !== PACKAGE_DIR && !path.startsWith(PACKAGE_DIR + sep)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 列一个目录的条目，绝不抛。
 * @param relPath - 相对包根的路径。
 * @returns 条目名数组，或 null。
 */
function listDir(relPath) {
  const path = resolve(PACKAGE_DIR, relPath);
  if (path !== PACKAGE_DIR && !path.startsWith(PACKAGE_DIR + sep)) return null;
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

/** 输出缓冲：先收集，最后一次性打印，避免半截输出。 */
const out = [];
const say = (text = '') => { out.push(text); };

say('[dsh-prompt-setting] prepare：发布就绪自检（本包零构建，不做编译）');
say('');

const manifestText = readText('package.json');
let pkg = null;
let manifestError = null;
if (manifestText === null) manifestError = '读不到 package.json';
else {
  try {
    pkg = JSON.parse(manifestText);
  } catch (error) {
    manifestError = `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
  }
}

const { ok, findings } = inspectPackage({ pkg, readText, listDir });
const label = { [PREPARE_OK]: 'ok  ', [PREPARE_WARN]: 'warn', [PREPARE_FAIL]: 'FAIL' };
for (const finding of findings) say(`  ${label[finding.level] ?? finding.level}  ${finding.code}: ${finding.message}`);
if (manifestError !== null) say(`  FAIL  MANIFEST-UNREADABLE: ${manifestError}`);

const passed = findings.filter((finding) => finding.level === PREPARE_OK).length;
const warned = findings.filter((finding) => finding.level === PREPARE_WARN).length;
const failed = findings.filter((finding) => finding.level === PREPARE_FAIL).length + (manifestError === null ? 0 : 1);

say('');
if (failed === 0 && manifestError === null) {
  say(`prepare：OK（${passed} 项通过${warned > 0 ? `，${warned} 项提示` : ''}）—— 源码目录自包含，装完即可加载`);
} else {
  say(`prepare：失败（${failed} 项）—— 这个 checkout 装上去会缺东西，先修好再安装`);
  say('提示：这些检查只读包目录。文件真的存在于你的工作副本里却报缺失，只有两种可能——');
  say('      ① 没进 git（被忽略或忘了提交）；② 在 git 里，但没被 package.json 的 files 白名单覆盖。');
  say('      git 安装给用户的是「仓库内容 ∩ files 白名单」（外加 npm 永远保留的 package.json 与 LICENSE）。');
}

for (const line of out) console.log(line);
if (failed > 0 || manifestError !== null) process.exitCode = 1;