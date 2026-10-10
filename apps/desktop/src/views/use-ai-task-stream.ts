import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "../lib/ipc-transport";
import { useEffect, useRef, useState } from "react";
import { listAiRuns, type ReviewPurpose } from "../lib/tauri-client";

export function useAiTaskStream(props: {
  chapterId: string; active: boolean; enabled: boolean; busy: boolean;
  taskKey: "writing" | "consistencyReview"; reviewPurpose?: ReviewPurpose;
}) {
  const client = useQueryClient();
  const active = props.active;
  const busy = props.busy;
  const isReadinessMode = !props.enabled;
  const isReviewMode = props.taskKey === "consistencyReview";
  const panelTaskKey = props.taskKey;
  const reviewPurpose = props.reviewPurpose;
  const [preview, setPreview] = useState("");
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const streamTask = useRef<{ requesting: boolean; taskId: string | null; persistedTaskId: string | null }>({
    requesting: false, taskId: null, persistedTaskId: null,
  });
  const runningRuns = useQuery({
    queryKey: ["ai-runs", 80],
    queryFn: () => listAiRuns(80),
    enabled: active && !isReadinessMode,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) => active && query.state.data?.some((run) =>
      run.status === "RUNNING"
      && run.chapterId === props.chapterId
      && run.taskKey === panelTaskKey
      && (!isReviewMode || run.reviewPurpose === reviewPurpose)
    ) ? 1_000 : false,
  });
  const persistedRunning = isReadinessMode
    ? null
    : runningRuns.data?.find((run) =>
        run.status === "RUNNING"
        && run.chapterId === props.chapterId
        && run.taskKey === panelTaskKey
        && (!isReviewMode || run.reviewPurpose === reviewPurpose)
      ) ?? null;
  const generationBusy = busy || Boolean(persistedRunning);
  const generationLocked = generationBusy
    || (!isReadinessMode && (runningRuns.isPending || runningRuns.isFetching))
    || Boolean(runningRuns.data?.some((run) => run.status === "RUNNING" && run.chapterId === props.chapterId));
  const effectiveTaskId = persistedRunning?.id ?? null;
  streamTask.current.persistedTaskId = effectiveTaskId;
  const listenEnabled = !isReadinessMode && (active || busy);
  useEffect(() => {
    if (!listenEnabled) return;
    let disposed = false;
    const subscriptions = Promise.all([
      listen("ai-task-started", ({ payload }) => {
        if (!disposed) {
          if (streamTask.current.requesting && !streamTask.current.taskId) streamTask.current.taskId = payload.taskId;
          if (streamTask.current.taskId === payload.taskId || streamTask.current.persistedTaskId === payload.taskId) setPreview("");
          void client.invalidateQueries({ queryKey: ["ai-runs"] });
        }
      }),
      listen("ai-task-chunk", ({ payload }) => {
        if (!disposed && (streamTask.current.taskId === payload.taskId || streamTask.current.persistedTaskId === payload.taskId)) {
          setPreview((value) => value + payload.chunk);
        }
      }),
      listen("ai-task-attempt", ({ payload }) => {
        if (!disposed && payload.attempt > 1
            && (streamTask.current.taskId === payload.taskId || streamTask.current.persistedTaskId === payload.taskId)) {
          setPreview("");
          setFallbackNotice(`主模型调用失败（${payload.fallbackReason ?? "未知原因"}），已切换到“${payload.profileName}”继续生成。`);
        }
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((items) => items.forEach((unlisten) => unlisten())); };
  }, [client, listenEnabled]);

  useEffect(() => {
    setPreview("");
    setFallbackNotice(null);
    streamTask.current.taskId = null;
  }, [props.chapterId]);

  function beginRequest() {
    setPreview("");
    setFallbackNotice(null);
    streamTask.current.requesting = true;
    streamTask.current.taskId = null;
  }

  function finishRequest() {
    streamTask.current.requesting = false;
    void client.invalidateQueries({ queryKey: ["ai-runs"] });
  }

  return { preview, fallbackNotice, setFallbackNotice, generationBusy, generationLocked, effectiveTaskId, beginRequest, finishRequest };
}
