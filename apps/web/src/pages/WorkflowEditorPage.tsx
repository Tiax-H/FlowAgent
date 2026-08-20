import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { validateWorkflowDefinition, type NodeType } from '@flowagent/shared';

import { workflowsApi } from '../api/workflows';
import { FlowAgentNode } from '../workflow/components/FlowAgentNode';
import { NodePalette } from '../workflow/components/NodePalette';
import { PropertyPanel } from '../workflow/components/PropertyPanel';
import { createFlowNode, definitionToFlow, flowToDefinition } from '../workflow/convert';
import type { WorkflowRecord } from '../workflow/types';

import '@xyflow/react/dist/style.css';

const nodeTypes = { flowagent: FlowAgentNode };

interface EditorProps {
  workflowId: string | null;
  onBack: () => void;
  onRun: (workflowId: string | null) => void;
}

function EditorCanvas({ workflowId, onBack, onRun }: EditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    if (workflowId === null) {
      setRecord(null);
      setName('未命名工作流');
      setNodes([
        createFlowNode('start', { x: 80, y: 200 }),
        createFlowNode('end', { x: 640, y: 200 }),
      ]);
      setEdges([]);
      return;
    }
    void workflowsApi
      .get(workflowId)
      .then((loaded) => {
        setRecord(loaded);
        setName(loaded.name);
        if (loaded.definition) {
          const flow = definitionToFlow(loaded.definition);
          setNodes(flow.nodes);
          setEdges(flow.edges);
        }
      })
      .catch((cause: unknown) =>
        setErrors([cause instanceof Error ? cause.message : String(cause)]),
      );
  }, [workflowId, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          { ...connection, sourceHandle: connection.sourceHandle ?? null },
          current.filter(
            (edge) =>
              !(
                edge.source === connection.source &&
                edge.target === connection.target &&
                edge.sourceHandle === (connection.sourceHandle ?? null)
              ),
          ),
        ),
      );
    },
    [setEdges],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      setNodes((current) => current.map((item) => ({ ...item, selected: item.id === node.id })));
    },
    [setNodes],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/flowagent-node') as NodeType | '';
      if (!type) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setNodes((current) => [...current, createFlowNode(type, position)]);
    },
    [screenToFlowPosition, setNodes],
  );

  const handleAddNode = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      setNodes((current) => [...current, createFlowNode(type, position)]);
    },
    [setNodes],
  );

  const handleDelete = useCallback(
    (nodeId: string) => {
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
    },
    [setNodes, setEdges],
  );

  const definition = useMemo(
    () =>
      flowToDefinition(nodes, edges, {
        schemaVersion: 1,
        name,
        nodes: [],
        edges: [],
      }),
    [nodes, edges, name],
  );

  async function handleSave() {
    setBusy(true);
    setSaved(null);
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {
      setErrors(result.errors);
      setBusy(false);
      return;
    }
    setErrors([]);
    try {
      const body = { name, definition: { ...definition, name } };
      const savedRecord = record
        ? await workflowsApi.update(record.id, body)
        : await workflowsApi.create(body);
      setRecord(savedRecord);
      setSaved(`已保存 v${savedRecord.version}`);
    } catch (cause) {
      setErrors([cause instanceof Error ? cause.message : String(cause)]);
    } finally {
      setBusy(false);
    }
  }

  const selectedNode = nodes.find((node) => node.selected) ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          ← 返回
        </button>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-56 rounded border border-transparent px-2 py-1 text-sm font-medium hover:border-neutral-300 focus:border-neutral-400 focus:outline-none"
        />
        {record && <span className="text-xs text-neutral-400">v{record.version}</span>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleSave()}
          className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          保存
        </button>
        <button
          type="button"
          disabled={busy || !record}
          title={record ? '先保存再运行' : '先保存工作流'}
          onClick={async () => {
            await handleSave();
            onRun(record?.id ?? workflowId);
          }}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          ▶ 运行
        </button>
        {saved && <span className="text-xs text-green-600">{saved}</span>}
      </header>
      {errors.length > 0 && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2">
          <p className="text-xs font-medium text-red-600">校验未通过（主图必须为严格 DAG）：</p>
          <ul className="list-inside list-disc text-xs text-red-500">
            {errors.slice(0, 5).map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <NodePalette onAdd={handleAddNode} />
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={() =>
              setNodes((current) => current.map((node) => ({ ...node, selected: false })))
            }
            onDragOver={onDragOver}
            onDrop={onDrop}
            fitView
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        {selectedNode && (
          <PropertyPanel
            node={selectedNode}
            onChange={(patch) =>
              setNodes((current) =>
                current.map((node) =>
                  node.id === selectedNode.id
                    ? { ...node, data: { ...node.data, ...patch } }
                    : node,
                ),
              )
            }
            onDelete={() => handleDelete(selectedNode.id)}
          />
        )}
      </div>
    </div>
  );
}

export function WorkflowEditorPage(props: EditorProps) {
  return (
    <div className="h-full">
      <ReactFlowProvider>
        <EditorCanvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
