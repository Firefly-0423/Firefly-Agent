/**
 * 必须是原生 CommonJS：这样 TypeScript 不会把里面的动态 import 改写成 require，
 * 测试运行器也会交给 Node 自带的模块加载器去执行。
 */
module.exports = function importEsmModule(specifier) {
  return import(specifier);
};
