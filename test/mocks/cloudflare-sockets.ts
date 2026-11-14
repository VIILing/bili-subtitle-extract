/**
 * 单测环境没有 workerd 的 cloudflare:sockets 模块，用 vitest alias 把它指到这里。
 * 只有在走 socket 回退时才会被调用；正常单测走 fetch / 假 BiliClient。
 */
export function connect(): never {
  throw new Error('cloudflare:sockets 在单元测试环境不可用');
}

export default { connect };
