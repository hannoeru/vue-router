import type { TreeParam, TreePathParam } from '../core/treeNodeValue'
import type { ImportsMap } from '../core/utils'
import type { PrefixTree } from '../core/tree'
import { toStringLiteral } from '../utils'
import { diagnostics } from '../diagnostics'
import { glob } from 'tinyglobby'
import { babelParse, walkAST } from '@vue-macros/common'
import { promises as fs } from 'node:fs'
import { parse as parsePathe, relative, resolve } from 'pathe'
import { camelCase } from 'scule'
import type {
  ExportNamedDeclaration,
  ImportDeclaration,
  Program,
  VariableDeclaration,
} from '@babel/types'

export type ParamParsersMap = Map<
  string,
  {
    name: string
    /**
     * The name of the generated type for this parser, e.g. `Param_date`.
     */
    typeName: `Param_${string}`

    relativePath: string

    absolutePath: string

    /**
     * Whether the parser was created via `defineParamParserRaw`. Raw parsers
     * bypass the automatic array/null lifting in the generated route param
     * types and force `format: 'array'` for query params. Optional; when
     * absent, the parser is treated as non-raw.
     */
    isRaw?: boolean

    /** Output arrays are not necessarily repeated URL values. */
    outputShape?: 'array'
  }
>

// just for type strictness
const _NATIVE_PARAM_PARSERS = [
  'int',
  'bool',
  'string',
  'float',
  'index',
  'hex',
  'date',
  'datetime',
  'timestamp',
  'json',
] as const
const NATIVE_PARAM_PARSERS = _NATIVE_PARAM_PARSERS as readonly string[]
const NATIVE_PARAM_PARSERS_TYPES = {
  int: 'number',
  bool: 'boolean',
  string: 'string',
  float: 'number',
  index: 'number',
  hex: 'number',
  date: 'Date',
  datetime: 'Date',
  timestamp: 'Date',
  json: 'unknown',
} satisfies Record<(typeof _NATIVE_PARAM_PARSERS)[number], string>

const RAW_PARAM_PARSER_DEFINER = 'defineParamParserRaw'
const PARAM_PARSER_MODULE = 'vue-router/experimental'

function isInitDefinerCall(
  declarator: VariableDeclaration['declarations'][number],
  localName: string
): boolean {
  const init = declarator.init
  return (
    !!init &&
    init.type === 'CallExpression' &&
    init.callee.type === 'Identifier' &&
    init.callee.name === localName
  )
}

/**
 * Detects whether a param parser source file declares its `parser` export via
 * `defineParamParserRaw` (from `vue-router/experimental`). Aliased imports are
 * supported.
 *
 * Returns `false` when the file doesn't import the raw definer, when the
 * `parser` export uses something else, or when the source can't be parsed.
 *
 * @internal
 */
export function isRawParamParserSource(
  source: string,
  filename: string = 'parser.ts'
): boolean {
  return isParamParserDefinerSource(source, filename, RAW_PARAM_PARSER_DEFINER)
}

function isParamParserDefinerSource(
  source: string,
  filename: string,
  definer: string
): boolean {
  let ast: Program | undefined
  try {
    ast = babelParse(source, /\.tsx?$/.test(filename) ? 'ts' : 'js')
  } catch {
    return false
  }

  let localName: string | null = null
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue
    const imp = node as ImportDeclaration
    if (imp.source.value !== PARAM_PARSER_MODULE) continue
    for (const spec of imp.specifiers) {
      if (
        spec.type === 'ImportSpecifier' &&
        spec.imported.type === 'Identifier' &&
        spec.imported.name === definer
      ) {
        localName = spec.local.name
        break
      }
    }
    if (localName) break
  }

  if (!localName) return false

  const parserLocals = new Set<string>()
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        if (
          declarator.id.type === 'Identifier' &&
          isInitDefinerCall(declarator, localName)
        ) {
          parserLocals.add(declarator.id.name)
        }
      }
    }
  }

  let matched = false
  walkAST(ast, {
    enter(node) {
      if (matched) return
      if (node.type !== 'ExportNamedDeclaration') return
      const exportNode = node as ExportNamedDeclaration
      if (exportNode.source) {
        const reExportsParser = exportNode.specifiers.some(
          spec =>
            spec.type === 'ExportSpecifier' &&
            spec.exported.type === 'Identifier' &&
            spec.exported.name === 'parser'
        )
        if (reExportsParser && definer === RAW_PARAM_PARSER_DEFINER) {
          diagnostics.VUE_ROUTER_B0018({
            filename,
            source: exportNode.source.value,
          })
        }
        return
      }
      if (exportNode.declaration?.type === 'VariableDeclaration') {
        const decl = exportNode.declaration as VariableDeclaration
        for (const declarator of decl.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            declarator.id.name === 'parser' &&
            isInitDefinerCall(declarator, localName)
          ) {
            matched = true
            return
          }
        }
        return
      }
      for (const spec of exportNode.specifiers) {
        if (
          spec.type === 'ExportSpecifier' &&
          spec.exported.type === 'Identifier' &&
          spec.exported.name === 'parser' &&
          spec.local.type === 'Identifier' &&
          parserLocals.has(spec.local.name)
        ) {
          matched = true
          return
        }
      }
    },
  })

  return matched
}

/**
 * Reads a param parser file from disk and registers (or replaces) the matching
 * entry in `paramParsersMap`. Used by both the initial scan and the watcher's
 * `add` handler.
 *
 * @internal
 */
export async function addParamParserToMap(
  file: string,
  folder: string,
  dtsDir: string,
  paramParsersMap: ParamParsersMap
): Promise<void> {
  const fileName = parsePathe(file).name
  const name = camelCase(fileName)
  // TODO: could be simplified to only one import that starts with / for vite
  const absolutePath = resolve(folder, file)
  const source = await fs.readFile(absolutePath, 'utf8')
  paramParsersMap.set(fileName, {
    name,
    typeName: `Param_${name}`,
    absolutePath,
    relativePath: relative(dtsDir, absolutePath),
    isRaw: isRawParamParserSource(source, absolutePath),
    ...(isParamParserDefinerSource(
      source,
      absolutePath,
      'defineArrayParser'
    ) && {
      outputShape: 'array' as const,
    }),
  })
}

/**
 * Scans a folder for param parser files matching `include` while filtering out `exclude`.
 * Only flat matches are returned (no nested folders). Exported solely to make this
 * filesystem-touching behavior testable.
 *
 * @internal
 */
export function scanParamParserFiles(
  folder: string,
  include: string[],
  exclude: string[]
): Promise<string[]> {
  if (!include.length) return Promise.resolve([])
  return glob(include as string[], {
    cwd: folder,
    onlyFiles: true,
    ignore: exclude as string[],
    expandDirectories: false,
  })
}

export function warnMissingParamParsers(
  tree: PrefixTree,
  paramParsers: ParamParsersMap
) {
  for (const node of tree.getChildrenDeepSorted()) {
    for (const param of node.params) {
      if (param.parser && !paramParsers.has(param.parser)) {
        if (!NATIVE_PARAM_PARSERS.includes(param.parser)) {
          diagnostics.VUE_ROUTER_B0019({
            parser: param.parser,
            fullPath: node.fullPath,
          })
        }
      }
    }
  }
}

export interface MissingParamParser {
  parser: string
  routePath: string
  filePaths: string[]
}

/**
 * Walks the route tree and returns the set of parser names referenced by any
 * path or query param. Native parser names (`int`, `bool`) and references to
 * parsers not present on disk are included as-is, leaving the decision of
 * how to handle them to the caller.
 */
export function collectUsedParamParserNames(tree: PrefixTree): Set<string> {
  const used = new Set<string>()
  for (const node of tree.getChildrenDeepSorted()) {
    for (const param of node.params) {
      if (param.parser) {
        used.add(param.parser)
      }
    }
  }
  return used
}

export function collectMissingParamParsers(
  tree: PrefixTree,
  paramParsers: ParamParsersMap
): MissingParamParser[] {
  const missing: MissingParamParser[] = []
  for (const node of tree.getChildrenDeepSorted()) {
    for (const param of node.params) {
      if (param.parser && !paramParsers.has(param.parser)) {
        if (!NATIVE_PARAM_PARSERS.includes(param.parser)) {
          missing.push({
            parser: param.parser,
            routePath: node.fullPath,
            filePaths: Array.from(node.value.components.values()),
          })
        }
      }
    }
  }
  return missing
}

export function generateParamParsersTypesDeclarations(
  paramParsers: ParamParsersMap
) {
  return (
    Array.from(paramParsers.values())
      .map(({ typeName, relativePath }) => {
        const importPath = relativePath.startsWith('.')
          ? relativePath
          : './' + relativePath
        return `type ${typeName} = _ExtractParamParserType<typeof import('${importPath}').parser>`
      })
      // ensure deterministic order for testing, readability and git
      .sort()
      .join('\n')
  )
}

export function generateParamsTypes(
  params: TreeParam[],
  parparsersMap: ParamParsersMap
): Array<string | null> {
  return params.map(param => {
    if (param.parser) {
      if (parparsersMap.has(param.parser)) {
        return parparsersMap.get(param.parser)!.typeName
      } else if (param.parser in NATIVE_PARAM_PARSERS_TYPES) {
        return NATIVE_PARAM_PARSERS_TYPES[
          param.parser as keyof typeof NATIVE_PARAM_PARSERS_TYPES
        ]
      }
    }
    return null
  })
}

export function generateParamParserOptions(
  param: TreeParam,
  importsMap: ImportsMap,
  paramParsers: ParamParsersMap
): string {
  if (!param.parser) return ''

  // we prioritize custom parsers to let users override them
  if (paramParsers.has(param.parser)) {
    const { name } = paramParsers.get(param.parser)!
    return `_normalized_PARAM_PARSER__${name}`
    // 'string' is the implicit default but it's part of NATIVE_PARAM_PARSERS
    // so we need to skip it here
  } else if (param.parser === 'string') {
    return ''
  } else if (NATIVE_PARAM_PARSERS.includes(param.parser)) {
    const varName = `PARAM_PARSER_${param.parser.toUpperCase()}`
    importsMap.add('vue-router/experimental', varName)
    return varName
  }
  return ''
}

export function generateNormalizedParamParsersDeclarations(
  paramParsers: ParamParsersMap,
  importsMap: ImportsMap
): string {
  const declarations: string[] = []
  for (const [, { name, absolutePath }] of paramParsers) {
    const rawVar = `PARAM_PARSER__${name}`
    const normalizedVar = `_normalized_PARAM_PARSER__${name}`
    importsMap.add('vue-router/experimental', '_normalizeParamParser')
    importsMap.add(absolutePath, { name: 'parser', as: rawVar })
    declarations.push(
      `const ${normalizedVar} = _normalizeParamParser(${rawVar})`
    )
  }
  return declarations.join('\n')
}

/**
 * Generates one entry per registered custom parser for the
 * `TypesConfig._ParamParsers` augmentation, e.g.
 * `'date': { type: Param_date }`. Returns an empty array when there are no
 * custom parsers so the consumer can emit an empty object literal.
 */
export function generateCustomParamParsersList(
  paramParsers: ParamParsersMap
): string[] {
  return Array.from(paramParsers.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, { typeName }]) => `${toStringLiteral(key)}: { type: ${typeName} }`
    )
}

export function generatePathParamsOptions(
  params: TreePathParam[],
  importsMap: ImportsMap,
  paramParsers: ParamParsersMap
) {
  const paramOptions = params.map(param => {
    // build a lean option list without any optional value
    const optionList: string[] = []
    const parser = generateParamParserOptions(param, importsMap, paramParsers)
    optionList.push(parser || `/* no parser */`)
    if (param.optional || param.repeatable) {
      optionList.push(
        `/* repeatable: ` + (param.repeatable ? `*/ true` : `false */`)
      )
    }
    if (param.optional) {
      optionList.push(
        `/* optional: ` + (param.optional ? `*/ true` : `false */`)
      )
    }
    return `
${param.paramName}: [${optionList.join(', ')}],
`.slice(1, -1)
  })

  return paramOptions.length === 0
    ? '{}'
    : `{
      ${paramOptions.join('\n      ')}
    }`
}
