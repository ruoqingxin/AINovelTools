import { useCallback, useEffect, useState } from "react";
import { useUnsavedChangesGuard } from "../shell/unsaved-changes-provider";

type CandidateEdit = { value: string; baseline: string };

export function useCandidateEdits() {
  const [entries, setEntries] = useState<Record<string, CandidateEdit>>({});
  const edit = useCallback((id: string, value: string, baseline: string) => {
    setEntries((current) => {
      const entry = current[id];
      const original = entry && entry.value !== entry.baseline ? entry.baseline : baseline;
      return { ...current, [id]: { value, baseline: original } };
    });
  }, []);
  const discard = useCallback((id: string) => {
    setEntries((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const acknowledge = useCallback((id: string, submitted: string, saved = submitted) => {
    setEntries((current) => {
      const entry = current[id];
      if (!entry) return current;
      const next = { ...current };
      // A completed request acknowledges its snapshot, not later typing.
      if (entry.value === submitted) delete next[id];
      else next[id] = { ...entry, baseline: saved };
      return next;
    });
  }, []);
  return {
    entries, edit, discard, acknowledge,
    dirty: Object.values(entries).some((entry) => entry.value !== entry.baseline),
  };
}

export function useCandidateEditGuard(
  dirty: boolean,
  busy: boolean,
  onPendingChange?: (pending: boolean) => void,
) {
  const pending = dirty || busy;
  useUnsavedChangesGuard(pending, busy ? "候选操作尚未完成，离开后请重新核对处理结果。" : "候选面板有未提交修改，离开会丢弃这些修改。");
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
}
