import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'pathe'
import ts from 'typescript'
import { createRoutesContext } from '../core/context'
import { resolveOptions } from '../options'
import type * as RoutesFolderWatcherModule from '../core/RoutesFolderWatcher'
import { mockWarn } from '../../../__tests__/vitest-mock-warn'

type ParserEvent = 'add' | 'change'
const { parserWatchers } = vi.hoisted(() => ({
  parserWatchers: [] as Array<
    Map<ParserEvent, (file: string) => Promise<void>>
  >,
}))

vi.mock('chokidar', () => ({
  watch: () => {
    const handlers = new Map<ParserEvent, (file: string) => Promise<void>>()
    parserWatchers.push(handlers)
    return {
      on(event: ParserEvent, handler: (file: string) => Promise<void>) {
        handlers.set(event, handler)
        return this
      },
      close() {},
    }
  },
}))

vi.mock('../core/RoutesFolderWatcher', async importOriginal => ({
  ...(await importOriginal<typeof RoutesFolderWatcherModule>()),
  RoutesFolderWatcher: class {
    on() {
      return this
    }
    close() {}
  },
}))

const parserSource = `import { defineArrayParser, PARAM_PARSER_INT } from 'vue-router/experimental'
export const parser = defineArrayParser(PARAM_PARSER_INT)
`
const sourceDir = fileURLToPath(new URL('../../', import.meta.url))
let root: string
let context: ReturnType<typeof createRoutesContext> | undefined

afterEach(async () => {
  context?.stopWatcher()
  context = undefined
  parserWatchers.length = 0
  if (root) await rm(root, { recursive: true, force: true })
})

async function setup(parser?: string) {
  root = await mkdtemp(join(tmpdir(), 'vue-router-array-types-'))
  await mkdir(join(root, 'src/pages'), { recursive: true })
  await mkdir(join(root, 'src/params'), { recursive: true })
  if (parser) await writeFile(join(root, 'src/params/ids.ts'), parser)
  for (const [name, options] of [
    ['optional', ''],
    ['required', ', required: true'],
    ['defaults', ', default: () => []'],
  ]) {
    await writeFile(
      join(root, `src/pages/${name}.vue`),
      `<script setup lang="ts">
definePage({ name: '${name}', params: { query: { ids: { parser: 'ids', format: 'value'${options} } } } })
</script>`
    )
  }
  await writeFile(
    join(root, 'consumer.ts'),
    await readFile(
      new URL('./fixtures/array-parser-consumer.ts.txt', import.meta.url),
      'utf8'
    )
  )
  context = createRoutesContext(
    resolveOptions({
      root,
      dts: true,
      logs: false,
      experimental: { paramParsers: true },
    })
  )
  await context.scanPages()
}

async function checkGeneratedTypes() {
  expect(context!.generateResolver()).toContain(
    "new MatcherPatternQueryParam('ids', 'ids', 'value', _normalized_PARAM_PARSER__ids)"
  )
  const declarations = await readFile(join(root, 'typed-router.d.ts'), 'utf8')
  expect(declarations).toContain("typeof import('./src/params/ids.ts').parser")
  const declarationDir = join(root, 'router')
  const library = ts.createProgram({
    rootNames: [
      resolve(sourceDir, 'index.ts'),
      resolve(sourceDir, 'experimental/index.ts'),
    ],
    options: {
      declaration: true,
      emitDeclarationOnly: true,
      noCheck: true,
      outDir: declarationDir,
      rootDir: sourceDir,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { 'vue-router': [resolve(sourceDir, 'index.ts')] },
    },
  })
  expect(library.emit().emitSkipped).toBe(false)
  const program = ts.createProgram({
    rootNames: [join(root, 'typed-router.d.ts'), join(root, 'consumer.ts')],
    options: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: {
        'vue-router': [join(declarationDir, 'index.d.ts')],
        'vue-router/experimental': [
          join(declarationDir, 'experimental/index.d.ts'),
        ],
        vue: [resolve(sourceDir, '../node_modules/vue/dist/vue.d.ts')],
        'vue-router/auto-routes': [
          resolve(sourceDir, '../vue-router-auto-routes.d.mts'),
        ],
      },
      types: [],
      allowImportingTsExtensions: true,
    },
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  expect(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: file => file,
      getNewLine: () => '\n',
    })
  ).toBe('')
}

describe('generated delimited array query types', () => {
  mockWarn()

  it('typechecks declarations from the initial file scan', async () => {
    await setup(parserSource)
    await checkGeneratedTypes()
  }, 30_000)

  it.each<ParserEvent>(['add', 'change'])(
    'typechecks declarations after parser watcher %s registration',
    async event => {
      await setup(
        event === 'change'
          ? `import { defineParamParserRaw } from 'vue-router/experimental'; export const parser = defineParamParserRaw({ get: () => 1, set: () => '1' })`
          : undefined
      )
      if (event === 'add') expect('VUE_ROUTER_B0019').toHaveBeenWarnedTimes(3)
      const before = await readFile(join(root, 'typed-router.d.ts'), 'utf8')
      await writeFile(join(root, 'src/params/ids.ts'), parserSource)
      await parserWatchers[0]!.get(event)!('ids.ts')
      await vi.waitFor(async () => {
        const declarations = await readFile(
          join(root, 'typed-router.d.ts'),
          'utf8'
        )
        expect(declarations).not.toBe(before)
        expect(declarations).toContain('export {}')
      })
      await checkGeneratedTypes()
    },
    30_000
  )
})
