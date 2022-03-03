import vm from 'vm';
import _ from 'lodash';
import { v4 as uuid } from 'uuid';
import { createRequire } from 'module';
import fsPath from 'path';
import fs from 'fs';
import * as babel from '@babel/core';
import * as t from '@babel/types';
import { Binding, NodePath, Scope } from '@babel/traverse';
import { PluginPass } from '@babel/core';

const symbols = {
  defaultExport: Symbol('[[defaultExport]]'),
  namespaceExport: Symbol('[[namespaceExport]]')
}

type Namespace = string;

type NamespaceValuesByKey = Map<string, any>;
const namespaces = new Map<Namespace, NamespaceValuesByKey>();

// Exports have an exported name and a local name (they could be the same). When looking up
// an export, the lookup key is exported name. Which internally (within the namespace), resolves
// to some value pointed to, by the local name.
interface Export {
  exported: string | symbol;
  local: string;
}
type ExportsByExported = Map<Export['exported'], Export>;
const valueExports = new Map<Namespace, ExportsByExported>();

// Imports have an imported name and a local name (they could be the same). When constructing
// the env's scope, we want to use the latter (if defined).
// The former is used to resolve the import from the source module (of the import)
interface Import {
  importedNamespace: Namespace
  imported: string | symbol;
  local: string;
  isBuiltIn?: boolean;
}
type ImportsByLocal = Map<Import['local'], Import>;
const valueImports = new Map<Namespace, ImportsByLocal>();

interface NamespaceImport {
  importedNamespace: Namespace
  local: string;
}
type NamespaceImportsByLocal = Map<NamespaceImport['local'], NamespaceImport>;
const namespaceImports = new Map<Namespace, NamespaceImportsByLocal>();

function requireCustom(importingNamespace: string, importedNamespace: string, evalImports?: boolean, debug?: boolean) {
  const requiredNsNormalized = normalizeImportPath(importingNamespace, importedNamespace);
  const isBuiltIn = !fsPath.isAbsolute(importedNamespace);
  if (isBuiltIn) {
    return createRequire(importingNamespace)(requiredNsNormalized);
  }

  if (evalImports) {
    evaluate(requiredNsNormalized, fs.readFileSync(requiredNsNormalized, { encoding: 'utf8' }), evalImports, debug);
  }
  const defaultExport = valueExports.get(requiredNsNormalized)?.get(symbols.defaultExport);
  const result = defaultExport && namespaces.get(requiredNsNormalized)?.get(defaultExport.local);
  return result;
}

export function evaluate(namespace: string, code: string, evalImports?: boolean, debug?: boolean) {
  const codeTransformed = transform(namespace, code, evalImports, debug);

  if (debug) {
    console.log(`code transformed:\n${codeTransformed}`);
    console.log();
  }

  const ns: NamespaceValuesByKey = namespaces.get(namespace) || new Map();
  const nsImports: ImportsByLocal = valueImports.get(namespace) || new Map();

  const nsImportsForScope = {};
  for (const [local, { importedNamespace, imported, isBuiltIn }] of nsImports.entries()) {
    if (!isBuiltIn && imported === symbols.namespaceExport) {
      nsImportsForScope[local] = constructNamespaceExport(importedNamespace);
    } else if (isBuiltIn) {
      const module = createRequire(namespace)(importedNamespace);
      switch (imported) {
        case symbols.defaultExport:
          nsImportsForScope[local] = module;
          break;
        case symbols.namespaceExport:
          nsImportsForScope[local] = module;
          break;
        default:
          nsImportsForScope[local] = module[imported];
          break;
      }
    } else {
      const nsExports = valueExports.get(importedNamespace);
      const exported = nsExports?.get(imported);
      const exportedValue = exported && namespaces.get(importedNamespace)?.get(exported.local);
      nsImportsForScope[local] = exportedValue;
    }
  }

  const exportsStub = new Proxy({}, {
    set(obj, prop, value) {
      const localKeyOfDefaultExport = valueExports.get(namespace)?.get(symbols.defaultExport)?.local;
      if (localKeyOfDefaultExport) {
        const defaultExport = namespaces.get(namespace)?.get(localKeyOfDefaultExport);
        if (defaultExport) {
          defaultExport[prop] = value;
        }
      } else {
        const id = uuid();
        registerValue(namespace, id, { [prop]: value });
        registerDefaultValueExport(namespace, id);
      }
      return true;
    },
    get(target, prop, receiver) {
      // TODO Find out if `exports.default` needs to be supported
      const exportsOfNs = valueExports.get(namespace)?.values() || [];
      const exportValue = [...exportsOfNs].find(e => e.local === prop);
      return exportValue;
    }
  })

  const requireStub = importedNamespace => requireCustom(namespace, importedNamespace, evalImports, debug);

  const moduleStub = new Proxy({
    exports: exportsStub
  }, {
    set(obj, prop, value) {
      obj[prop] = value;

      if (prop === 'exports') {
        const id = uuid();
        registerValue(namespace, id, value);
        registerDefaultValueExport(namespace, id);

        // for (const [k, v] of Object.entries(value)) {
        //   const id = uuid();
        //   registerValue(namespace, id, v);
        //   registerValueExport(namespace, id, k);
        // }
      }
      return true;
    }
  });
  const __filenameStub = namespace;
  const __dirnameStub = fsPath.dirname(namespace);
  const cjsStubs = {
    module: moduleStub,
    exports: moduleStub.exports,
    require: requireStub,
    __filename: __filenameStub,
    __dirname: __dirnameStub
  };

  const nsForScope = _([...ns.entries()])
    .map(([k, v]) => [k, v])
    .fromPairs()
    .value();

  if (debug) {
    // console.log('all exports', namespaceExports);
    console.log('all imports', namespaceImports);
    console.log('ns imports for scope', nsImportsForScope);
    console.log('ns for scope', nsForScope);
  }

  const vmGlobal = {};
  const globalProps = Object.getOwnPropertyNames(global);
  for (const k of globalProps) {
    vmGlobal[k] = global[k];
  }

  const result = vm.runInContext(`
  with (nsImportsForScope) {
    with (nsForScope) {
      (function () {
        "use strict";
        try {
            ${codeTransformed}
        } catch (e) {
          console.error(e);
        }
      })();
    }
  }`, vm.createContext({
    ...vmGlobal,
    ...cjsStubs,
    nsImportsForScope,
    nsForScope,
    registerValue,
    registerValueExport,
    registerValueImport,
    registerDefaultValueExport,
    dynamicImport,
  }), {
    filename: namespace,
    microtaskMode: undefined,
    lineOffset: -5, columnOffset: -11 // TODO Is this correct?
  });
  return result;
}

function constructNamespaceExport(namespace: string) {
  const values: NamespaceValuesByKey = namespaces.get(namespace) || new Map();
  const exports: ExportsByExported = valueExports.get(namespace) || new Map();
  const nsExport = _([...exports.values()])
    .map(({ exported, local }) => {
      const v = values.get(local);
      switch (exported) {
        case symbols.defaultExport: return ['default', v];
        default: return [exported, v];
      }
    })
    .filter(x => !!x)
    .fromPairs()
    .value();
  return nsExport;
}

function registerValue(namespace: string, key: string, value: any) {
  const values: NamespaceValuesByKey = namespaces.get(namespace) || new Map();
  namespaces.set(namespace, values);
  values.set(key, value);
  return value;
}

function registerValueExport(
  namespace: string,
  local: Export['local'],
  exported: Export['exported']
) {
  const nsExports: ExportsByExported = valueExports.get(namespace) || new Map();
  valueExports.set(namespace, nsExports);
  nsExports.set(exported, { exported, local });
  return exported;
}

function registerDefaultValueExport(
  namespace: string,
  local: Export['local']
) {
  const exports: ExportsByExported = valueExports.get(namespace) || new Map();
  valueExports.set(namespace, exports);
  exports.set(symbols.defaultExport, { exported: symbols.defaultExport, local });
  return symbols.defaultExport.toString();
}

function registerValueImport(
  importingNamespace: string,
  local: Import['local'],
  imported: Import['imported'],
  importedNamespace: string,
  isBuiltIn = false
) {
  const absoluteImportedNamespace = normalizeImportPath(importingNamespace, importedNamespace);
  const imports: ImportsByLocal = valueImports.get(importingNamespace) || new Map();
  valueImports.set(importingNamespace, imports);
  imports.set(local, { imported, local, importedNamespace: absoluteImportedNamespace, isBuiltIn });
  return local;
}

function dynamicImport(
  importingNamespace: string,
  importedNamespace: string,
  evalImports?: boolean,
  debug?: boolean
) {
  const importedNamespaceNormalized = normalizeImportPath(importingNamespace, importedNamespace);
  const isBuiltIn = !fsPath.isAbsolute(importedNamespaceNormalized);
  if (isBuiltIn) {
    return Promise.resolve(createRequire(importingNamespace)(importedNamespaceNormalized));
  }

  if (evalImports) {
    evaluate(importedNamespaceNormalized, fs.readFileSync(importedNamespaceNormalized, { encoding: 'utf8' }), evalImports, debug);
  }
  return Promise.resolve(constructNamespaceExport(importedNamespaceNormalized));
}

export function transform(namespace: string, code: string, evalImports?: boolean, debug?: boolean) {
  const output = babel.transformSync(code, {
    plugins: [transformer(evalImports, debug)],
    filename: namespace,
    parserOpts: {
      allowUndeclaredExports: true,
    }
  });
  return output?.code;
}

function extractFileName(state: PluginPass) {
  const { filename } = state.file.opts;
  if (!filename) {
    throw Error('No filename');
  }
  return filename;
}

function transformer(evalImports?: boolean, debug?: boolean) {
  return () => ({
    visitor: {
      Program(path: NodePath<t.Program>, state: PluginPass) {
        const fileName = extractFileName(state);
        for (const [bindingKey, binding] of Object.entries(path.scope.bindings)) {
          // console.log('BINDING:', bindingKey, 'path node type:', binding.path.type);
          // NOTE: Imports are not bound/stored as values within the namespace. They are instead
          // resolved dynamically when evaluating code.
          if (binding.path.type === 'ImportSpecifier'
            || binding.path.type === 'ImportDefaultSpecifier'
            || binding.path.type === 'ImportNamespaceSpecifier') {
            continue;
          }
          const registerValueExpr = t.expressionStatement(
            t.callExpression(
              t.identifier(registerValue.name), [
              t.stringLiteral(fileName),
              t.stringLiteral(binding.identifier.name),
              binding.identifier
            ])
          );
          const parent = binding.path.parentPath;
          if (!parent) continue;
          // For variable declarations, the parent is "VariableDeclaration".
          // If we insert after the path (not the parent), we get something like:
          // `const x = 10, <inserted here>` which we don't want.
          // Instead we want something like:
          // ```
          // const x = 10;
          // <inserted here>
          // ```
          if (parent.type !== 'Program') {
            parent.insertAfter(registerValueExpr);
          } else {
            binding.path.insertAfter(registerValueExpr);
          }
        }
      },
      CallExpression(path: NodePath<t.CallExpression>, state: PluginPass) {
        if (path.node.callee.type !== 'Import') {
          return;
        }

        const fileName = extractFileName(state);
        const dynamicImportExpr = t.expressionStatement(
          t.callExpression(
            t.identifier(dynamicImport.name), [
            t.stringLiteral(fileName),
            path.node.arguments[0],
            t.booleanLiteral(!!evalImports),
            t.booleanLiteral(!!debug)
          ])
        );
        path.replaceWith(dynamicImportExpr);
      },
      ExpressionStatement(path: NodePath<t.ExpressionStatement>, state: PluginPass) {
        if (path.scope.block.type !== 'Program') {
          return; // Not a global declaration
        }

        const isLastChild = path.getAllNextSiblings().length <= 0;
        if (!isLastChild) return;

        // E.g. `1 + 1`, we want to wrap as `return 1 + 1`
        const toReturn = t.returnStatement(path.node.expression);
        path.replaceWith(toReturn);
      },
      ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>, state: PluginPass) {
        const fileName = extractFileName(state);

        // E.g. `export { x, y as y1 }`
        if (path.node.specifiers.length > 0) {
          // e.g. `export { x, y as y1 }`
          for (const specifier of (path.node.specifiers || [])) {
            if (specifier.type !== 'ExportSpecifier') continue;

            const registerExportExpr = t.expressionStatement(
              t.callExpression(
                t.identifier(registerValueExport.name), [
                t.stringLiteral(fileName),
                t.stringLiteral(specifier.local.name),
                specifier.exported.type === 'StringLiteral' ? specifier.exported : t.stringLiteral(specifier.exported.name),
              ])
            );
            path.insertAfter(registerExportExpr);
          }
          path.remove();
          return;
        }

        const processedBindingsByScope: Map<Scope, Set<Binding>> = state['processedBindingsByScope'] as any || new Map();
        state['processedBindingsByScope'] = processedBindingsByScope;

        const scope = path.scope;
        for (const [bindingKey, binding] of Object.entries(scope.bindings)) {

          const processedBindings = processedBindingsByScope.get(scope) || new Set();
          processedBindingsByScope.set(scope, processedBindings);
          if (processedBindings.has(binding)) {
            // console.log(`Processed binding ${bindingKey} previously. Ignoring...`);
            continue;
          } else {
            processedBindings.add(binding);
          }

          const registerExportExpr = t.expressionStatement(
            t.callExpression(
              t.identifier(registerValueExport.name), [
              t.stringLiteral(fileName),
              t.stringLiteral(binding.identifier.name),
              t.stringLiteral(binding.identifier.name)
            ])
          );
          const { path } = binding;
          const isExportedVar = ancestorsAre(path, [
            'VariableDeclarator',
            'VariableDeclaration',
            'ExportNamedDeclaration'
          ]);
          const isExportedFn = ancestorsAre(path, [
            'FunctionDeclaration',
            'ExportNamedDeclaration'
          ])
          if (isExportedVar || isExportedFn) {
            binding.path.parentPath?.insertAfter(registerExportExpr);
          }
        }
        // E.g. `export const x = 1` => `const x = 1`
        if (path.node.declaration) {
          path.replaceWith(path.node.declaration);
        }
      },
      ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>, state: PluginPass) {
        const fileName = extractFileName(state);

        let local: t.Identifier;
        const { declaration } = path.node;
        // Non-named fn or class
        if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
          if (declaration.id === null || declaration.id === undefined) {
            const id = t.identifier(_.uniqueId('__defaultExport'));
            declaration.id = id;
            const registerValueExpr = t.expressionStatement(
              t.callExpression(
                t.identifier(registerValue.name), [
                t.stringLiteral(fileName),
                t.stringLiteral(id.name),
                id
              ])
            );
            path.insertAfter(registerValueExpr);
          }
          local = declaration.id;
        } else if (t.isIdentifier(declaration)) {
          local = declaration;
        } else {
          return unexpected(`Default export: ${declaration.type}`);
        }

        const registerDefaultExportExpr = t.expressionStatement(
          t.callExpression(
            t.identifier(registerDefaultValueExport.name), [
            t.stringLiteral(fileName),
            t.stringLiteral(local.name)
          ])
        );
        path.replaceWith(path.node.declaration);
        path.insertAfter(registerDefaultExportExpr);
      },
      ImportDeclaration: {
        enter: (path: NodePath<t.ImportDeclaration>, state: PluginPass) => {
          const fileName = extractFileName(state);
          const importedNamespace = normalizeImportPath(fileName, path.node.source.value);

          const isBuiltIn = !fsPath.isAbsolute(importedNamespace);

          // Check whether we want to evaluate a module. We don't re-evaluate it if it's previously
          // been evaluated to avoid infinite recursion if there are cyclic deps
          if (!isBuiltIn && evalImports && !namespaces.get(importedNamespace)) {
            namespaces.set(importedNamespace, new Map());
            evaluate(importedNamespace, fs.readFileSync(importedNamespace, { encoding: 'utf8' }), evalImports, debug);
          }

          if (path.node.specifiers.length <= 0) {
            // TODO Importing for side-effects - Do I even need to do anything here?
          }

          for (const specifier of path.node.specifiers) {
            switch (specifier.type) {
              case 'ImportNamespaceSpecifier':
                registerValueImport(
                  fileName,
                  specifier.local.name,
                  symbols.namespaceExport,
                  path.node.source.value,
                  isBuiltIn
                );
                break;
              case 'ImportDefaultSpecifier':
                registerValueImport(
                  fileName,
                  specifier.local.name,
                  symbols.defaultExport,
                  path.node.source.value,
                  isBuiltIn
                );
                break;
              case 'ImportSpecifier':
                registerValueImport(
                  fileName,
                  specifier.local.name,
                  specifier.imported.type === 'StringLiteral'
                    ? specifier.imported.value
                    : specifier.imported.name,
                  path.node.source.value,
                  isBuiltIn
                );
                break;
              default:
                return unexpected(`Import specifier type ${(specifier as any).type}`)
            }
          }
        },
        exit: (path: NodePath<t.ImportDeclaration>, state: PluginPass) => {
          path.remove();
        }
      }
    }
  })
}

function normalizeImportPath(importingNamespace: string, importedNamespace: string) {
  try {
    const req = createRequire(importingNamespace);
    return req.resolve(importedNamespace);
  } catch (e) {
    console.error("Failed to normalize import path: ", e);
    throw e;
  }
}

function ancestorsAre(node: any, types: babel.Node['type'][]) {
  let isSatisfied = true;
  for (const t of types) {
    if (node.type !== t) {
      return false;
    }
    node = node.parentPath;
  }
  return isSatisfied;
}

function notImplementedYet(feature) {
  throw Error('Sorry not implemented yet: ' + feature);
}

function unexpected(thing) {
  throw Error('Unexpected: ' + thing);
}
