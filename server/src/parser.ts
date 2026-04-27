import { Parser, Tree, Language } from 'web-tree-sitter';
import { resolve } from 'path';

let parserInstance: Parser | null = null;
let language: Language | null = null;

export async function initParser(wasmPath?: string): Promise<void> {
  if (parserInstance) return;
  await Parser.init();
  parserInstance = new Parser();
  const resolved = wasmPath ?? resolve(__dirname, '..', 'tree-sitter-pike.wasm');
  language = await Language.load(resolved);
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
