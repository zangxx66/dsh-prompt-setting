#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 兼容性自检 — `node scripts/check-compat.mjs`
 *
 * 为什么有这个脚本：主管在本机的临时 profile 里实测了四种 boot 失败形态，其中
 * **形态②（patch 文件里的未知 verb）平台完全没有输出** —— 插件静默不激活、终端一行
 * 都没有，这是最糟的一种：没有任何信号告诉用户「哪里错了」。插件内代码此时一行都没
 * 执行，任何「在插件里加 try/catch」的补救都无效，所以补的是这个**插件外**的只读诊断
 * 脚本（形态①③④ 平台至少有输出，这里的签名表用于逐字比对）。
 *
 * 它做什么（全部只读、**不联网**、**永不抛**）：
 *   1. 打印本插件版本、`peerDependencies` 里声明的 DSH 范围、探测到的 DSH 版本与来源；
 *   2. 给出「范围内 / 超范围 / 无法探测」的结论；
 *   3. 列出四种 boot 失败形态的判定指引，含**可逐字比对的终端签名**；
 *   4. 给出救援步骤（`--dump-config` / `--patch` / 摘掉 bundle / `dsh rescue`）；
 *   5. 用**真实的文案构造函数**打印本插件会说的那几条消息（不是手抄的副本，故不会漂移）。
 *
 * 永不抛：任何一步失败就打印一行说明并继续；退出码恒为 0（这是诊断，不是门禁）。
 *
 * 用法：`node scripts/check-compat.mjs`（在插件包里；随包发布，见 package.json 的 `files`）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（本文件在 `scripts/` 下）。 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 输出缓冲：先收集，最后一次性打印，避免某一步失败留下半截输出。 */
const out = [];
/** 追加一行。 */
const say = (text = '') => { out.push(text); };

/**
 * 读一个文件，绝不抛。
 * @param path - 绝对路径。
 * @returns 文件文本，或 null。
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 取一行错误的文字，绝不抛。
 * @param error - 任意抛出值。
 * @returns 一行说明。
 */
function causeOf(error) {
  try {
    const text = error instanceof Error ? error.message : String(error);
    const line = String(text).split('\n')[0].trim();
    return line.length > 0 ? line : String(error);
  } catch {
    return '未知错误';
  }
}

/** 1. 本插件自身的版本与 peer 范围（读自己的 package.json，读不到就明说）。 */
function reportPlugin() {
  const text = readText(join(PLUGIN_DIR, 'package.json'));
  if (text === null) {
    say('插件：无法读取 package.json（安装不完整？）');
    return { name: 'dsh-prompt-setting', version: '未知', range: null };
  }
  const manifest = JSON.parse(text);
  const name = typeof manifest.name === 'string' ? manifest.name : 'dsh-prompt-setting';
  const version = typeof manifest.version === 'string' ? manifest.version : '未知';
  const range = manifest?.peerDependencies?.['@deepseek-ai/dsh'] ?? null;
  say(`插件：${name} ${version}`);
  say(`期望的 DSH 范围（peerDependencies['@deepseek-ai/dsh']）：${range ?? '（manifest 未声明）'}`);
  return { name, version, range };
}

/**
 * 2. 载入纯函数内核并探测已装 DSH。核心逻辑复用包内实现，不在脚本里重写一份。
 * @param range - `reportPlugin` 读到的范围。
 * @returns `{compat, detection, verdict}`（`compat` 为 null 表示内核都载不进来）。
 */
async function reportDetection(range) {
  let compat = null;
  try {
    compat = await import(new URL('../core/compat.js', import.meta.url).href);
  } catch (error) {
    say(`已装 DSH：无法探测（core/compat.js 载入失败：${causeOf(error)}）`);
    say('结论：无法确认兼容性——把本包重新安装一遍通常就能修好。');
    return { compat: null, detection: null, verdict: '无法确认（内核载入失败）' };
  }
  let detection;
  try {
    detection = compat.detectDshVersion({ moduleDir: PLUGIN_DIR });
  } catch (error) {
    say(`已装 DSH：无法探测（探测过程出错：${causeOf(error)}）`);
    say('结论：无法确认兼容性（探测失败）——这不影响 DSH 启动。');
    return { compat, detection: null, verdict: '无法确认（探测失败）' };
  }
  if (detection.version === null) {
    say('已装 DSH：无法探测');
    say(`探测结果：${detection.reason ?? '未知原因'}`);
    say(`探测锚点：${detection.candidates.length} 个候选里没有可读的 @deepseek-ai/dsh/package.json`);
    say('结论：无法确认兼容性（探测失败）——插件仍会加载，但兼容性未经校验。');
    say('      可用 DSH_INSTALL_ROOT=<DSH 安装根> 再跑一次本脚本。');
    return { compat, detection, verdict: '无法确认（探测失败）' };
  }
  say(`已装 DSH：${detection.version}`);
  say(`来源：${detection.source}`);
  const satisfied = range === null ? null : compat.satisfiesRange(detection.version, range);
  if (satisfied === true) {
    say('结论：兼容（在已测试范围内）');
    return { compat, detection, verdict: '兼容' };
  }
  if (satisfied === false) {
    say('结论：不兼容（超出已测试范围）——插件可能加载失败或行为异常；DSH 本身仍会启动。');
    say('      救援见下面第 4 节（`--patch` 覆盖 或 临时摘掉 bundle）。');
    return { compat, detection, verdict: '不兼容（超出已测试范围）' };
  }
  say('结论：无法判断（范围语法本脚本不支持，或 manifest 未声明范围）——请人工核对上面的范围。');
  return { compat, detection, verdict: '无法判断' };
}

/** 3. 四种 boot 失败形态 × 终端签名（逐字来自主管在本机临时 profile 的实测）。 */
function reportFailureForms() {
  say('─'.repeat(72));
  say('DSH boot 失败形态与终端签名（逐字；<id>/<name>/<service>/<message> 是占位符，其余原样比对）');
  say('');
  say('① import 期抛错（插件文件本身坏了）——DSH 仍启动（照常打印 web URL）：');
  say('     dsh: warning: 1 entry did not activate');
  say('     <id> (<name>): failed to import');
  say('   判定：终端出现 "failed to import" 即这一形态。插件里的代码一行都没执行，');
  say('         插件内无法自救 —— 只能看本脚本第 1/2 节 + 修插件本身。');
  say('');
  say('② patch 文件语法/schema 问题（例如未知 verb `insertt:`）——DSH 仍启动，但：');
  say('     （终端没有任何输出）');
  say('   判定：插件没出现、终端一行都没有 ⇒ 先怀疑这一形态（**平台不报，最糟**）。');
  say('         失败发生在 profile 组合层，早于本插件任何代码 ⇒ 插件无法自救。');
  say('         定位：第 4 节的 `--dump-config`。');
  say('');
  say('③ inject 的服务不存在——DSH 仍启动：');
  say('     <id> (<name>): pending (waiting for service: <service>)');
  say('   判定：终端出现 "pending (waiting for service:" ⇒ 本插件的 apply 根本不会执行');
  say('         （Cordis 等服务齐了才调用它），插件内无法捕获这一种。');
  say('');
  say('④ apply 期抛错——DSH 仍启动：');
  say('     <id> (<name>): Error: <message>');
  say('     …完整堆栈（含 #<id> 与 #include 帧），**没有任何指引**');
  say('⑤ 平台自己的 bundle 兼容性闸门（**比本插件更早**，主管 2026-09-29 实测）——DSH 仍启动：');
  say('     dsh: skipping profile bundle "<name>": Error: Plugin <name>@<ver> is incompatible with dsh <ver>:');
  say('     peerDependencies {"@deepseek-ai/dsh":"<range>"}. Running it may cause crashes and data loss. …');
  say('     dsh web: http://127.0.0.1:<port>/?token=…');
  say('   判定：profile 的 dsh.profile.bundles 里这一条被整条跳过、终端点名 ⇒ 本包**没有被 import**，');
  say('         连我们的导入期自检都不会跑（所以「超范围」时看到的是它，不是我们的那条）。');
  say('         安装期（dsh plugin add / plugin manager）用同一套检查，会拒绝并给出 `dsh plugin allow-version` 豁免指引。');
  say('');
  say('   判定：本插件 0.1.x 起 apply 全程自带 try/catch，失败会先撤销已注册的 effect，');
  say('         再打印一条 [dsh-prompt-setting] …挂载失败… 的可读信息，不再出现本插件的裸堆栈。');
}

/** 4. 救援步骤（`--patch` / `--dump-config` / 摘 bundle / rescue profile 都已对过 `dsh --help`）。 */
function reportRescue() {
  say('─'.repeat(72));
  say('救援步骤（先只读诊断，再决定动不动 profile；改 profile 需要重启 `dsh web`）');
  say('');
  say('0. 终端消息在哪看：`dsh web` 的**前台输出**（启动时那一行 web URL 也在同一处）。');
  say('   Web UI 的设置页看不到 boot 期消息，所以排查 boot 问题必须看启动终端。');
  say('');
  say('1. 只读看组合结果（不启动、不改任何东西）：');
  say('     dsh --profile <name> --dump-config          # 组合后的 profile 树');
  say('     dsh --profile <name> --dump-default-config  # 不含用户层与 --patch 的结果（对比用）');
  say('     dsh --profile <name> --dump-config-schema   # 条目/补丁的 JSON Schema');
  say('   在本插件这一条上确认：条目是否存在、patch 是否被正确组合（形态② 在这里暴露）。');
  say('   （不带 --profile 即默认 profile。）');
  say('');
  say('2. 用 --patch 覆盖（可重复，叠加在 profile 层之后，最小改动）：');
  say('     dsh web --patch ./off.yml');
  say('   在 off.yml 里按 Loader 方言关掉/覆盖本插件对应的条目；');
  say('   写 patch 前先 `dsh --profile web --dump-config-schema` 对一遍字段。');
  say('');
  say('3. 临时从 profile 的 bundles 里摘掉本包（需要重启 `dsh web`）：');
  say('     编辑 $DSH_HOME/profiles/<name>/package.json → dsh.profile.bundles 去掉 dsh-prompt-setting');
  say('   （`dsh plugin --profile <name> remove dsh-prompt-setting` 也会改 profile，慎用。）');
  say('');
  say('4. 兜底：用一个干净的 rescue profile（不含任何自定义 bundle）先把 DSH 启动起来：');
  say('     dsh rescue --from-default-profile web');
  say('');
  say('5. 修好之后：宿主半（index.js / core/**）必须重启 `dsh web` 才生效；');
  say('   客户端半（client.js）由 DSH 自带 HMR 热替换，一般不用重启。');
}

/**
 * 5. 本插件自己会说的消息 —— 用真实的文案构造函数打印，所以不会与代码漂移。
 * @param compat - `core/compat.js` 模块（可能为 null）。
 * @param plugin - 插件名与版本。
 */
function reportOwnMessages(compat, plugin) {
  say('─'.repeat(72));
  say('本插件自己的终端消息长什么样（范围内时**完全静默**，这是设计）');
  say('');
  if (compat === null) {
    say('（core/compat.js 载入失败，无法打印本插件的消息模板）');
    return;
  }
  const base = {
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    expectedRange: plugin.range ?? '（manifest 未声明）',
  };
  say('导入期 · 超范围（一条）—— ⚠️ 在 DSH 0.1.7-rc.2 / 0.2.0 上**轮不到它**：');
  say('  平台会先跳过整个 bundle 并点名（逐字签名：`dsh: skipping profile bundle "<name>": Error: Plugin');
  say('  <name>@<ver> is incompatible with dsh <ver>: peerDependencies …`），本包根本不会被 import；');
  say('  看到下面这条，才说明平台的闸门没生效（更老的/改过的宿主）。保留它是兜底/防御纵深：');
  say(`  ${compat.compatibilityMessage({ ...base, version: '0.2.1-0', reason: null })}`);
  say('');
  say('导入期 · 探测失败（一条）：');
  say(`  ${compat.compatibilityMessage({ ...base, version: null, reason: '<探测失败原因>' })}`);
  say('');
  say('apply 期 · 挂载失败（一条，含清理结果）：');
  say(`  ${compat.mountFailureMessage({ ...base, dshVersion: '<版本或 null>', cause: '<首因首行>', disposed: 1, disposeFailures: 0 })}`);
  say('  注：这一条**同时**写终端（stderr）与 ctx.logger.error —— 本 profile 里 ctx.logger 没有终端出口');
  say('      （唯一 exporter 只把 warn/error 收进 startupLogs，而它只在启动失败时才被打印），');
  say('      所以只看 UI 日志是看不到它的；排查请直接看 `dsh web` 的前台输出。');
  say('  注：本插件在 apply 失败后**不**把异常抛回 loader —— 形态④ 的裸堆栈因此不会出现；');
  say('      代价是本插件的 fiber 保持 active 但零 effect（插件列表里仍显示已启用）。');
  say('');
  say('客户端半 · 加载失败（`console.error`，一条）：');
  say(`  [${plugin.name}] 客户端半加载失败：设置页将以降级提示卡呈现，DSH 其余功能不受影响。首因：<原因>。排查见 README「出问题时」。`);
}

/** 主流程：任何一步失败都只打印一行，退出码恒为 0。 */
async function main() {
  say(`dsh-prompt-setting 兼容性自检（只读、不联网）  node ${process.version}`);
  say(`插件目录：${PLUGIN_DIR}`);
  say('─'.repeat(72));
  let plugin = { name: 'dsh-prompt-setting', version: '未知', range: null };
  try {
    plugin = reportPlugin();
  } catch (error) {
    say(`插件：读取 package.json 失败：${causeOf(error)}`);
  }
  let probed = { compat: null, detection: null, verdict: '无法确认（探测失败）' };
  try {
    probed = await reportDetection(plugin.range);
  } catch (error) {
    say(`已装 DSH：探测失败：${causeOf(error)}`);
  }
  reportOwnMessages(probed.compat, plugin);
  reportFailureForms();
  reportRescue();
  say('─'.repeat(72));
  say(`自检完成：${probed.verdict}。本脚本只读、永不抛，退出码恒为 0（这是诊断，不是门禁）。`);
}

try {
  await main();
} catch (error) {
  // 真的什么都不该抛；万一抛了，也必须留下可读的一行。
  say(`自检脚本自身出错（这不影响 DSH 启动）：${causeOf(error)}`);
}
process.stdout.write(`${out.join('\n')}\n`);
