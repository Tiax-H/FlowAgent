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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateWorkflowDefinition, type NodeType } from '@flowagent/shared';

import { workflowsApi } from '../api/workflows';
import { Button } from '../components/ui';
import { FlowAgentNode } from '../workflow/components/FlowAgentNode';
import { NodePalette } from '../workflow/components/NodePalette';
import { PropertyPanel } from '../workflow/components/PropertyPanel';
import { createFlowNode, definitionToFlow, flowToDefinition } from '../workflow/convert';
import { exportFileName, parseImportedWorkflow } from '../workflow/import';
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
  /** 仅放 validateWorkflowDefinition 的结果；加载/保存/导入失败走各自的错误通道 */
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoadError(null);
    if (workflowId === null) {
      setRecord(null);
      setName('未命名工作流');
      setNodes([
        createFlowNode('start', { x: 80, y: 200 }),
        createFlowNode('end', { x: 640, y: 200 }),
      ]);
      setEdges([]);
      savedSnapshotRef.current = '';
      setErrors([]);
      setActionError(null);
      return;
    }
    setErrors([]);
    setActionError(null);
    let cancelled = false;
    void workflowsApi
      .get(workflowId)
      .then((loaded) => {
        if (cancelled) return;
        setRecord(loaded);
        setName(loaded.name);
        if (loaded.definition) {
          const flow = definitionToFlow(loaded.definition);
          setNodes(flow.nodes);
          setEdges(flow.edges);
          savedSnapshotRef.current = JSON.stringify(
            flowToDefinition(flow.nodes, flow.edges, {
              schemaVersion: 1,
              name: loaded.name,
              nodes: [],
              edges: [],
            }),
          );
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 加载失败（网络/404）与画布校验分流：单独黄底错误条呈现，可重试
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, reloadToken, setNodes, setEdges]);

  const handleRetryLoad = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

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

  /** 最近一次落盘（加载或保存）的定义快照，用于 dirty 判断 */
  const savedSnapshotRef = useRef<string>('');
  const definitionJson = useMemo(() => JSON.stringify(definition), [definition]);
  const dirty = definitionJson !== savedSnapshotRef.current;

  /** 校验错误定位用：节点 id → 节点名 */
  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of definition.nodes) map.set(node.id, node.name);
    return map;
  }, [definition]);

  /** 从校验消息中定位首个被引用的节点 id（优先带引号的精确匹配） */
  const locateNodeId = useCallback(
    (message: string): string | null => {
      let quotedHit: { id: string; index: number } | null = null;
      let plainHit: { id: string; index: number } | null = null;
      for (const id of nodeNameById.keys()) {
        const quotedIndex = message.indexOf(`"${id}"`);
        if (quotedIndex >= 0 && (quotedHit === null || quotedIndex < quotedHit.index)) {
          quotedHit = { id, index: quotedIndex };
          continue;
        }
        const plainIndex = message.indexOf(id);
        if (plainIndex >= 0 && (plainHit === null || plainIndex < plainHit.index)) {
          plainHit = { id, index: plainIndex };
        }
      }
      return quotedHit?.id ?? plainHit?.id ?? null;
    },
    [nodeNameById],
  );

  /** 校验错误点击定位：选中并聚焦到对应节点 */
  const focusNode = useCallback(
    (nodeId: string) => {
      setNodes((current) =>
        current.map((item) => ({ ...item, selected: item.id === nodeId })),
      );
      void fitView({ nodes: [{ id: nodeId }], duration: 400, maxZoom: 1.25, padding: 6 });
    },
    [fitView, setNodes],
  );

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const confirmLeave = (): boolean => !dirty || window.confirm('有未保存的修改，确定离开？');

  /** 保存：返回保存后的记录（含 id/version）；校验或请求失败返回 null */
  const handleSave = useCallback(async (): Promise<WorkflowRecord | null> => {
    setBusy(true);
    setSaved(null);
    setActionError(null);
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {
      setErrors(result.errors);
      setBusy(false);
      return null;
    }
    setErrors([]);
    try {
      const body = { name, definition: { ...definition, name } };
      const savedRecord = record
        ? await workflowsApi.update(record.id, body)
        : await workflowsApi.create(body);
      setRecord(savedRecord);
      setSaved(`已保存 v${savedRecord.version}`);
      savedSnapshotRef.current = definitionJson;
      return savedRecord;
    } catch (cause) {
      // 请求失败不混入校验红框，单独提示
      setActionError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, [definition, name, record, definitionJson]);

  // 全局 Ctrl/Cmd+S 触发保存：仅在有未保存改动且非保存中时生效
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key !== 's' && event.key !== 'S') return;
      event.preventDefault();
      if (!dirty || busy) return;
      void handleSave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, dirty, handleSave]);

  function handleImportFile(file: File) {
    void file
      .text()
      .then((raw) => {
        const result = parseImportedWorkflow(raw);
        if (!result.ok) {
          setActionError(`导入失败：${result.error}`);
          return;
        }
        setActionError(null);
        setErrors([]);
        setSaved(null);
        setRecord(null);
        setName(result.value.name);
        const flow = definitionToFlow(result.value.definition);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        savedSnapshotRef.current = JSON.stringify(
          flowToDefinition(flow.nodes, flow.edges, {
            schemaVersion: 1,
            name: result.value.name,
            nodes: [],
            edges: [],
          }),
        );
      })
      .catch((cause: unknown) =>
        setActionError(`导入失败：${cause instanceof Error ? cause.message : String(cause)}`),
      );
  }

  function handleExport() {
    const payload = JSON.stringify({ ...definition, name }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName(name);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const selectedNode = nodes.find((node) => node.selected) ?? null;

  // 空画布引导：只有 start→end 两个节点时提示用户从左侧面板添加步骤
  const showEmptyHint =
    nodes.length === 2 &&
    nodes.some((node) => node.data.nodeType === 'start') &&
    nodes.some((node) => node.data.nodeType === 'end');

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
        <button
          type="button"
          onClick={() => {
            if (confirmLeave()) onBack();
          }}
          className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          ← 返回{dirty ? ' •' : ''}
        </button>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-56 rounded border border-transparent px-2 py-1 text-sm font-medium hover:border-neutral-300 focus:border-neutral-400 focus:outline-none"
        />
        {record && <span className="text-xs text-neutral-400">v{record.version}</span>}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleImportFile(file);
            event.target.value = '';
          }}
        />
        <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
          导入 JSON
        </Button>
        <Button variant="secondary" onClick={handleExport}>
          导出 JSON
        </Button>
        <Button
          variant={busy || dirty ? 'accent' : 'secondary'}
          disabled={busy}
          onClick={() => void handleSave()}
          className="ml-auto"
        >
          {busy ? '保存中…' : dirty ? '● 保存改动' : '已保存'}
        </Button>
        <Button
          variant="accent"
          disabled={busy}
          title={record ? '校验并保存后运行' : '先保存工作流再运行'}
          onClick={async () => {
            // 校验或保存失败必须中断：绝不能拿着旧版本发起运行误导用户
            const savedRecord = await handleSave();
            if (!savedRecord) return;
            onRun(savedRecord.id);
          }}
        >
          ▶ 运行
        </Button>
        {saved && !dirty && <span className="text-xs text-green-600">{saved}</span>}
        {saved && dirty && <span className="text-xs text-neutral-400">有未保存修改</span>}
      </header>
      {loadError ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-lg border border-amber-300 bg-amber-50 px-6 py-5 text-center shadow-sm">
            <p className="text-sm font-medium text-amber-800">加载工作流失败：{loadError}</p>
            <button
              type="button"
              onClick={handleRetryLoad}
              className="mt-3 rounded bg-amber-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-600"
            >
              重试
            </button>
          </div>
        </div>
      ) : (
        <>
          {errors.length > 0 && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-2">
              <p className="text-xs font-medium text-red-600">
                校验未通过（主图必须为严格 DAG）：
              </p>
              <ul className="max-h-40 list-inside list-disc space-y-0.5 overflow-auto text-xs text-red-500">
                {errors.map((message, index) => {
                  const nodeId = locateNodeId(message);
                  const nodeName = nodeId ? nodeNameById.get(nodeId) : undefined;
                  const label = nodeId
                    ? `${nodeName ?? nodeId} (${nodeId})：${message}`
                    : message;
                  return (
                    <li key={`${index}-${message}`}>
                      {nodeId ? (
                        <button
                          type="button"
                          title="点击在画布中定位该节点"
                          onClick={() => focusNode(nodeId)}
                          className="text-left underline decoration-dotted underline-offset-2 transition-colors hover:text-red-700"
                        >
                          {label}
                        </button>
                      ) : (
                        label
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {actionError && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-2">
              <p className="text-xs font-medium text-red-600">{actionError}</p>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <NodePalette onAdd={handleAddNode} />
            <div className="relative min-w-0 flex-1">
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
              {showEmptyHint && (
                <div className="pointer-events-none absolute inset-x-0 top-[26%] z-10 flex justify-center">
                  <div className="rounded-lg border border-neutral-200 bg-white/70 px-5 py-3 text-center text-xs text-neutral-500 shadow-sm backdrop-blur-[1px]">
                    从左侧面板添加步骤：LLM / 工具 / 条件 / 循环 / 人工审批…
                  </div>
                </div>
              )}
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
        </>
      )}
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
