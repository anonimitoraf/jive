400
// --- Environment ---
const exports = {
  'default-exports-and-imports/input1.js': { [Symbol(defaultExport)]: '[Function f]' },
  'default-exports-and-imports/input2.js': { [Symbol(defaultExport)]: 20 },
  'default-exports-and-imports/input3.js': { [Symbol(defaultExport)]: '[Function Foo]' }
}
const values = {
  'default-exports-and-imports/input1.js': { f: '[Function f]' },
  'default-exports-and-imports/input2.js': { input1: 'input1.js :: Symbol(defaultExport)', y: 20 },
  'default-exports-and-imports/input3.js': {
    input2: 'input2.js :: Symbol(defaultExport)',
    Foo: '[Function Foo]',
    foo: '[Instance Foo]'
  }
}