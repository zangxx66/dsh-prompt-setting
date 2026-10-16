#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的词典同步工具（g-066）。
 *
 * 为什么需要它：本插件的全部用户可见文案原先硬编码在 `client.js` —— 既有 513 键的
 * 主词典，也有 `ERROR_TEXT` 里 51 条 `code → [zh, en]` 表（运行时展开成 `error.<code>`，
 * 合计 564 键/语言；g-069 把主词典加到 515 条，现为 566 键/语言）。文案混在 1.1 万行的
 * bundle 里，改一句话要在一份没有语法检查的
 * 生成物里找行号。现在 `locale/zh.json` 与 `locale/en.json` 是**唯一人工真源**：
 *
 * - `const zh = {…}` / `const en = {…}` 两个生成段**住在 `src/` 里承载 locale 的那一个段
 *   文件**中（阶段 2 起 `client.js` 是 `src/` 的生成物，真源是 `src/` —— `CONTRACT.md` §23、
 *   `docs/architecture-map.md`）。本脚本是这两个段的**唯一写入者**，写完顺手调用生成器重建
 *   `client.js` —— 于是「跑完一次 `--write`，`src/` 与 `client.js` 同时最新」是被测试钉住的
 *   性质，而不是一句提醒。**这条纪律不是洁癖**：在阶段 2 之前，本脚本写 `client.js`、
 *   `client-build.mjs --write` 从 `src/` 重建 `client.js`，同一份内容有两个写入者，后者的
 *   `--write` 会把前者刚写的文案**静默**覆盖回去（真源迁移不完整 ⇒ 数据丢失）；
 *
 * 宿主没有文件级 language pack 约定，客户端 bundle 又是 classic `<script>` 自注册
 * CJS 工厂、宿主零转译，插件路由也不服务包内的 `locale/*.json`（CONTRACT.md §14.5）
 * —— 所以浏览器运行时**取不到**这两个 JSON。于是 `ctx.locale.register(NS, {zh, en})`
 * 的同步语义保持不变：JSON 只服务于「人读、人改」，字节进 bundle 的那一步是这道门。
 *
 * 与 `scripts/client-chunks.mjs` 同类：`--write` 就地重写生成段，不带参数则只**校验**
 * （不一致 ⇒ 非零退出码）。它是开发期工具，不是构建步骤。
 *
 * 用法：
 *   node scripts/locale-pack.mjs          # 校验（适合 CI / 发布前 / prepare 门禁）
 *   node scripts/locale-pack.mjs --check  # 同上，显式写法
 *   node scripts/locale-pack.mjs --write  # 由两份 JSON 重写 src/ 里的生成段，并重建 client.js
 */

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_SRC_DIR, renderClient } from './client-build.mjs';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 主 bundle 路径 —— **生成物**：生成段写进 `src/` 之后由这里重建。 */
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
 * 515 行的噪音，掩盖真正改掉的那一条文案。
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
 * 定位承载 locale 生成段的那一个 `src/*.js`。
 *
 * **刻意不硬编码 `02-locale.js`**：段名与段边界属于 `docs/refactor-plan.md` §5.1 的目标
 * 段表，重切是允许的（`CONTRACT.md` §23.2 规则 1）。硬编码会在下一次重切之后静默写错
 * 文件，所以这里改成「扫描 + fail-closed」：要求**恰好一个**段能解析出两个 locale 生成
 * 段；命中 0 个或多个一律抛错，绝不猜。
 *
 * **候选判定复用自己的解析器（g-076 项 4）**：g-075 的实现用「行集合里出现过
 * `blockOpen('zh')` 与 `blockOpen('en')` 两行」判定候选 —— 只要求**行出现**，不要求
 * 它是一段可解析的块，所以块注释里恰好写出这两行的段会被误当成真源。现在改为
 * {@link readDeclaredBlock}（也就是 `--write` 真正用的那个解析器）：两个块都能被解析
 * 出来才算候选。仍然**不做**完整的注释剥离 —— 那需要在整份 JS 里跟踪「块注释开闭」
 * 的状态机（字符串与正则里同样会出现这些字节），误判风险比它治的病更大。
 * @param io - `{packageDir, readDir|listDir, readText}` 可注入（测试与 `prepare` 用）。
 * @returns `{name, text}`；**读不到 `src/` 目录时返回 `null`**（阶段 2 之前的包、最小 fixture）。
 */
export function findLocaleSegment(io = {}) {
  const packageDir = io.packageDir ?? PACKAGE_DIR;
  const readDir = io.readDir ?? io.listDir ?? ((relPath) => {
    try {
      return readdirSync(join(packageDir, relPath));
    } catch {
      return null;
    }
  });
  const readText = io.readText ?? ((relPath) => {
    try {
      return readFileSync(join(packageDir, relPath), 'utf8');
    } catch {
      return null;
    }
  });
  const entries = readDir(CLIENT_SRC_DIR);
  if (entries === null) return null;
  const names = Object.keys(LOCALES);
  const wanted = names.map((name) => blockOpen(name));
  const hits = [];
  for (const entry of [...entries].filter((name) => name.endsWith('.js')).sort()) {
    const text = readText(`${CLIENT_SRC_DIR}/${entry}`);
    if (typeof text !== 'string') continue;
    // 两个块都要能被解析出来（块头 + 闭合行），而不是「行出现过」。
    const carries = names.every((name) => {
      try {
        readDeclaredBlock(text, name);
        return true;
      } catch {
        return false;
      }
    });
    if (carries) hits.push({ name: entry, text });
  }
  if (hits.length === 0) {
    throw new Error(`${CLIENT_SRC_DIR}/ 下没有任何段同时含可解析的 ${wanted.join(' / ')} 块：locale 生成段的真源缺失`);
  }
  if (hits.length > 1) {
    throw new Error(
      `${CLIENT_SRC_DIR}/ 下有 ${hits.length} 个段同时含 locale 生成段（${hits.map((hit) => hit.name).join('、')}）：真源不唯一`,
    );
  }
  return hits[0];
}

/**
 * 把两份词典写进一个段文件的文本（纯函数，便于单测；IO 在调用方）。
 * @param segmentText - 段文件全文（含首行片段声明）。
 * @param dictionaries - `{zh, en}`。
 * @returns 新的段文件全文。
 */
export function renderLocaleSegment(segmentText, dictionaries) {
  let next = segmentText;
  for (const name of Object.keys(LOCALES)) next = writeDeclaredBlock(next, name, dictionaries[name]);
  return next;
}

/** 把一次「生成段落在哪里」的漂移渲染成可执行的一行提示。 */
function driftMessage(where, name, declaredText, expected) {
  const expectedLines = expected.split('\n');
  const drift = declaredText.split('\n').filter((line, index) => line !== expectedLines[index]).length;
  return `${where} 的 \`${name}\` 段与 locale/${name}.json 不一致（约 ${drift} 行）：先跑 node scripts/locale-pack.mjs --write 再发布`;
}

/**
 * 校验生成段与两份 JSON 逐字一致（g-066；阶段 2 起核对**两个位置**）。
 *
 * 顺序是刻意的：先核 **`src/` 的段**（真源），再核 **`client.js` 的段**（证明生成物
 * 就是真源的产物）。只核 `client.js` 会漏掉「段真源漂了但产物还没重建」这半场，
 * 而那半场正是 `client-build.mjs --write` 会静默覆盖回去的那种状态。
 * 同时供 `scripts/prepare.mjs` 的发布门复用：不抛错，返回结论。
 * @param options - `{packageDir, readText, readDir|listDir}`。
 * @returns `{ok, code, message}`。
 */
export function checkLocaleSync({ packageDir, readText, readDir, listDir }) {
  let dictionaries;
  let keys;
  try {
    ({ dictionaries, keys } = readDictionaries(packageDir));
  } catch (error) {
    return { ok: false, code: 'LOCALE-JSON', message: error instanceof Error ? error.message : String(error) };
  }
  const names = Object.keys(LOCALES);
  let segment = null;
  try {
    segment = findLocaleSegment({ packageDir, readText, readDir, listDir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'LOCALE-SYNC', message: `${detail}：先跑 node scripts/locale-pack.mjs --write 定位` };
  }
  if (segment !== null) {
    for (const name of names) {
      let declared;
      try {
        declared = readDeclaredBlock(segment.text, name);
      } catch (error) {
        return {
          ok: false,
          code: 'LOCALE-SYNC',
          message: `${error instanceof Error ? error.message : String(error)}：先跑 node scripts/locale-pack.mjs --write`,
        };
      }
      const expected = renderDictionaryBlock(name, dictionaries[name]);
      if (declared.text !== expected) {
        return { ok: false, code: 'LOCALE-SYNC', message: driftMessage(`${CLIENT_SRC_DIR}/${segment.name}`, name, declared.text, expected) };
      }
    }
  }
  const source = readText('client.js');
  if (source === null) return { ok: false, code: 'LOCALE-SYNC', message: '读不到 client.js，无法核对词典生成段' };
  for (const name of names) {
    let declared;
    try {
      declared = readDeclaredBlock(source, name);
    } catch (error) {
      return { ok: false, code: 'LOCALE-SYNC', message: error instanceof Error ? error.message : String(error) };
    }
    const expected = renderDictionaryBlock(name, dictionaries[name]);
    if (declared.text !== expected) {
      return { ok: false, code: 'LOCALE-SYNC', message: driftMessage('client.js', name, declared.text, expected) };
    }
  }
  const where = segment === null ? 'client.js' : `${CLIENT_SRC_DIR}/${segment.name} 与 client.js`;
  return {
    ok: true,
    code: 'LOCALE-SYNC',
    message: `locale/zh.json、locale/en.json 各 ${keys.length} 键，与 ${where} 的生成段逐字一致`,
  };
}

/** CLI 的默认读文本：包根相对路径，读不到返回 null（绝不抛）。 */
function readPackageText(relPath) {
  try {
    return readFileSync(join(PACKAGE_DIR, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** CLI 的默认列目录：包根相对路径，读不到返回 null（绝不抛）。 */
function readPackageDir(relPath) {
  try {
    return readdirSync(join(PACKAGE_DIR, relPath));
  } catch {
    return null;
  }
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
  const languages = Object.keys(LOCALES).length;
  if (write) {
    let segment = null;
    try {
      segment = findLocaleSegment({ packageDir: PACKAGE_DIR, readDir: readPackageDir, readText: readPackageText });
    } catch (error) {
      console.error(`[locale-pack] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    const notes = [];
    if (segment === null) {
      // 没有 src/ ⇒ 这个包还没迁移到分段真源，按老语义直接写 client.js（不存在两个写入者）。
      // g-076 项 5：这条兼容分支必须**可见**。否则「src/ 被误删」会被它静默吞掉 —— 脚本
      // 报成功、写的却是老路径，要等到 `client-build.mjs --check` 才红。
      console.warn(`[locale-pack] 未找到 ${CLIENT_SRC_DIR}/ 段真源（读不到该目录）：按旧语义直接写 client.js`);
      const source = readPackageText('client.js');
      if (source === null) {
        console.error('[locale-pack] 读不到 client.js，也无 src/ 段真源');
        process.exitCode = 1;
        return;
      }
      let next = source;
      for (const name of Object.keys(LOCALES)) next = writeDeclaredBlock(next, name, dictionaries[name]);
      if (next !== source) {
        writeFileSync(CLIENT_PATH, next);
        notes.push('已重写 client.js 的生成段');
      } else {
        notes.push('client.js 已是最新');
      }
    } else {
      const next = renderLocaleSegment(segment.text, dictionaries);
      if (next !== segment.text) {
        writeFileSync(join(PACKAGE_DIR, CLIENT_SRC_DIR, segment.name), next);
        notes.push(`已重写 ${CLIENT_SRC_DIR}/${segment.name} 的生成段`);
      } else {
        notes.push(`${CLIENT_SRC_DIR}/${segment.name} 已是最新`);
      }
      // 段是新的 ⇒ 产物必须是段的推导结果。这一步是「一次 --write 之后两边同时最新」
      // 的保证：没有它，刚写进段里的文案会被下一次 client-build --write 悄悄抹掉。
      const want = renderClient({ packageDir: PACKAGE_DIR });
      const current = readPackageText('client.js');
      if (want !== current) {
        writeFileSync(CLIENT_PATH, want);
        notes.push('已按 src/ 重建 client.js');
      } else {
        notes.push('client.js 与 src/ 逐字节一致');
      }
    }
    console.log(`[locale-pack] ${notes.join('；')}（${keys.length} 键/语言 × ${languages}）`);
    return;
  }
  const result = checkLocaleSync({ packageDir: PACKAGE_DIR, readText: readPackageText, readDir: readPackageDir });
  if (result.ok) {
    console.log(`[locale-pack] ok：${result.message}`);
    return;
  }
  console.error(`[locale-pack] FAIL：${result.message}`);
  process.exitCode = 1;
}

// 只有作为脚本运行时才执行：测试会 import 上面的纯函数。
//
// g-076 项 1（symlink 假绿）：`process.argv[1]` 是**调用时的字面路径**，而
// `import.meta.url` 已被 Node 解析成真实路径。经软链调用（`npm link`、pnpm
// workspace、`node_modules/<pkg>`、`.bin`）时两者永不相等 ⇒ 守卫整段被跳过、
// **静默 exit 0** —— 连 `--bogus` 的参数校验都不跑，在自动化里等于假绿。
// 统一改成 realpath 比较；`argv[1]` 可能不存在或无法解析，所以包在 try/catch 里
// （拿不到真实路径就不当成直接运行，fail-closed）。同款守卫、同款理由见
// `scripts/client-build.mjs` 与 `scripts/client-chunks.mjs`（三处必须一起改，不许分裂）。
const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) main(process.argv.slice(2));
