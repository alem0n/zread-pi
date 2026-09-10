export const WASM_CDN_URL = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.13/out';

export const WASM_FILE_MAP: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  vue: 'tree-sitter-vue.wasm',
  go: 'tree-sitter-go.wasm',
  python: 'tree-sitter-python.wasm',
  php: 'tree-sitter-php.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
};

export const PARSER_CACHE_DIR = '~/.zread/parsers';
