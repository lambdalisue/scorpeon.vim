import { cache_dir, join, oniguruma, vsctm } from "./deps.ts";
import { Grammar, Language, readPackageJsons } from "./json.ts";

export interface Token {
  line: number;
  column: number;
  length: number;
  scopes: string[];
}

interface PrevData {
  lines: string[];
  stacks: vsctm.StateStack[];
  tokens: Token[];
}

export class Tokenizer {
  languages: Language[];
  grammars: Grammar[];
  registry: vsctm.Registry;
  prevDatas: { [bufnr: number]: PrevData };

  constructor(dirs: string[]) {
    [this.languages, this.grammars] = readPackageJsons(dirs);
    this.registry = new vsctm.Registry({
      onigLib: this.getOnigLib(),
      loadGrammar: async (scopeName: string) => {
        const grammarPath = this.grammars
          .filter((v) => v.scopeName === scopeName)
          ?.[0]
          ?.path;
        if (grammarPath == null) {
          return null;
        }
        return await Deno.readTextFile(grammarPath)
          .then((data: string) => vsctm.parseRawGrammar(data, grammarPath));
      },
    });
    this.prevDatas = {};
  }

  async getOnigLib(): Promise<vsctm.IOnigLib> {
    const denoDir = getDenoDir();
    if (denoDir == null) {
      return Promise.reject("Can't get deno directory");
    }
    const wasmBin = Deno.readFileSync(
      join(
        denoDir,
        "npm",
        "registry.npmjs.org",
        "vscode-oniguruma",
        "1.6.2",
        "release",
        "onig.wasm",
      ),
    );
    return await oniguruma.loadWASM(wasmBin).then(() => {
      return {
        createOnigScanner(patterns: string[]) {
          return new oniguruma.OnigScanner(patterns);
        },
        createOnigString(s: string) {
          return new oniguruma.OnigString(s);
        },
      };
    });
  }

  getScopeName(filepath: string): Promise<string> {
    const language = this.languages
      .filter((v) => v.extensions.some((ext) => filepath.endsWith(ext)))
      ?.[0]
      ?.id;
    if (language == null) {
      return Promise.reject(`Path with unknown extensions: ${filepath}`);
    }
    const scopeName = this.grammars
      .filter((v) => v.language === language)
      ?.[0]
      ?.scopeName;
    if (scopeName == null) {
      return Promise.reject(`Unknown language: ${language}`);
    }
    return Promise.resolve(scopeName);
  }

  async parse(
    bufnr: number,
    scopeName: string,
    lines: string[],
  ): Promise<[Token[], number]> {
    if (!this.prevDatas[bufnr]) {
      this.prevDatas[bufnr] = {
        lines: [],
        stacks: [],
        tokens: [],
      };
    }
    const prevData = this.prevDatas[bufnr];

    // First changed line. Parsing is only needed after this line.
    const start = lines.findIndex((e, i) => e !== prevData.lines[i]);
    if (start === -1) {
      // No change
      return [prevData.tokens, start];
    } else {
      // token.line is 1-index, start is 0-index
      prevData.tokens = prevData.tokens.filter((token) => token.line < start + 1);
    }

    return await this.registry.loadGrammar(scopeName)
      .then((grammar: vsctm.IGrammar | null): [Token[], number] => {
        if (grammar == null) {
          return [[], 0];
        }
        const tokens = [];
        let ruleStack = prevData.stacks[start - 1] ||
          vsctm.INITIAL;
        for (let i = start; i < lines.length; i++) {
          const line = lines[i];
          const lineTokens = grammar.tokenizeLine(line, ruleStack);
          for (const itoken of lineTokens.tokens) {
            const startIndex = toByteIndex(line, itoken.startIndex);
            const endIndex = toByteIndex(line, itoken.endIndex);
            const token = {
              line: i + 1,
              column: startIndex + 1,
              length: endIndex - startIndex,
              scopes: itoken.scopes,
            };
            tokens.push(token);
            prevData.tokens.push(token);
          }
          ruleStack = lineTokens.ruleStack;
          prevData.stacks[i] = lineTokens.ruleStack;
        }
        prevData.lines = lines;
        return [tokens, start];
      });
  }
}

const getDenoDir = () => {
  const DENO_DIR = Deno.env.get("DENO_DIR");
  if (DENO_DIR) {
    return DENO_DIR;
  }
  const cache = cache_dir();
  if (cache) {
    return join(cache, "deno");
  }
};

const toByteIndex = (str: string, idx: number): number => {
  return (new TextEncoder()).encode(str.slice(0, idx)).length;
};
