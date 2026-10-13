#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的词典同步工具（g-066）。
 *
 * 为什么需要它：本插件的全部用户可见文案原先硬编码在 `client.js` —— 既有 513 键的
 * 主词典，也有 `ERROR_TEXT` 里 51 条 `code → [zh, en]` 表（运行时展开成 `error.<code>`，
 * 合计 564 键/语言）。文案混在 1.1 万行的 bundle 里，改一句话要在一份没有语法检查的
 * 生成物里找行号。现在 `locale/zh.json` 与 `locale/en.json` 是**唯一人工真源**：
 *
 * - `client.js` 里的 `const zh = {…}` / `const en = {…}` 是**生成物**，只由本脚本写；
 * - 宿主没有文件级 language pack 约定，客户端 bundle 又是 classic `<script>` 自注册
 *   CJS 工厂、宿主零转译，插件路由也不服务包内的 `locale/*.json`（CONTRACT.md §14.5）
 *   —— 所以浏览器运行时**取不到**这两个 JSON。于是 `ctx.locale.register(NS, {zh, en})`
 *   的同步语义保持不变：JSON 只服务于「人读、人改」，字节进 bundle 的那一步是这道门。
 *
 * 与 `scripts/client-chunks.mjs` 同类：`--write` 就地重写生成段，不带参数则只**校验**
 * （不一致 ⇒ 非零退出码）。它是开发期工具，不是构建步骤。
 *
 * 用法：
 *   node scripts/locale-pack.mjs          # 校验（适合 CI / 发布前 / prepare 门禁）
 *   node scripts/locale-pack.mjs --check  # 同上，显式写法
 *   node scripts/locale-pack.mjs --write  # 由两份 JSON 重写 client.js 的生成段
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 主 bundle 路径 —— 生成段就写在它里面。 */
const CLIENT_PATH = join(PACKAGE_DIR, 'client.js');
/** 两份 JSON 真源所在目录（相对包根）。 */
export const LOCALE_DIR = 'locale';
/** 语言 id → 生成段的变量名。顺序即 `ctx.locale.register` 的入参顺序。 */
export const LOCALES = Object.freeze({ zh: 'zh', en: 'en' });

/**
 * 生成段的开头行（缩进/措辞改动会让本脚本拒绝动手，而不是猜）。
 * @param name - 变量名（`zh` / `en`）。
 * @returns 精确的开头行。
 */
export function blockOpen(name) {
  return `    const ${name} = {`;
}

/** 生成段的结束行。 */
export const BLOCK_CLOSE = '    };';

/**
 * 把一段文案渲染成 JS 单引号字面量。
 * 词典里的值不含换行；单引号与反斜杠转义，其余字节原样通过。
 * @param text - 文案。
 * @returns 字面量文本（含引号）。
 */
function quote(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 不带引号也合法的键名（`histAction.replace` / `error.invalid-json` 需要引号）。 */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 把一个词典渲染成生成段的正文行（不含首尾行）。
 * 每键一行 —— 顺序稳定 ⇒ `--write` 幂等，`--check` 只需逐字比较。
 * @param dict - `{key: text}`，保持 JSON 里的插入顺序。
 * @returns 行数组。
 */
export function renderDictionaryRows(dict) {
  return Object.entries(dict).map(([key, text]) => {
    const name = BARE_KEY.test(key) ? key : quote(key);
    return `      ${name}: ${quote(text)},`;
  });
}

/**
 * 渲染一个完整的生成段（含首尾行）。
 * @param name - 变量名（`zh` / `en`）。
 * @param dict - 词典。
 * @returns 生成段文本（不含尾随换行）。
 */
export function renderDictionaryBlock(name, dict) {
  return [blockOpen(name), ...renderDictionaryRows(dict), BLOCK_CLOSE].join('\n');
}

/**
 * 从 `client.js` 的文本里取出一个生成段。
 * @param source - `client.js` 全文。
 * @param name - 变量名（`zh` / `en`）。
 * @returns `{start, end, text}`；无法定位时抛错（绝不猜）。
 */
export function readDeclaredBlock(source, name) {
  const lines = source.split('\n');
  const open = lines.indexOf(blockOpen(name));
  if (open === -1) throw new Error(`client.js carries no \`${name}\` dictionary block (looked for: ${blockOpen(name)})`);
  const close = lines.indexOf(BLOCK_CLOSE, open + 1);
  if (close === -1) throw new Error(`the \`${name}\` dictionary block is not closed`);
  return { start: open, end: close, text: lines.slice(open, close + 1).join('\n') };
}

/**
 * 用一份新词典替换 `client.js` 里的生成段。
 * @param source - `client.js` 全文。
 * @param name - 变量名（`zh` / `en`）。
 * @param dict - 新词典。
 * @returns 新的全文。
 */
export function writeDeclaredBlock(source, name, dict) {
  const lines = source.split('\n');
  const { start, end } = readDeclaredBlock(source, name);
  const next = [...lines.slice(0, start), ...renderDictionaryBlock(name, dict).split('\n'), ...lines.slice(end + 1)];
  return next.join('\n');
}

/**
 * 读一份 locale JSON，绝不猜编码：非法 JSON 直接抛。
 * @param packageDir - 包根目录。
 * @param name - `zh` / `en`。
 * @returns 词典对象（保持文件里的键序）。
 */
export function readLocaleJson(packageDir, name) {
  const path = join(packageDir, LOCALE_DIR, `${name}.json`);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`read ${LOCALE_DIR}/${name}.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${LOCALE_DIR}/${name}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${LOCALE_DIR}/${name}.json must be a flat object of string values`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`${LOCALE_DIR}/${name}.json: \`${key}\` is not a string`);
  }
  return parsed;
}

/**
 * 两份 JSON 必须描述同一组键：集合相同、顺序相同、值非空。
 * 「顺序相同」不是洁癖 —— 生成的段按 JSON 顺序落盘，顺序漂移会让 diff 变成
 * 513 行的噪音，掩盖真正改掉的那一条文案。
 * @param dictionaries - `{zh, en}`。
 * @returns 键数组（已确认两边一致）。
 */
export function assertKeyParity(dictionaries) {
  const names = Object.keys(LOCALES);
  const [first, ...rest] = names;
  const keys = Object.keys(dictionaries[first]);
  for (const name of rest) {
    const other = Object.keys(dictionaries[name]);
    if (other.length !== keys.length) {
      throw new Error(`locale/${first}.json has ${keys.length} keys but locale/${name}.json has ${other.length}`);
    }
    for (let index = 0; index < keys.length; index += 1) {
      if (other[index] !== keys[index]) {
        throw new Error(`locale/${name}.json key #${index + 1} is \`${other[index]}\` but locale/${first}.json has \`${keys[index]}\``);
      }
    }
  }
  for (const name of names) {
    for (const key of keys) {
      if (dictionaries[name][key].length === 0) throw new Error(`locale/${name}.json: \`${key}\` is empty`);
    }
  }
  return keys;
}

/**
 * 读两份 JSON 并核对键对齐。
 * @param packageDir - 包根目录。
 * @returns `{dictionaries, keys}`。
 */
export function readDictionaries(packageDir) {
  const dictionaries = {};
  for (const name of Object.keys(LOCALES)) dictionaries[name] = readLocaleJson(packageDir, name);
  const keys = assertKeyParity(dictionaries);
  return { dictionaries, keys };
}

/**
 * 校验 `client.js` 的生成段与两份 JSON 逐字一致。
 * 同时供 `scripts/prepare.mjs` 的发布门复用：不抛错，返回结论。
 * @param options - `{packageDir, readText}`。
 * @returns `{ok, code, message}`。
 */
export function checkLocaleSync({ packageDir, readText }) {
  let dictionaries;
  let keys;
  try {
    ({ dictionaries, keys } = readDictionaries(packageDir));
  } catch (error) {
    return { ok: false, code: 'LOCALE-JSON', message: error instanceof Error ? error.message : String(error) };
  }
  const source = readText('client.js');
  if (source === null) return { ok: false, code: 'LOCALE-SYNC', message: '读不到 client.js，无法核对词典生成段' };
  for (const name of Object.keys(LOCALES)) {
    let declared;
    try {
      declared = readDeclaredBlock(source, name);
    } catch (error) {
      return { ok: false, code: 'LOCALE-SYNC', message: error instanceof Error ? error.message : String(error) };
    }
    const expected = renderDictionaryBlock(name, dictionaries[name]);
    if (declared.text !== expected) {
      const drift = declared.text.split('\n').filter((line, index) => line !== expected.split('\n')[index]).length;
      return {
        ok: false,
        code: 'LOCALE-SYNC',
        message:
          `client.js 的 \`${name}\` 段与 locale/${name}.json 不一致（约 ${drift} 行）：` +
          '先跑 node scripts/locale-pack.mjs --write 再发布',
      };
    }
  }
  return {
    ok: true,
    code: 'LOCALE-SYNC',
    message: `locale/zh.json、locale/en.json 各 ${keys.length} 键，与 client.js 的生成段逐字一致`,
  };
}

/** CLI 主体：只有被直接执行时才跑。 */
function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (!write && !check && argv.length > 0) {
    console.error('用法: node scripts/locale-pack.mjs [--check | --write]');
    process.exitCode = 2;
    return;
  }
  let dictionaries;
  let keys;
  try {
    ({ dictionaries, keys } = readDictionaries(PACKAGE_DIR));
  } catch (error) {
    console.error(`[locale-pack] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const source = readFileSync(CLIENT_PATH, 'utf8');
  if (write) {
    let next = source;
    for (const name of Object.keys(LOCALES)) next = writeDeclaredBlock(next, name, dictionaries[name]);
    if (next === source) {
      console.log(`[locale-pack] client.js 已是最新（${keys.length} 键/语言 × ${Object.keys(LOCALES).length}）`);
      return;
    }
    writeFileSync(CLIENT_PATH, next);
    console.log(`[locale-pack] 已由 locale/*.json 重写 client.js 的生成段（${keys.length} 键/语言）`);
    return;
  }
  const result = checkLocaleSync({ packageDir: PACKAGE_DIR, readText: (relPath) => (relPath === 'client.js' ? source : null) });
  if (result.ok) {
    console.log(`[locale-pack] ok：${result.message}`);
    return;
  }
  console.error(`[locale-pack] FAIL：${result.message}`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
