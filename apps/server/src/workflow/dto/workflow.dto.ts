export interface CreateWorkflowDto {
  name: string;
  description?: string;
  definition: unknown;
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string | null;
  definition?: unknown;
}

export interface WorkflowResponseDto {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
