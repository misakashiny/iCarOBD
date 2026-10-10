// ============================================================================
// 测试套件的公共前置（v2.35.0）
//
// 文件名以 `_` 开头 —— `run-browser-tests.ps1` 匹配的是 `verify-*.js`，
// 所以这个文件不会被当成一个套件去跑。
// ============================================================================

/**
 * **把三个原生弹窗 stub 掉**。
 *
 * ## 为什么必须在"任何可能触发它的操作之前"调用
 *
 * `window.alert()` 在 headless Chrome 里会**阻塞整个渲染进程** ——
 * CDP 的 `Runtime.evaluate` 于是永远等不到响应，表现成"求值超时"。
 *
 * 而且**症状离原因很远**：v2.34.0 那次，报错是"第 3 节的第一个求值超时"，
 * 而那个求值只是读个 `.length`，看起来跟弹窗毫无关系。
 *
 * 真正的原因链条：
 *
 * ```
 * 重名测试 → addAssetKind() → 命中"已经有这个分类了" → window.alert(...)
 *                                                          ↓
 *                                               渲染进程卡死 → CDP 超时
 * ```
 *
 * ## 教训
 *
 * **stub 要放在"任何可能触发它的操作之前"，不是"用到之前"。**
 * 前者一次搞定，后者迟早漏一个 —— 我当时就是只在后面某个用例里 stub 了
 * `alert`，而重名那条先执行、先卡死了。
 *
 * @param {object} cdp 已连接的 CDP 客户端（要有 `eval`）
 */
async function stubDialogs(cdp) {
  await cdp.eval(
    'window.__DIALOGS_STUBBED = 1;' +
    // alert：什么都不做（它返回值没意义）
    'window.alert = function () {};' +
    // confirm：默认"确定"。要测"取消"的用例自己临时覆盖。
    'window.confirm = function () { return true; };' +
    // prompt：默认"取消"（返回 null）。要输入的用例自己临时覆盖。
    'window.prompt = function () { return null; };' +
    '1'
  );
}

module.exports = { stubDialogs };
