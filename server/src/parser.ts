import { Parser, Tree, Language } from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';


let parserInstance: Parser | null = null;
let language: Language | null = null;

export async function initParser(wasmPath?: string): Promise<void> {
  if (parserInstance) return;
  await Parser.init();
  parserInstance = new Parser();
  // Try WASM in multiple locations:
  // 1. Explicit path provided by caller
  // 2. Same directory as this module (standalone bundle)
  // 3. One level up (tsc output: dist/server/src/ -> dist/server/)
  // 4. Sibling to server/ directory (extension bundle: server/dist/ -> server/)
  // Resolve __dirname equivalent that works in both CJS (tsc) and ESM (esbuild)
  const thisDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const candidates = wasmPath ? [wasmPath] : [
    resolve(thisDir, 'tree-sitter-pike.wasm'),
    resolve(thisDir, '..', 'tree-sitter-pike.wasm'),
    resolve(thisDir, '..', '..', 'tree-sitter-pike.wasm'),
  ];
  let loaded = false;
  for (const candidate of candidates) {
    try {
      language = await Language.load(candidate);
      loaded = true;
      break;
    } catch {
      // Try next location
    }
  }
  if (!loaded) {
    throw new Error(`tree-sitter-pike.wasm not found. Searched: ${candidates.join(', ')}`);
  }
  parserInstance.setLanguage(language);
}

export function parse(source: string): Tree {
  if (!parserInstance) throw new Error('Parser not initialized — call initParser() first');
  const tree = parserInstance.parse(source);
  if (!tree) throw new Error('Parse returned null — is a language set?');
  return tree;
}

export function getLanguage(): Language {
  if (!language) throw new Error('Language not loaded — call initParser() first');
  return language;
}
