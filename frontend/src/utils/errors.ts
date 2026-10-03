/**
 * 版本链操作的领域错误：
 * - VersionConflictError：乐观版本号不一致（另一个标签页已先保存），拒绝覆盖
 * - RecalculationError：确认重算过程失败，记录与差异已按快照恢复到动手前
 */

/** 版本冲突：携带库里最新实体，供页面提示并重新载入 */
export class VersionConflictError extends Error {
  latest: unknown

  constructor(message: string, latest: unknown) {
    super(message)
    this.name = 'VersionConflictError'
    this.latest = latest
  }
}

/** 重算失败（回滚已完成） */
export class RecalculationError extends Error {
  cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RecalculationError'
    this.cause = cause
  }
}

export function isVersionConflictError(error: unknown): error is VersionConflictError {
  return error instanceof VersionConflictError
}

export function isRecalculationError(error: unknown): error is RecalculationError {
  return error instanceof RecalculationError
}
