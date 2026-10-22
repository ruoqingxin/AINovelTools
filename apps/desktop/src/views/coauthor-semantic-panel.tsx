import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  buildCoauthorSemanticBatch, clearCoauthorSemanticCache, errorMessage, getCoauthorSemanticStatus, listModelProfiles, saveCoauthorSemanticSettings,
  type CoauthorScope, type CoauthorSemanticStatus,
} from "../lib/tauri-client";
import { useConfirmAction } from "../shell/confirm-action-provider";

const kinds = [
  ["ENTITY", "设定卡"], ["PLAN", "规划"], ["MANUSCRIPT", "正文"], ["FACT", "已审核事实"],
  ["RELATION", "关系"], ["CARD", "写作参考"], ["SUMMARY", "导航摘要"],
] as const;

export function CoauthorSemanticPanel({ scope }: { scope: CoauthorScope }) {
  const client = useQueryClient();
  const key = ["coauthor-semantic", scope.projectId, scope.sessionId];
  const status = useQuery({ queryKey: key, queryFn: () => getCoauthorSemanticStatus({ scope }), retry: false });
  return <section className="coauthor-semantic" aria-label="项目语义索引">
    {status.isPending && <p role="status">正在读取索引状态…</p>}
    {status.error && <p role="alert">索引状态无法核实：{errorMessage(status.error)}</p>}
    {status.data && <>
      {(status.isFetching || status.isError) && <p role="status">以下是缓存状态，当前授权及进度尚未核实。</p>}
      <SemanticControls key={`${scope.projectId}:${scope.sessionId}:${status.data.settings.version}`} scope={scope}
        status={status.data} verified={!status.isError && !status.isFetching}
        onSaved={(next) => client.setQueryData(key, next)} />
    </>}
    <button type="button" className="icon-command" aria-label="刷新语义索引" title="刷新语义索引"
      disabled={status.isFetching} onClick={() => void status.refetch()}><RefreshCw size={16} /></button>
  </section>;
}

function SemanticControls({ scope, status, verified, onSaved }: {
  scope: CoauthorScope; status: CoauthorSemanticStatus; verified: boolean; onSaved: (next: CoauthorSemanticStatus) => void;
}) {
  const models = useQuery({ queryKey: ["model-profiles"], queryFn: listModelProfiles, retry: false });
  const confirm = useConfirmAction();
  const [profileId, setProfileId] = useState(status.settings.profileId ?? "");
  const [selected, setSelected] = useState(status.settings.kinds.length ? status.settings.kinds : ["ENTITY"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const available = models.data?.filter((model) => model.capability === "EMBEDDING" && model.privacyLevel === "ALLOW_CLOUD" && model.hasSecret) ?? [];
  const profile = available.find((model) => model.id === profileId);
  const changed = profileId !== status.settings.profileId || [...selected].sort().join(",") !== [...status.settings.kinds].sort().join(",");
  async function act(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <>
    <p>{status.settings.profileId ? "项目语义检索已授权" : "项目语义检索未启用"}</p>
    <p>向量分块 {status.indexedChunks} / {status.totalChunks} · 资料索引待更新 {status.pendingSourceUpdates} 项</p>
    {status.pendingSourceUpdates > 0 && <p role="status">资料索引尚未更新完，分块总数不是全部资料的最终总量。</p>}
    <label>向量模型<select aria-label="向量模型" value={profileId} disabled={busy || !verified || models.isError || models.isFetching}
      onChange={(event) => setProfileId(event.target.value)}>
      <option value="">选择模型</option>
      {profileId && !profile && <option value={profileId}>原模型当前不可用</option>}
      {available.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select></label>
    {profile && <p className="coauthor-semantic-endpoint">{profile.modelId} · {profile.baseUrl}</p>}
    {models.error && <p role="alert">模型配置无法核实：{errorMessage(models.error)}</p>}
    <fieldset disabled={busy || !verified}><legend>向量外发授权类别</legend>
      {kinds.map(([kind, label]) => <label key={kind}><input type="checkbox" checked={selected.includes(kind)}
        onChange={(event) => setSelected((values) => event.target.checked ? [...values, kind] : values.filter((value) => value !== kind))} />{label}</label>)}
    </fieldset>
    <div className="coauthor-semantic-actions">
      <button type="button" disabled={busy || !verified || !profile || !selected.length || models.isError || models.isFetching} onClick={() => void act(async () => {
        if (!profile || !await confirm({ title: "授权项目语义检索", confirmLabel: "确认授权",
          message: `授权本项目将所选类别的文本分块发送到 ${profile.baseUrl}（${profile.modelId}）建立向量；后续讨论会向同一服务发送检索查询，短指令可能带最近作者消息。建立索引及查询可能产生费用。不包含讨论历史索引和工作稿；此次只保存授权，不自动建立索引。` })) return;
        if (!mounted.current) return;
        const next = await saveCoauthorSemanticSettings({ scope, expectedVersion: status.settings.version, kinds: selected,
          selection: { profileId: profile.id, baseUrl: profile.baseUrl, modelId: profile.modelId, provider: profile.provider, privacyLevel: profile.privacyLevel } });
        if (mounted.current) onSaved(next);
      })}><Save size={15} />保存授权</button>
      <button type="button" disabled={busy || !verified || changed || !profile || models.isError || models.isFetching || !status.settings.profileId} onClick={() => void act(async () => {
        if (!await confirm({ title: "建立一批语义索引", confirmLabel: "建立本批",
          message: `仅向已授权服务 ${profile?.baseUrl}（${profile?.modelId}）发送一批所选类别的文本，最多 8 块、约 10888 字，可能产生费用。此次不会自动继续下一批；撤销授权可中止等待，但无法收回已发送的文本。` })) return;
        if (!mounted.current) return;
        const result = await buildCoauthorSemanticBatch({ scope, expectedVersion: status.settings.version });
        if (mounted.current) { onSaved(result.status); setReceipt(`本批发送 ${result.sentChunks} 块、${result.sentChars} 字。`); }
      })}><DatabaseZap size={15} />建立下一批</button>
      <button type="button" disabled={!verified || !status.settings.profileId} onClick={() => void act(async () => {
        const next = await saveCoauthorSemanticSettings({ scope, expectedVersion: status.settings.version, selection: null, kinds: [] });
        if (mounted.current) onSaved(next);
      })}><Square size={15} />撤销授权</button>
      <button type="button" className="icon-command" aria-label="清除向量缓存" title="清除向量缓存"
        disabled={busy || !verified || !status.settings.profileId} onClick={() => void act(async () => {
          if (!await confirm({ title: "清除向量缓存", confirmLabel: "清除缓存",
            message: "清除本项目全部派生向量缓存（含其他向量配置），不删除正文、设定或证据；正在等待的旧批次会失效。清除后可分批重建，不会自动外发文本。" })) return;
          if (!mounted.current) return;
          const next = await clearCoauthorSemanticCache({ scope, expectedVersion: status.settings.version });
          if (mounted.current) onSaved(next);
        })}><Trash2 size={15} /></button>
    </div>
    {busy && <p role="status">正在处理…</p>}
    {receipt && <p role="status">{receipt}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
