import vm from 'vm'
import * as t from '@babel/types'
import { objGet } from './utils'
import { resolveImportPath } from './require'
import _ from 'lodash'

export const symbols = {
  defaultExport: Symbol('defaultExport'),
  namespaceExport: Symbol('namespaceExport'),
}

type Lookup<TVal = any> = Record<string | symbol, TVal>
const emptyLookup = (): Lookup => ({})

/** Object used to resolve an imported value */
export class Import {
  /** @param local is the local identifier in the `importedNamespace` */
  constructor(
    public namespace: string,
    public importedNamespace: string,
    public local: string | symbol,
  ) {}
}

/** Values by namespace */
export let valuesLookup: Lookup<Lookup> = {}
export const resetValuesLookup = () => (valuesLookup = {})
/** Exports by namespace. The values of which are just identifiers */
export let exportsLookup: Lookup<Lookup<string | symbol>> = {}
export const resetExportsLookup = () => (exportsLookup = {})

function doRegisterValue(namespace: string, key: string, value: any) {
  const values = objGet(valuesLookup, namespace, {})
  values[key] = value
  return value
}

/**
 * @param local is the identifier within the namespace
 * @param exported is the identifier exposed to other namespaces
 */
export function doRegisterExport(
  namespace: string,
  local: string,
  exported: string,
) {
  const exportsValues = objGet(exportsLookup, namespace, {})

  const values = objGet(valuesLookup, namespace, {})
  if (!(local in values)) {
    throw new Error(`Failed named export due to missing local ${local}`)
  }
  exportsValues[exported] = local
  // TODO Maybe prefix return with `exports.`?
  return exported
}

function doRegisterDefaultExport(namespace: string, local: string) {
  const exportsValues = objGet(exportsLookup, namespace, {})
  const values = objGet(valuesLookup, namespace, {})
  if (!(local in values)) {
    throw new Error(`Failed default export due to missing local ${local}`)
  }
  exportsValues[symbols.defaultExport] = local
  return symbols.defaultExport.toString()
}

function doRegisterImport(
  namespace: string,
  localName: string,
  importedNamespace: string,
  importedName: string,
) {
  const importedNamespaceResolved = resolveImportPath(
    namespace,
    importedNamespace,
  )
  const importedNamespaceExports = objGet(
    exportsLookup,
    importedNamespaceResolved,
    {},
  )
  if (!(importedName in importedNamespaceExports)) {
    throw new Error(
      `Failed import due to missing export ${importedName} from namespace ${importedNamespaceResolved}`,
    )
  }
  const values = objGet(valuesLookup, namespace, {})
  values[localName] = new Import(
    namespace,
    importedNamespaceResolved,
    importedName,
  )
}

function doRegisterDefaultImport(
  namespace: string,
  localName: string,
  importedNamespace: string,
) {
  const importedNamespaceResolved = resolveImportPath(
    namespace,
    importedNamespace,
  )
  const importedNamespaceExports = objGet(
    exportsLookup,
    importedNamespaceResolved,
    {},
  )
  if (!(symbols.defaultExport in importedNamespaceExports)) {
    throw new Error(
      `Failed import due to missing default export from namespace ${importedNamespaceResolved}`,
    )
  }
  const values = objGet(valuesLookup, namespace, {})
  values[localName] = new Import(
    namespace,
    importedNamespaceResolved,
    symbols.defaultExport,
  )
}

function doRegisterNamespaceImport(
  namespace: string,
  localNamespaceName: string,
  importedNamespace: string,
) {
  const values = objGet(valuesLookup, namespace, {})
  const importedNamespaceObj = new Proxy(
    {},
    {
      get(target, prop) {
        const importedNamespaceResolved = resolveImportPath(
          namespace,
          importedNamespace,
        )
        const importedNamespaceExports = objGet(
          exportsLookup,
          importedNamespaceResolved,
          {},
        )
        const importedNamespaceValues = objGet(
          valuesLookup,
          importedNamespaceResolved,
          {},
        )
        const local = importedNamespaceExports[prop]
        return importedNamespaceValues[local] ?? target[prop]
      },
    },
  )

  values[localNamespaceName] = importedNamespaceObj
}

/** Returns the context for the evaluation VM */
export function generateContext(namespace: string) {
  const base = Object.create(null)
  for (const k of Object.getOwnPropertyNames(global)) {
    base[k] = global[k]
  }
  base[doRegisterValue.name] = doRegisterValue
  base[doRegisterExport.name] = doRegisterExport
  base[doRegisterDefaultExport.name] = doRegisterDefaultExport
  base[doRegisterImport.name] = doRegisterImport
  base[doRegisterDefaultImport.name] = doRegisterDefaultImport
  base[doRegisterNamespaceImport.name] = doRegisterNamespaceImport

  const dynamicContext = new Proxy(base, {
    get(target, prop) {
      const values = objGet(valuesLookup, namespace, emptyLookup())
      const value = values[prop]
      if (prop in values) {
        if (!(value instanceof Import)) return value
        // Otherwise, resolve an import
        const exportsValues = objGet(
          exportsLookup,
          value.importedNamespace,
          emptyLookup(),
        )
        const importedNamespaceValues = objGet(
          valuesLookup,
          value.importedNamespace,
          emptyLookup(),
        )
        const importedNamespaceLocal = exportsValues[value.local]
        return importedNamespaceValues[importedNamespaceLocal]
      }
      // Lastly, fallback to globals
      return target[prop]
    },
    // TODO Also use `set` to conveniently update lookups?
  })
  return vm.createContext(dynamicContext)
}

export function nonGlobals(context: Record<string | symbol, any> = {}) {
  return Reflect.ownKeys(context)
    .filter((k) => !(k in global))
    .map((k) => [k, context[k]])
}

// --- Transform utils ---

export function registerValue(
  fileName: string,
  key: string,
  expression: t.Expression,
) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterValue.name), [
      t.stringLiteral(fileName),
      t.stringLiteral(key),
      expression,
    ]),
  )
}

export function registerDefaultExport(fileName: string, key: string) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterDefaultExport.name), [
      t.stringLiteral(fileName),
      t.stringLiteral(key),
    ]),
  )
}

export function registerExport(
  fileName: string,
  key: string,
  exportAs: string,
) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterExport.name), [
      t.stringLiteral(fileName),
      t.stringLiteral(key),
      t.stringLiteral(exportAs),
    ]),
  )
}

export function registerImport(
  namespace: string,
  localName: string,
  importedNamespace: string,
  importedName: string,
) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterImport.name), [
      t.stringLiteral(namespace),
      t.stringLiteral(localName),
      t.stringLiteral(importedNamespace),
      t.stringLiteral(importedName),
    ]),
  )
}

export function registerDefaultImport(
  namespace: string,
  localName: string,
  importedNamespace: string,
) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterDefaultImport.name), [
      t.stringLiteral(namespace),
      t.stringLiteral(localName),
      t.stringLiteral(importedNamespace),
    ]),
  )
}

export function registerNamespaceImport(
  namespace: string,
  localNamespaceName: string,
  importedNamespace: string,
) {
  return t.expressionStatement(
    t.callExpression(t.identifier(doRegisterNamespaceImport.name), [
      t.stringLiteral(namespace),
      t.stringLiteral(localNamespaceName),
      t.stringLiteral(importedNamespace),
    ]),
  )
}
