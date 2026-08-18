/**
 * WorkflowDefinition 的 JSON Schema（draft-07）。
 *
 * 与 `workflow.ts` 的 TS 类型手工同步维护；
 * 结构性规则（唯一性、连通性、DAG）见 `validation.ts` 中的命令式检查。
 */
export const workflowJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'FlowAgent WorkflowDefinition',
  type: 'object',
  required: ['schemaVersion', 'nodes', 'edges'],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type', 'name', 'position'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          type: {
            enum: [
              'start',
              'end',
              'agent',
              'llm',
              'tool',
              'condition',
              'loop',
              'human',
              'transform',
            ],
          },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          position: {
            type: 'object',
            required: ['x', 'y'],
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
            },
            additionalProperties: false,
          },
          data: { type: 'object' },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'source', 'target'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          source: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          sourceHandle: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          type: { enum: ['string', 'number', 'boolean', 'json'] },
          required: { type: 'boolean' },
        },
      },
    },
  },
} as const;
