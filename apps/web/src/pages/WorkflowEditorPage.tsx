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
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateWorkflowDefinition, type NodeType } from '@flowagent/shared';

import { workflowsApi, WorkflowApiError } from '../api/workflows';
import { Button } from '../components/ui';
import { FlowAgentNode } from '../workflow/components/FlowAgentNode';
import { NodePalette } from '../workflow/components/NodePalette';
import { PropertyPanel } from '../workflow/components/PropertyPanel';
import {
  createFlowNode,
  definitionToFlow,
  extractDefinitionExtras,
  flowToDefinition,
  type DefinitionExtras,
} from '../workflow/convert';
import { exportFileName, parseImportedWorkflow } from '../workflow/import';
import type { WorkflowRecord } from '../workflow/types';

import '@xyflow/react/dist/style.css';

const nodeTypes = { flowagent: FlowAgentNode };

interface EditorProps {
  workflowId: string | null;
  onBack: () => void;
  onRun: (workflowId: string | null) => void;
  /** dirty 状态上报给导航层（App）：顶部导航/路由切换在 dirty 时先确认再离开 */
  onDirtyChange?: (dirty: boolean) => void;
}

/** 一次可撤销的删除命令：被删节点 + 相连的边 */
interface DeletionCommand {
  nodes: Node[];
  edges: Edge[];
  /** 提示条文案，如「节点 开始、LLM」或「连线」 */
  label: string;
}

/** 命令栈深度上限，防止长会话内存膨胀 */
const MAX_UNDO_ENTRIES = 50;

function EditorCanvas({ workflowId, onBack, onRun, onDirtyChange }: EditorProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [name, setName] = useState('');
  /**
   * 画布不直接编辑的 definition 顶层元数据（description/variables）：
   * 加载/导入时暂存，保存/导出时透传，否则一次保存就会静默剥离。
   */
  const [definitionExtras, setDefinitionExtras] = useState<DefinitionExtras>({});
  /** 仅放 validateWorkflowDefinition 的结果；加载/保存/导入失败走各自的错误通道 */
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 保存冲突（409）：后端当前版本；null 表示无冲突 */
  const [conflict, setConflict] = useState<{ currentVersion: number | null } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 删除命令栈（仅最近 N 次），Ctrl+Z / 提示条撤销最近一次 */
  const undoStackRef = useRef<DeletionCommand[]>([]);
  const [lastDeletion, setLastDeletion] = useState<DeletionCommand | null>(null);

  const pushDeletion = useCallback((command: DeletionCommand) => {
    const stack = undoStackRef.current;
    stack.push(command);
    if (stack.length > MAX_UNDO_ENTRIES) stack.shift();
    setLastDeletion(command);
  }, []);

  const undoDelete = useCallback(() => {
    const command = undoStackRef.current.pop();
    if (!command) return;
    setNodes((current) => [
      ...current.filter((node) => !command.nodes.some((removed) => removed.id === node.id)),
      ...command.nodes,
    ]);
    setEdges((current) => [
      ...current.filter((edge) => !command.edges.some((removed) => removed.id === edge.id)),
      ...command.edges,
    ]);
    setLastDeletion(undoStackRef.current[undoStackRef.current.length - 1] ?? null);
  }, [setNodes, setEdges]);

  // 提示条自动消失；撤销后由 undoDelete 重置为上一条或 null
  useEffect(() => {
    if (!lastDeletion) return;
    const timer = window.setTimeout(() => setLastDeletion(null), 6000);
    return () => window.clearTimeout(timer);
  }, [lastDeletion]);

  // Ctrl/Cmd+Z 撤销最近一次删除（输入框内的撤销交还给原生行为）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.key !== 'z' && event.key !== 'Z') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (undoStackRef.current.length === 0) return;
      event.preventDefault();
      undoDelete();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoDelete]);

  const nodeDisplayName = useCallback((node: Node): string => {
    const name = node.data?.['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : node.id;
  }, []);

  useEffect(() => {
    setLoadError(null);
    // 切换工作流（或新建）：清空撤销栈，避免把上一个画布的节点恢复回来
    undoStackRef.current = [];
    setLastDeletion(null);
    setConflict(null);
    if (workflowId === null) {
      setRecord(null);
      setName('未命名工作流');
      setDefinitionExtras({});
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
          // 顶层 description/variables 画布不编辑：暂存起来，保存时透传防剥离
          const extras = extractDefinitionExtras(loaded.definition);
          setDefinitionExtras(extras);
          const flow = definitionToFlow(loaded.definition);
          setNodes(flow.nodes);
          setEdges(flow.edges);
          savedSnapshotRef.current = JSON.stringify(
            flowToDefinition(flow.nodes, flow.edges, {
              schemaVersion: 1,
              name: loaded.name,
              ...extras,
              nodes: [],
              edges: [],
            }),
          );
        } else {
          // 详情接口未返回定义（异常后端）：清空暂存，避免沿用上一个工作流的元数据
          setDefinitionExtras({});
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

  /** 包一层删除捕获：键盘/框选删除节点时记入命令栈，供撤销 */
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      const removedIds = changes.flatMap((change) =>
        change.type === 'remove' ? [change.id] : [],
      );
      if (removedIds.length > 0) {
        const idSet = new Set(removedIds);
        const removedNodes = nodes
          .filter((node) => idSet.has(node.id))
          .map((node) => ({ ...node, selected: false }));
        const removedEdges = edges.filter(
          (edge) => idSet.has(edge.source) || idSet.has(edge.target),
        );
        if (removedNodes.length > 0) {
          pushDeletion({
            nodes: removedNodes,
            edges: removedEdges,
            label: `节点 ${removedNodes.map(nodeDisplayName).join('、')}`,
          });
        }
      }
      onNodesChange(changes);
    },
    [nodes, edges, onNodesChange, pushDeletion, nodeDisplayName],
  );

  /** 包一层删除捕获：单独删除连线时记入命令栈 */
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const removedIds = changes.flatMap((change) =>
        change.type === 'remove' ? [change.id] : [],
      );
      if (removedIds.length > 0) {
        const idSet = new Set(removedIds);
        const removedEdges = edges.filter((edge) => idSet.has(edge.id));
        if (removedEdges.length > 0) {
          pushDeletion({ nodes: [], edges: removedEdges, label: '连线' });
        }
      }
      onEdgesChange(changes);
    },
    [edges, onEdgesChange, pushDeletion],
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
      const removedNode = nodes.find((node) => node.id === nodeId);
      if (removedNode) {
        pushDeletion({
          nodes: [{ ...removedNode, selected: false }],
          edges: edges.filter((edge) => edge.source === nodeId || edge.target === nodeId),
          label: `节点 ${nodeDisplayName(removedNode)}`,
        });
      }
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
    },
    [nodes, edges, setNodes, setEdges, pushDeletion, nodeDisplayName],
  );

  /**
   * 属性面板统一入口：写回节点 data；若本次补丁改了 Condition 分支列表，
   * 按下标对应关系把改名的分支 id 联动到该节点出边的 sourceHandle，防止编辑期悬空边。
   */
  const handleNodeDataChange = useCallback(
    (node: Node, patch: Record<string, unknown>) => {
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, ...patch } } : item,
        ),
      );
      const previousBranches = node.data['branches'];
      const nextBranches = patch['branches'];
      if (!Array.isArray(previousBranches) || !Array.isArray(nextBranches)) return;
      const renames = new Map<string, string>();
      const common = Math.min(previousBranches.length, nextBranches.length);
      for (let index = 0; index < common; index += 1) {
        const oldId = (previousBranches[index] as { id?: unknown } | null)?.id;
        const newId = (nextBranches[index] as { id?: unknown } | null)?.id;
        // 清空中的中间态（空串）不联动，等用户敲出合法 id 再更新
        if (
          typeof oldId === 'string' &&
          typeof newId === 'string' &&
          oldId !== newId &&
          newId !== ''
        ) {
          renames.set(oldId, newId);
        }
      }
      if (renames.size === 0) return;
      setEdges((current) =>
        current.map((edge) => {
          if (edge.source !== node.id || edge.sourceHandle == null) return edge;
          const renamed = renames.get(edge.sourceHandle);
          return renamed ? { ...edge, sourceHandle: renamed } : edge;
        }),
      );
    },
    [setNodes, setEdges],
  );

  const definition = useMemo(
    () =>
      flowToDefinition(nodes, edges, {
        schemaVersion: 1,
        name,
        ...definitionExtras,
        nodes: [],
        edges: [],
      }),
    [nodes, edges, name, definitionExtras],
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

  // dirty 状态上报导航层：顶部导航 / 任意路由切换在 dirty 时先确认再离开
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** 导入会用文件内容整体覆盖画布：dirty 时先确认 */
  const confirmImportOverwrite = (): boolean =>
    !dirty || window.confirm('画布有未保存修改，导入将覆盖当前内容，确定继续？');

  /** 保存：返回保存后的记录（含 id/version）；校验或请求失败返回 null */
  const handleSave = useCallback(async (): Promise<WorkflowRecord | null> => {
    setBusy(true);
    setSaved(null);
    setActionError(null);
    setConflict(null);
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {
      setErrors(result.errors);
      setBusy(false);
      return null;
    }
    setErrors([]);
    try {
      const body = {
        name,
        definition: { ...definition, name },
        // 乐观锁：用加载/上次保存落库的版本（record.version），不是本次保存后的；老后端忽略该字段
        ...(record ? { expectedVersion: record.version } : {}),
      };
      const savedRecord = record
        ? await workflowsApi.update(record.id, body)
        : await workflowsApi.create(body);
      setRecord(savedRecord);
      setSaved(`已保存 v${savedRecord.version}`);
      savedSnapshotRef.current = definitionJson;
      return savedRecord;
    } catch (cause) {
      // 409 版本冲突：单独冲突条呈现（带重新加载），不混入普通错误提示
      if (cause instanceof WorkflowApiError && cause.status === 409) {
        setConflict({ currentVersion: cause.currentVersion ?? null });
        return null;
      }
      // 请求失败不混入校验红框，单独提示
      setActionError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }, [definition, name, record, definitionJson]);

  /** 冲突后重新加载：走现有加载逻辑整体覆盖画布；dirty 时与导入一致先确认 */
  const handleConflictReload = useCallback(() => {
    if (dirty && !window.confirm('画布有未保存修改，重新加载将覆盖当前内容，确定继续？')) return;
    setConflict(null);
    handleRetryLoad();
  }, [dirty, handleRetryLoad]);

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
    if (!confirmImportOverwrite()) return;
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
        setConflict(null);
        setRecord(null);
        setName(result.value.name);
        // 导入的顶层元数据同样暂存，保存时透传
        const extras = extractDefinitionExtras(result.value.definition);
        setDefinitionExtras(extras);
        const flow = definitionToFlow(result.value.definition);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        savedSnapshotRef.current = JSON.stringify(
          flowToDefinition(flow.nodes, flow.edges, {
            schemaVersion: 1,
            name: result.value.name,
            ...extras,
            nodes: [],
            edges: [],
          }),
        );
        // 导入整体覆盖画布：旧画布的撤销命令必须作废，否则 Ctrl+Z 会把旧节点拼回新画布
        undoStackRef.current = [];
        setLastDeletion(null);
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
          onClick={onBack}
          title={dirty ? '画布有未保存修改，离开前会先确认' : undefined}
          className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          ← 返回{dirty ? ' •' : ''}
        </button>
        <input
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          title="工作流名称（最多 100 字）"
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
          {conflict && (
            <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2">
              <p className="min-w-0 flex-1 text-xs font-medium text-amber-800">
                {conflict.currentVersion !== null
                  ? `工作流已被其他会话修改（当前版本 v${conflict.currentVersion}），请刷新后重试`
                  : '工作流已被其他会话修改，请刷新后重试'}
              </p>
              <Button
                variant="secondary"
                disabled={busy}
                title="丢弃本地画布改动，重新读取服务端最新版本"
                onClick={handleConflictReload}
              >
                重新加载
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <NodePalette onAdd={handleAddNode} />
            <div className="relative min-w-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
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
              {lastDeletion && (
                <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
                  <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 shadow-md">
                    <span>已删除{lastDeletion.label}</span>
                    <button
                      type="button"
                      onClick={undoDelete}
                      title="撤销最近一次删除（Ctrl+Z）"
                      className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
                    >
                      撤销 (Ctrl+Z)
                    </button>
                  </div>
                </div>
              )}
            </div>
        {selectedNode && (
          <PropertyPanel
            node={selectedNode}
            onChange={(patch) => handleNodeDataChange(selectedNode, patch)}
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
