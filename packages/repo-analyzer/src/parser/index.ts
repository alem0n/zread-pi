import Parser from 'web-tree-sitter';
import { join } from 'path';
import type { FileManifest, SymbolManifest, SymbolInfo, SymbolRange } from '@zread-pi/types';
import { createLogger, getProjectRoot, readTextFile } from '@zread-pi/utils';
import { isLanguageSupported } from './language-map';
import { loadParsers } from './wasm-loader';
import { parseVueSfc } from './vue-handler';

/** 本模块的命名 logger（Tree-sitter 解析）。 */
const parserLogger = createLogger('analyzer.parser');

const SCM_QUERIES: Record<string, string> = {
  typescript: `
    (import_statement) @import
    (export_statement) @export
    ; 只提取顶层函数声明（不含嵌套箭头函数）
    (program (function_declaration name: (identifier) @fn_name) @fn)
    (class_declaration name: (type_identifier) @class_name) @class
    (interface_declaration name: (type_identifier) @iface_name) @iface
    (method_definition name: (property_identifier) @method_name) @method
  `,
  javascript: `
    (import_statement) @import
    (export_statement) @export
    ; 只提取顶层函数声明
    (program (function_declaration name: (identifier) @fn_name) @fn)
    (class_declaration name: (identifier) @class_name) @class
    (method_definition name: (property_identifier) @method_name) @method
  `,
  go: `
    (import_declaration) @import
    (function_declaration name: (identifier) @fn_name) @fn
    (type_declaration) @type
  `,
  python: `
    (import_statement) @import
    (function_definition name: (identifier) @fn_name) @fn
    (class_definition name: (identifier) @class_name) @class
  `,
  php: `
    (namespace_use_declaration) @import
    (function_definition name: (name) @fn_name) @fn
    (class_declaration name: (name) @class_name) @class
    (method_declaration name: (name) @method_name) @method
    (interface_declaration name: (name) @iface_name) @iface
  `,
  rust: `
    (use_declaration) @import
    (function_item name: (identifier) @fn_name) @fn
    (struct_item name: (type_identifier) @struct_name) @struct
    (enum_item name: (type_identifier) @enum_name) @enum
    (trait_item name: (type_identifier) @trait_name) @trait
  `,
  java: `
    (import_declaration) @import
    (method_declaration name: (identifier) @method_name) @method
    (class_declaration name: (identifier) @class_name) @class
    (interface_declaration name: (identifier) @iface_name) @iface
  `,
  c: `
    (preproc_include) @import
    (function_definition) @fn
    (struct_specifier name: (type_identifier) @struct_name) @struct
  `,
  cpp: `
    (preproc_include) @import
    (function_definition) @fn
    (class_specifier name: (type_identifier) @class_name) @class
  `,
  csharp: `
    (using_directive) @import
    (method_declaration name: (identifier) @method_name) @method
    (class_declaration name: (identifier) @class_name) @class
    (interface_declaration name: (identifier) @iface_name) @iface
  `,
  ruby: `
    (method name: (identifier) @method_name) @method
    (class name: (constant) @class_name) @class
    (module name: (constant) @module_name) @module
  `,
  swift: `
    (import_declaration) @import
    (function_declaration name: (simple_identifier) @fn_name) @fn
    (class_declaration name: (type_identifier) @class_name) @class
    (protocol_declaration name: (type_identifier) @iface_name) @iface
  `,
  kotlin: `
    (import_header) @import
    (function_declaration name: (simple_identifier) @fn_name) @fn
    (class_declaration name: (type_identifier) @class_name) @class
  `,
};

/**
 * Resolve function/method name from node.
 *
 * Most languages use the `name` field. C/C++ use `declarator` field on
 * function_definition instead — walk down to the inner identifier.
 */
function resolveFunctionName(node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const innerDecl = declarator.childForFieldName('declarator');
    if (innerDecl) return innerDecl.text;
    if (declarator.type === 'identifier') return declarator.text;
  }

  return 'anonymous';
}

function extractFunctionSignature(node: Parser.SyntaxNode): string {
  // Try to get body via field name (universal)
  const bodyNode = node.childForFieldName('body');

  if (bodyNode) {
    // Build signature from all children except body
    // Use id comparison since childForFieldName returns new object
    const bodyId = bodyNode.id;
    const parts: string[] = [];
    for (const child of node.children) {
      if (child.id === bodyId) continue;
      parts.push(child.text);
    }
    return parts.join(' ').trim();
  }

  // Fallback: no body field found, use first line
  const firstLine = node.text.split('\n')[0].trim();
  return firstLine;
}

/**
 * Extract export signature - universal approach
 *
 * For languages with export (TS/JS), build signature without body.
 * For others, just return first line.
 */
function extractExportFromNode(node: Parser.SyntaxNode): string {
  // Check if this language has export statements (TS/JS only)
  const firstLine = node.text.split('\n')[0].trim();

  // Re-exports: export { ... } from '...'
  if (firstLine.includes(' from ')) {
    return firstLine;
  }

  // Find the declaration inside export_statement
  const decl = node.children.find(c =>
    c.type.includes('declaration') ||
    c.type === 'lexical_declaration'
  );

  if (!decl) {
    return firstLine;
  }

  // Use same logic as function signature - exclude body
  const bodyNode = decl.childForFieldName('body');
  if (bodyNode) {
    // Use id comparison since childForFieldName returns new object
    const bodyId = bodyNode.id;
    const parts: string[] = ['export'];
    for (const child of decl.children) {
      if (child.id === bodyId) continue;
      parts.push(child.text);
    }
    return parts.join(' ').trim();
  }

  // For interface/type (no body), truncate if long
  const declLine = decl.text.split('\n')[0].trim();
  return declLine.length > 100 ? declLine.slice(0, 100) + '...' : declLine;
}

/** 结构类捕获名（其余捕获是 import / export 或名称节点，不进 ranges） */
const STRUCTURAL_CAPTURES = new Set([
  'fn',
  'method',
  'class',
  'iface',
  'struct',
  'enum',
  'trait',
  'module',
  'type',
]);

/** 结构类捕获对应的名称捕获（`fn` → `fn_name`…；`type` 无对应名称捕获） */
function nameCaptureFor(kind: string): string | null {
  switch (kind) {
    case 'type':
      return null;
    default:
      return `${kind}_name`;
  }
}

/** 从一次 query match 里抽结构类节点的行区间（import / export 不进 ranges） */
function collectRanges(captures: Parser.QueryCapture[]): SymbolRange[] {
  const names = new Map<string, string>();
  for (const capture of captures) {
    if (capture.name.endsWith('_name')) {
      names.set(capture.name, capture.node.text);
    }
  }

  const ranges: SymbolRange[] = [];
  const seen = new Set<number>();
  for (const capture of captures) {
    if (!STRUCTURAL_CAPTURES.has(capture.name)) continue;
    const node = capture.node;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const nameCapture = nameCaptureFor(capture.name);
    const name = (nameCapture && names.get(nameCapture)) || resolveFunctionName(node) || capture.name;
    ranges.push({
      name,
      start: node.startPosition.row + 1,
      end: node.endPosition.row + 1,
    });
  }
  return ranges;
}

function extractWithQuery(
  tree: Parser.Tree,
  language: string,
  parser: Parser
): { imports: string[]; exports: string[]; functions: Array<{ name: string; signature: string }>; ranges: SymbolRange[] } {
  const queryStr = SCM_QUERIES[language];
  if (!queryStr) {
    return extractBasic(tree);
  }

  try {
    const lang = parser.getLanguage();
    const query = lang.query(queryStr);
    const matches = query.matches(tree.rootNode);

    const imports: string[] = [];
    const exports: string[] = [];
    const functions: Array<{ name: string; signature: string }> = [];
    const ranges: SymbolRange[] = [];

    for (const match of matches) {
      for (const capture of match.captures) {
        const node = capture.node;
        const name = capture.name;

        if (name === 'import') {
          imports.push(node.text);
        } else if (name === 'export') {
          exports.push(extractExportFromNode(node));
        } else if (name === 'fn' || name === 'method') {
          functions.push({
            name: resolveFunctionName(node),
            signature: extractFunctionSignature(node),
          });
        }
      }
      ranges.push(...collectRanges(match.captures));
    }

    return { imports, exports, functions, ranges };
  } catch {
    parserLogger.warn(`SCM Query failed, fallback to basic traversal: ${language}`);
    return extractBasic(tree);
  }
}

function extractBasic(tree: Parser.Tree): { imports: string[]; exports: string[]; functions: Array<{ name: string; signature: string }>; ranges: SymbolRange[] } {
  const imports: string[] = [];
  const exports: string[] = [];
  const functions: Array<{ name: string; signature: string }> = [];
  const ranges: SymbolRange[] = [];

  for (const child of tree.rootNode.children) {
    if (child.type === 'import_statement' || child.type === 'import_declaration') {
      imports.push(child.text);
    }
    if (child.type.startsWith('export')) {
      exports.push(extractExportFromNode(child));
    }
    if (child.type === 'function_declaration') {
      const nameNode = child.childForFieldName('name');
      const name = nameNode ? nameNode.text : 'anonymous';
      if (nameNode) {
        functions.push({
          name,
          signature: extractFunctionSignature(child),
        });
      }
      ranges.push({
        name,
        start: child.startPosition.row + 1,
        end: child.endPosition.row + 1,
      });
    }
  }

  return { imports, exports, functions, ranges };
}

/**
 * 文件总行数（行级台账用）：末元素为空串时移除（与 POSIX wc -l 口径一致）。
 */
function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * 把行区间 clip 到 [1, lineCount]；越界（clip 后 start > end）直接丢弃。
 */
function clipRanges(ranges: SymbolRange[], lineCount: number): SymbolRange[] {
  if (lineCount <= 0) return [];
  const result: SymbolRange[] = [];
  for (const range of ranges) {
    const start = Math.max(1, Math.min(range.start, lineCount));
    const end = Math.max(1, Math.min(range.end, lineCount));
    if (start > end) continue;
    result.push({ name: range.name, start, end });
  }
  return result;
}

async function parseFile(
  filePath: string,
  language: string,
  parsers: Map<string, Parser>
): Promise<SymbolInfo | null> {
  const projectRoot = getProjectRoot();
  const fullPath = join(projectRoot, filePath);
  const source = await readTextFile(fullPath);
  const lineCount = countLines(source);

  const parser = parsers.get(language);
  if (!parser) {
    return null;
  }

  if (language === 'vue') {
    const vueParser = parser;
    const tsParser = parsers.get('typescript') || parsers.get('tsx');

    const vueResult = await parseVueSfc(source, vueParser, tsParser);
    return {
      file: filePath,
      exports: vueResult.exports,
      functions: [],
      imports: vueResult.imports,
      docstrings: [],
      lineCount,
      // vue 段不测行区间（语言适配器契约：ranges 为空 = 不测，计入行台账的 gap）
      ranges: [],
    };
  }

  const tree = parser.parse(source);
  const { imports, exports, functions, ranges } = extractWithQuery(tree, language, parser);

  tree.delete();

  return {
    file: filePath,
    exports,
    functions,
    imports,
    docstrings: [],
    lineCount,
    ranges: clipRanges(ranges, lineCount),
  };
}

export async function parseFiles(manifest: FileManifest): Promise<SymbolManifest> {
  parserLogger.info('[PROGRESS] Loading parsers');

  const languages = [...new Set(manifest.files.map(f => f.language))];
  const supportedLanguages = languages.filter(isLanguageSupported);

  parserLogger.info(`Parsers to load: ${supportedLanguages.join(', ')}`);

  const parsers = await loadParsers(supportedLanguages);
  const loadedParsers = [...parsers.keys()];

  parserLogger.info(`[OK] Loaded ${loadedParsers.length} parsers`);

  parserLogger.info('[PROGRESS] Extracting symbols');

  const symbols: SymbolInfo[] = [];
  for (const file of manifest.files) {
    if (!isLanguageSupported(file.language)) {
      continue;
    }

    try {
      const symbolInfo = await parseFile(file.path, file.language, parsers);
      if (symbolInfo) {
        symbols.push(symbolInfo);
      }
    } catch {
      parserLogger.warn(`Parse failed: ${file.path}`);
    }
  }

  parserLogger.info(`[OK] Extracted symbols from ${symbols.length} files`);

  return {
    symbols,
    loadedParsers,
  };
}

export * from './wasm-loader';
export * from './language-map';
export * from './vue-handler';
