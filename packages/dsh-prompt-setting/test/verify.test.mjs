/**
 * `verify` 的聚合语义断言（纯函数 + 注入式主流程）。
 *
 * 为什么这样测：brief 明确要求**不要为了测 verify 而跑整套 ~60s 的全量测试**。所以
 * 这里用假的步骤结果数组驱动 {@link summarize} / {@link formatStepLine} /
 * {@link formatFailureDetail}，用注入的 `spawn` 驱动 {@link runStep} 与 {@link main}；
 * 真实端到端由「手动跑一次 `npm run verify`」覆盖（记录在 `NOTES.md` §160）。
 *
 * 被钉住的三件事（对应质量判据 1/2/3）：
 *   1. 干净树 ⇒ 汇总「0 失败」、退出码 0；
 *   2. 任一步失败 ⇒ 退出码 1，且汇总**点名**该步骤；
 *   3. **不 fail-fast**：某一步失败后，后续步骤仍被执行（注入 spawn 记录调用次数）。
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TAIL_LINES,
  formatFailureDetail,
  formatStepLine,
  listTestFiles,
  main,
  runStep,
  stepOk,
  steps,
  summarize,
  tailLines,
} from '../scripts/verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/** 一个通过的步骤结果。 */
const pass = (name, ms = 5) => ({ name, exitCode: 0, signal: null, ms, stdout: `ok ${name}`, stderr: '', error: null });

/** 一个失败的步骤结果（默认 exit 1 + stderr）。 */
const fail = (name, options = {}) => ({
  name,
  exitCode: options.exitCode ?? 1,
  signal: options.signal ?? null,
  ms: options.ms ?? 5,
  stdout: options.stdout ?? '',
  stderr: options.stderr ?? 'boom',
  error: options.error ?? null,
});

/** 假的 spawn：按 args 判定哪一步该红，并记录每次调用（证明「后续仍执行」）。 */
function fakeSpawn(failWhen = () => false) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const isFailure = failWhen(args);
    return {
      status: isFailure ? 1 : 0,
      signal: null,
      stdout: isFailure ? `stdout-of-${args[0]}` : '',
      stderr: isFailure ? `stderr-of-${args[0]}` : '',
    };
  };
  return { spawn, calls };
}

// #region 聚合：失败不短路的唯一判据

test('verify: a clean tree aggregates to exit 0 with one line per step', () => {
  const results = [pass('check-refs'), pass('client-build --check'), pass('test', 60000)];
  const summary = summarize(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failedNames, []);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.summary, 'verify: 3 步 / 0 失败');
});

test('verify: one failed step makes the exit code 1 and names that step', () => {
  // 失败落在中间：后面的步骤结果仍然计入 total —— 这就是「不 fail-fast」的纯函数形态。
  const results = [pass('check-refs'), fail('client-build --check'), pass('prepare'), pass('test')];
  const summary = summarize(results);
  assert.equal(summary.total, 4);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failedNames, ['client-build --check']);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.summary, 'verify: 4 步 / 1 失败');
});

test('verify: every failed step is named, not just the first one', () => {
  const results = [fail('check-refs'), pass('client-build --check'), fail('prepare'), pass('test')];
  const summary = summarize(results);
  assert.deepEqual(summary.failedNames, ['check-refs', 'prepare']);
  assert.equal(summary.exitCode, 1);
});

test('verify: a signal-killed or unspawnable step is not a pass', () => {
  assert.equal(stepOk(pass('x')), true);
  assert.equal(stepOk(fail('x')), false);
  assert.equal(stepOk(fail('x', { exitCode: null, signal: 'SIGKILL' })), false);
  assert.equal(stepOk(fail('x', { exitCode: null, error: new Error('ENOENT') })), false);
  const summary = summarize([fail('x', { exitCode: null, signal: 'SIGKILL' })]);
  assert.equal(summary.exitCode, 1);
});

// #endregion

// #region 一行摘要与失败详情（可读性 = 可操作定位）

test('verify: one result line carries ok/FAIL, the step name and its duration', () => {
  assert.equal(formatStepLine(pass('check-refs', 12), 20), 'ok    check-refs            12ms');
  assert.equal(formatStepLine(fail('test', { ms: 60000 }), 20), 'FAIL  test                  60000ms');
});

test('verify: tailLines keeps only the tail, drops trailing blank lines', () => {
  const text = ['row 0', 'row 1', 'row 2', '', ''].join('\n');
  assert.deepEqual(tailLines(text, 2), ['row 1', 'row 2']);
  assert.deepEqual(tailLines('', 5), []);
  assert.deepEqual(tailLines(null, 5), []);
  assert.equal(tailLines(Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')).length, TAIL_LINES);
});

test('verify: failure detail names the exit code and only the stderr tail', () => {
  const stderr = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n');
  const detail = formatFailureDetail(fail('client-build --check', { stderr, ms: 42 }));
  assert.match(detail, /FAIL {2}client-build --check/);
  assert.match(detail, /exit=1/);
  assert.match(detail, /42ms/);
  assert.match(detail, /stderr 尾部（最后 20 行）/);
  assert.match(detail, /row 99/);
  assert.doesNotMatch(detail, /row 0\b/, 'the head of the output must not be dumped');
});

test('verify: an empty stderr falls back to the stdout tail (the check-refs shape)', () => {
  const stdout = ['check-refs: 不符项', '  - 文档缺 12-update.js', '  - 文档多出 12-updates.js'].join('\n');
  const detail = formatFailureDetail(fail('check-refs', { stdout, stderr: '' }));
  assert.match(detail, /stdout 尾部/);
  assert.match(detail, /文档缺 12-update\.js/);
  assert.doesNotMatch(detail, /stderr 尾部/);
});

test('verify: a signal / spawn failure is reported without pretending there was output', () => {
  const killed = formatFailureDetail(fail('x', { exitCode: null, signal: 'SIGKILL', stderr: '' }));
  assert.match(killed, /signal=SIGKILL/);
  assert.match(killed, /没有可打印的尾部/);
  const unspawnable = formatFailureDetail(fail('x', { exitCode: null, error: new Error('spawn ENOENT'), stderr: '' }));
  assert.match(unspawnable, /spawn ENOENT/);
});

// #endregion

// #region 步骤定义与子进程契约

test('verify: the step list is basic-to-derived and the suite runs last', () => {
  const list = steps(['test/build.test.mjs']);
  assert.deepEqual(
    list.map((step) => step.name),
    ['check-refs', 'client-build --check', 'locale-pack --check', 'prepare', 'check-compat', 'test'],
  );
  assert.deepEqual(list.at(-1).args, ['--test', 'test/build.test.mjs']);
  for (const step of list.slice(0, -1)) {
    assert.match(step.args[0], /\.mjs$/, `${step.name} runs a script, not a shell command`);
    for (const flag of step.args.slice(1)) {
      assert.equal(flag, '--check', `${step.name} only accepts the read-only --check flag`);
    }
  }
});

test('verify: test files are expanded by readdirSync (no shell glob) and cover this file', () => {
  const files = listTestFiles();
  assert.ok(files.length >= 22, `expected the whole suite, got ${files.length}`);
  assert.deepEqual(files, [...files].sort(), 'the listing is stable');
  for (const file of files) {
    assert.match(file, /^test\/[^/]+\.test\.mjs$/);
  }
  assert.ok(files.includes('test/verify.test.mjs'), 'the expander must see its own test file');
  assert.ok(files.includes('test/client-source.test.mjs'));
});

test('verify: a step always runs in the package root, whatever the caller cwd is', () => {
  const { spawn, calls } = fakeSpawn();
  const result = runStep({ name: 'x', args: ['scripts/x.mjs'] }, spawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['scripts/x.mjs']);
  // cwd 无关的机器证明：子进程的 cwd 由脚本自身位置推导，而不是调用者的 cwd。
  assert.equal(calls[0].options.cwd, packageRoot);
  assert.equal(typeof result.ms, 'number');
  assert.equal(result.exitCode, 0);
});

// #endregion

// #region 主流程：聚合输出 + 失败后继续跑

test('verify: the main flow prints one line per step and the final summary (clean tree)', () => {
  const lines = [];
  const { spawn, calls } = fakeSpawn();
  const exitCode = main([], { spawn, log: (line) => lines.push(line), testFiles: ['test/a.test.mjs'] });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 6, 'all six steps run');
  for (const name of ['check-refs', 'client-build --check', 'locale-pack --check', 'prepare', 'check-compat', 'test']) {
    assert.ok(lines.some((line) => new RegExp(`^ok {4}${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} `).test(line)), `missing ok line for ${name}`);
  }
  assert.ok(lines.includes('verify: 6 步 / 0 失败'));
  assert.ok(lines.includes('verify: 全部通过'));
});

test('verify: a mid-run failure does not skip the remaining steps', () => {
  const lines = [];
  // 让第 4 步 prepare 失败 —— 后面的 check-compat 与 test 必须照样执行。
  const { spawn, calls } = fakeSpawn((args) => args[0] === 'scripts/prepare.mjs');
  const exitCode = main([], { spawn, log: (line) => lines.push(line), testFiles: ['test/a.test.mjs'] });
  assert.equal(exitCode, 1);
  assert.equal(calls.length, 6, 'a failure must not short-circuit the remaining steps');
  assert.ok(lines.some((line) => /^FAIL {2}prepare /.test(line)), 'the failing step is named in its result line');
  assert.ok(lines.includes('verify: 6 步 / 1 失败'));
  assert.ok(lines.includes('verify: 失败步骤：prepare'));
  assert.ok(lines.some((line) => line.includes('exit=1')), 'the failure detail carries the exit code');
  assert.ok(lines.some((line) => line.includes('stderr-of-scripts/prepare.mjs')), 'the failure detail carries the stderr tail');
});

// #endregion
