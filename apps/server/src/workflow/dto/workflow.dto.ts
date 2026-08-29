export interface CreateWorkflowDto {
  name: string;
  description?: string;
  definition: unknown;
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string | null;
  definition?: unknown;
  /**
   * 乐观锁（并发保存冲突检测）：提供时必须等于服务端当前 version，否则返回 409
   * （响应体含 currentVersion 供前端提示刷新）。未提供保持旧行为（后写者胜，向后兼容）。
   * 仅 definition 变更会递增 version。
   */
  expectedVersion?: number;
}

/** 详情响应：含完整 definition（编辑器与运行前输入解析用） */
export interface WorkflowResponseDto {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 列表响应：不返回 definition（每条约 3KB，列表页只用 name/version/updatedAt 等元信息）。
 * 破坏性变更：需要 definition 请调用 GET /api/workflows/:id 详情接口。
 */
export interface WorkflowListItemDto {
  id: string;
  name: string;
  description: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
