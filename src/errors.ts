/**
 * 统一的 API 错误类型。
 *
 * Worker 捕获 ApiError 后返回 `{ ok:false, code, message }` + 对应 HTTP 状态码；
 * 其它异常统一 500，避免把内部堆栈暴露给前端。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 把 B 站业务 code 映射成我们的 ApiError */
export function biliCodeError(code: number, message?: string): ApiError {
  const suffix = message ? `：${message}` : '';
  switch (code) {
    case -101:
      return new ApiError(502, 'BILI_NOT_LOGIN', `B 站接口返回未登录${suffix}`);
    case -352:
      return new ApiError(502, 'BILI_RISK_CONTROL', `B 站风控校验失败${suffix}`);
    case -412:
      return new ApiError(502, 'BILI_RISK_CONTROL', `B 站拒绝访问（HTTP 412 / IP 级风控）${suffix}`);
    case -509:
    case -799:
      return new ApiError(502, 'BILI_RATE_LIMIT', `B 站请求过于频繁${suffix}`);
    case -400:
      return new ApiError(400, 'BILI_BAD_REQUEST', `B 站请求参数错误（BVID 可能不合法）${suffix}`);
    case -403:
      return new ApiError(502, 'BILI_FORBIDDEN', `B 站访问权限不足${suffix}`);
    case -404:
      return new ApiError(404, 'VIDEO_NOT_FOUND', `B 站上找不到该视频${suffix}`);
    default:
      return new ApiError(502, 'BILI_ERROR', `B 站接口错误（code=${code}）${suffix}`);
  }
}
