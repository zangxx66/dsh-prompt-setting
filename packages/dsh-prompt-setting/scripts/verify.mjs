#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的**发布前 verify** — 一条命令跑齐「全量测试 + 四道门禁 +
 * 文档引用体检」，并在**一次运行里**报出所有问题。
 *
 * 为什么需要这个脚本：本项目**没有 CI**。段集合合规的机器校验目前全在**开发侧** ——
 * `test/client-source.test.mjs` 写死的坐标表、`docs/check-refs.mjs`（§5.1 文档表 vs
 * 磁盘 `src/`）以及全量用例。发布者发布前不跑测试时，这些校验形同不存在；G-077 之后
 * `prepare` 的 `CLIENT-SRC-DRIFT` 只管「`src/` ↔ 磁盘产物」是否一致，**管不了「段集合
 * 本身被有意改动」**（`--write` 一跑，锚就跟着移动）。所以补的是这条**发布者侧**的
 * 聚合命令，而不是往 `prepare`（安装现场门禁）里塞手工清单。
 *
 * 与 `scripts/prepare.mjs` 的分工：
 *   - `prepare` = **安装现场**门禁（消费者机器上跑，判「装到的包自洽」：入口 / files /
 *     chunk 清单 / 词典 / 段↔产物字节一致）。它只读包目录，不看文档、不看测试。
 *   - `verify`   = **发布者侧**门禁（本仓库 checkout 里、发布前跑，判「仓库状态合规」：
 *     全量测试 + 四道门禁 + `docs/check-refs.mjs`）。它需要 `test/` 与 `docs/` —— 这两者
 *     都不在 `files` 白名单里，所以 verify 在安装后的包里**不适用**，这是有意的。
 *
 * 设计要点：
 *   1. **聚合报告、不 fail-fast**：每步跑完再跑下一步，任一步失败**也继续跑完剩余步骤**，
 *      最后一次看到全部问题；末尾统一汇总。
 *   2. **cwd 无关**：所有路径都从 `import.meta.url` 推导包根，子进程的 `cwd` 固定为包根
 *       —— 于是「在包目录跑 `npm run verify`」与「在仓库根跑
 *      `node packages/dsh-prompt-setting/scripts/verify.mjs`」结果一致。
 *   3. **零依赖、零 shell**：`spawnSync(process.execPath, [...])`，不经过 shell。`test/`
 *      的用例文件由 {@link listTestFiles} `readdirSync` 展开 —— 因为 `spawnSync` 不做
 *      glob 展开（`test/*.test.mjs` 会被当成字面量传给 Node，而 Node 的 `--test` 也不展开
 *      glob），且 Node 24 下 `node --test test/` 会把目录当模块解析并报 `MODULE_NOT_FOUND`
 *      （`docs/refactor-plan.md` 有实测记录）。显式文件列表是唯一与 shell/Node 版本都无关
 *      的写法。
 *   4. **退出码只有 0 / 1**：全部通过 = 0；任一失败 = 1。不用 2 等其它码，避免与
 *      「参数写错」类退出码混淆。
 *   5. **失败详情只给尾部**：失败步骤打印退出码 + **stderr 尾部若干行**（stderr 为空时退
 *      到 stdout 尾部，例如 `check-refs` 把不符项写在 stdout）；不倾倒全量输出 —— 测试套件
 *      成功时也有上千行。
 *   6. **不静默、不挂死**：`test/` 里出现不符合 `*.test.mjs` 命名的 `.mjs` 文件 ⇒ verify 红并
 *      点名（静默漏跑一个测试文件 = 防线有洞却不报警）；安装现场误跑（没有 `test/`）⇒ 一句
 *      说明 + exit 1（不抛 ENOENT 堆栈）；单步 15 分钟上限（挂死也算一次失败）。
 *
 * 步骤清单（基础 → 派生、快 → 慢；`test` 最慢，放最后）：
 *   `check-refs` → `client-build --check` → `locale-pack --check` → `prepare` →
 *   `check-compat` → 全量测试。
 *   - `scripts/real-layers-check.mjs` **不纳入**：它读的是负责人这台机器上的两份**活配置
 *     文件**（`~/.dsh/prompt-setting/overrides.json` 与仓库工作区层）并自带一次性证据核对，
 *     脚本头部已写明「不属于测试套件」；干净 checkout / 别的机器上文件缺失即 exit 1，
 *     纳入 verify 会让「发布前检查」依赖本机私有数据（假红或恒红），故排除。理由同样记在
 *     `NOTES.md` §160。
 *   - `check-compat` 保留：它是只读诊断、退出码恒 0，**不构成门禁**，但发布前一次性看到
 *     兼容性结论（peer 范围 / boot 失败签名）比事后翻文档省事；若它崩了（自身抛错仍
 *     兜底 exit 0）不会挡住发布。
 *
 * 随包发布（`files` 白名单含 `scripts/`），但如上所述需要 `test/` 与 `docs/`，所以只在
 * **仓库 checkout** 里有意义 —— 调用位置见 `README.md`「发布前 verify」。
 *
 * 用法：
 *   npm run verify                     # 在 packages/dsh-prompt-setting/ 下
 *   node packages/dsh-prompt-setting/scripts/verify.mjs   # 在仓库根
 *   node scripts/verify.mjs            # 在包目录
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（本文件在 `scripts/` 下）。`cwd` 无关的来源：一律从这里派生。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** 失败详情里最多展示的输出行数（尾部）。 */
export const TAIL_LINES = 20;

/**
 * 单个步骤的墙钟上限（15 分钟）：全量测试当前 ~60-70s，余量充足。
 *
 * 没有这个上限时，某步挂死（例如 `node --test` 卡在某个用例）会让 verify 永久挂住 ——
 * 发布前检查最不该有的失败形态就是「什么都不说、也不结束」。超时后 `spawnSync` 返回
 * `error.code === 'ETIMEDOUT'`（子进程被信号杀死），{@link stepOk} 判 FAIL，
 * {@link formatFailureDetail} 会把「超时」写进详情。
 */
export const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** 测试用例文件的后缀（与 `test/` 目录约定一致）。 */
const TEST_SUFFIX = '.test.mjs';

/**
 * 把 `test/` 的目录项筛成用例路径列表；存在 **`.mjs` 但不符合 `*.test.mjs` 命名**的文件时
 * **fail-closed 抛错**。
 *
 * 为什么不是静默跳过：verify 是发布前唯一防线，静默漏掉一个测试文件 = 防线有洞却不报警
 * （与项目「不静默」的纪律冲突）。宁可让 verify 红、点名那个文件，也不假装全绿。
 * @param {string[]} entries - `readdirSync(test/)` 的文件名。
 * @returns {string[]} 形如 `test/build.test.mjs` 的路径（已排序）。
 * @throws {Error} 有 `.mjs` 文件不以 {@link TEST_SUFFIX} 结尾时。
 */
export function checkTestFiles(entries) {
  const stray = entries
    .filter((name) => name.endsWith('.mjs') && !name.endsWith(TEST_SUFFIX))
    .sort();
  if (stray.length > 0) {
    throw new Error(
      `test/ 下有不符合 ${TEST_SUFFIX} 命名约定的测试文件：${stray.join('、')}`
        + ` —— verify 只跑 ${TEST_SUFFIX}，静默跳过它们等于漏跑（fail-closed）。`
        + '请改名成 xxx.test.mjs，或把该文件显式加入 scripts/verify.mjs 的 test 步骤并说明原因。',
    );
  }
  return entries
    .filter((name) => name.endsWith(TEST_SUFFIX))
    .sort()
    .map((name) => `test/${name}`);
}

/**
 * 展开 `test/` 下的用例文件，返回相对包根的路径列表（已排序，保证输出稳定）。
 *
 * 为什么不用 glob：`spawnSync` 不经过 shell，`test/*.test.mjs` 不会被展开；Node 的
 * `--test` 也不接受 glob 模式。`readdirSync` 是零依赖且与 shell 无关的展开方式。
 * 非 `*.test.mjs` 的 `.mjs` 文件不会被静默跳过 —— 见 {@link checkTestFiles}。
 * @returns {string[]} 形如 `test/build.test.mjs` 的路径。
 * @throws {Error} 目录不可读，或有命名不符合约定的 `.mjs` 文件。
 */
export function listTestFiles() {
  const entries = readdirSync(join(PACKAGE_DIR, 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return checkTestFiles(entries);
}

/**
 * 当前目录是不是**仓库 checkout**（而不是安装后的包）。
 *
 * `scripts/` 在 `files` 白名单里，所以用户完全可能在装好的包里跑 `verify` —— 那里没有
 * `test/`（也没有 `docs/`），{@link listTestFiles} 会 ENOENT。与其抛堆栈，不如先判定并给
 * 一句人话（安装现场自检请用 `node scripts/prepare.mjs`）。**判定失败仍然 exit 1**：
 * 在安装现场跑错命令不是「通过」。
 * @param {string} [dir] - 待判定的包根（单测注入临时目录）。
 * @returns {boolean} `test/` 存在且其中至少有一个用例文件。
 */
export function looksLikeRepositoryCheckout(dir = PACKAGE_DIR) {
  let entries;
  try {
    entries = readdirSync(join(dir, 'test'));
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith(TEST_SUFFIX));
}

/** 安装现场误跑时给的那句说明（`main` 与 README 共用同一口径）。 */
export const NOT_CHECKOUT_HINT =
  'verify 只在仓库 checkout 里跑：安装后的包没有 test/ 与 docs/（它们不在 files 白名单里）；'
  + '安装现场请用 node scripts/prepare.mjs 自检。';

/**
 * 步骤清单：`{ name, args }`。`args` 传给 `process.execPath`（不经 shell）。
 * @param {string[]} testFiles - {@link listTestFiles} 的结果。
 * @returns {{name: string, args: string[]}[]} 按执行顺序排列的步骤。
 */
export function steps(testFiles) {
  return [
    { name: 'check-refs', args: ['docs/check-refs.mjs'] },
    { name: 'client-build --check', args: ['scripts/client-build.mjs', '--check'] },
    { name: 'locale-pack --check', args: ['scripts/locale-pack.mjs', '--check'] },
    { name: 'prepare', args: ['scripts/prepare.mjs'] },
    { name: 'check-compat', args: ['scripts/check-compat.mjs'] },
    { name: 'test', args: ['--test', ...testFiles] },
  ];
}

/**
 * 跑一个步骤。`spawn` 可注入（单测用假实现，不启动子进程）。
 * @param {{name: string, args: string[]}} step - 步骤定义。
 * @param {typeof spawnSync} spawn - 子进程实现，默认 `node:child_process` 的 `spawnSync`。
 * @returns {{name: string, exitCode: number|null, signal: string|null, ms: number, stdout: string, stderr: string, error: Error|null}} 结果。
 */
export function runStep(step, spawn = spawnSync) {
  const started = Date.now();
  const result = spawn(process.execPath, step.args, {
    // cwd 无关的核心：不管从哪个目录调用 verify，子进程都在包根里跑。
    cwd: PACKAGE_DIR,
    encoding: 'utf8',
    // 全量测试的输出可达数千行；默认 1 MiB 的 maxBuffer 在某些失败形态下会截断。
    maxBuffer: 64 * 1024 * 1024,
    // 某步挂死时不要永久等待：超时后 spawnSync 返回 ETIMEDOUT，stepOk 判 FAIL。
    timeout: STEP_TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  return {
    name: step.name,
    exitCode: typeof result.status === 'number' ? result.status : null,
    signal: result.signal ?? null,
    ms,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

/**
 * 一步是否通过：退出码恰为 0，且没有被信号杀死、也没有 spawn 失败。
 * @param {{exitCode: number|null, signal?: string|null, error?: Error|null}} result - 步骤结果。
 * @returns {boolean} 通过为 `true`。
 */
export function stepOk(result) {
  return result.exitCode === 0 && !result.signal && !result.error;
}

/**
 * 一步结果的一行摘要（纯函数）：`ok    <name>  <ms>ms` / `FAIL  <name>  <ms>ms`。
 * @param {{name: string, exitCode: number|null, signal?: string|null, ms: number, error?: Error|null}} result - 步骤结果。
 * @param {number} [nameWidth] - 步骤名列宽（`padEnd`），用于多行对齐。
 * @returns {string} 一行文本。
 */
export function formatStepLine(result, nameWidth = 0) {
  const label = stepOk(result) ? 'ok' : 'FAIL';
  return `${label.padEnd(6)}${result.name.padEnd(nameWidth)}  ${result.ms}ms`;
}

/**
 * 取文本末尾 `limit` 行（去掉末尾空行；空文本返回空数组）。纯函数。
 * @param {string|null|undefined} text - 原始输出。
 * @param {number} [limit] - 最多保留的行数。
 * @returns {string[]} 尾部行。
 */
export function tailLines(text, limit = TAIL_LINES) {
  const normalized = String(text ?? '').replace(/\s+$/, '');
  if (normalized === '') return [];
  return normalized.split('\n').slice(-limit);
}

/**
 * 把结果数组聚合成「失败清单 + 退出码 + 汇总行」。纯函数：不读盘、不打印、不退出。
 *
 * 这就是 verify 的聚合语义：**失败不短路** —— 所有步骤都已执行完的结果一起送进来，
 * 汇总里逐一点名失败的步骤；只要有一个失败，退出码就是 1。
 * @param {{name: string, exitCode: number|null, signal?: string|null, error?: Error|null}[]} results - 全部步骤结果。
 * @returns {{total: number, failed: number, failedNames: string[], exitCode: 0|1, summary: string}} 聚合结论。
 */
export function summarize(results) {
  const failed = results.filter((result) => !stepOk(result));
  return {
    total: results.length,
    failed: failed.length,
    failedNames: failed.map((result) => result.name),
    exitCode: failed.length === 0 ? 0 : 1,
    summary: `verify: ${results.length} 步 / ${failed.length} 失败`,
  };
}

/**
 * 一步失败的可操作详情（纯函数）：退出码 + 尾部输出。
 *
 * 优先展示 `stderr` 尾部（`client-build --check` / `prepare` 的失败信息都在这里）；
 * `stderr` 为空时退到 `stdout` 尾部（`check-refs` 的不符项写在 stdout）。**不倾倒完整
 * 输出**：全量测试的 stdout 可能有几千行，尾部足够定位。
 * @param {{name: string, exitCode: number|null, signal?: string|null, ms: number, stdout?: string, stderr?: string, error?: Error|null}} result - 失败的步骤结果。
 * @param {number} [limit] - 尾部行数。
 * @returns {string} 多行文本（每行已带缩进）。
 */
export function formatFailureDetail(result, limit = TAIL_LINES) {
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const code = timedOut
    ? `超时 timeout=${STEP_TIMEOUT_MS}ms`
    : result.signal !== null && result.signal !== undefined
      ? `signal=${result.signal}`
      : `exit=${result.exitCode === null || result.exitCode === undefined ? '?' : result.exitCode}`;
  const stderrTail = tailLines(result.stderr, limit);
  const fromStderr = stderrTail.length > 0;
  const tail = fromStderr ? stderrTail : tailLines(result.stdout, limit);
  const lines = [`  FAIL  ${result.name}（${code}，${result.ms}ms）`];
  if (result.error && !timedOut) lines.push(`  error: ${result.error.message ?? String(result.error)}`);
  if (tail.length === 0) {
    lines.push('  （stderr / stdout 均为空，没有可打印的尾部）');
  } else {
    lines.push(`  ${fromStderr ? 'stderr' : 'stdout'} 尾部（最后 ${tail.length} 行）：`);
    for (const line of tail) lines.push(`  | ${line}`);
  }
  return lines.join('\n');
}

/**
 * CLI 主流程：串行执行全部步骤、逐步打印结果、失败打印详情、末尾汇总。
 *
 * 两类「环境不对」先于任何步骤 fail-closed：
 *   1. 不是仓库 checkout（安装现场误跑）⇒ 一句说明 + exit 1，**不抛 ENOENT 堆栈**；
 *   2. `test/` 里有不符合 `*.test.mjs` 命名的文件 ⇒ 点名 + exit 1，**不静默漏跑**。
 * @param {string[]} [argv] - 命令行参数（本命令无参数，保留给直接运行）。
 * @param {{spawn?: typeof spawnSync, log?: (line: string) => void, testFiles?: string[], checkout?: boolean}} [options] - 可注入项（单测用）。
 * @returns {0|1} 退出码。
 */
export function main(argv = [], {
  spawn = spawnSync,
  log = console.log,
  testFiles,
  checkout = looksLikeRepositoryCheckout(),
} = {}) {
  void argv;
  if (!checkout) {
    log('verify: 这不是仓库 checkout（缺少 test/ 目录，或其中没有 *.test.mjs 用例）。');
    log(`verify: ${NOT_CHECKOUT_HINT}`);
    return 1;
  }
  let files;
  try {
    files = testFiles ?? listTestFiles();
  } catch (error) {
    log(`verify: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  log('verify: 发布前检查（全量测试 + 四道门禁 + 文档引用体检；聚合报告，不 fail-fast）');
  const stepList = steps(files);
  const nameWidth = Math.max(...stepList.map((step) => step.name.length));
  const results = [];
  for (const step of stepList) {
    log(`verify: 运行 ${step.name} …`);
    const result = runStep(step, spawn);
    results.push(result);
    log(formatStepLine(result, nameWidth));
  }
  const summary = summarize(results);
  if (summary.failed > 0) {
    log('');
    log('verify: 失败详情（退出码 + 输出尾部；完整输出请单独重跑该步）');
    for (const result of results.filter((item) => !stepOk(item))) {
      log(formatFailureDetail(result));
    }
  }
  log('');
  log(summary.summary);
  if (summary.exitCode === 0) log('verify: 全部通过');
  else log(`verify: 失败步骤：${summary.failedNames.join('、')}`);
  return summary.exitCode;
}

// 只有作为脚本运行时才执行：测试会 import 上面的纯函数。
// g-076 项 1（symlink 假绿）同款守卫：`process.argv[1]` 是调用时的字面路径，经软链
// 调用时与 `import.meta.url` 永不相等 ⇒ 守卫被跳过、静默 exit 0。统一用 realpath 比较，
// 拿不到真实路径就不当成直接运行（fail-closed）。同款守卫见 `scripts/client-build.mjs`。
const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}
