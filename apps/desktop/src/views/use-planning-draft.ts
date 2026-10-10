import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { PlanningSection } from "../lib/tauri-client";

export function emptyPlanningSection(id: string): PlanningSection {
  return { id, content: "", pendingContent: "", storyState: "UNSET", rationale: "", consequence: "", references: [], updatedAt: "", version: 0 };
}

const editableFields = ["content", "pendingContent", "storyState", "rationale", "consequence", "references"] as const;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const planningDraftDirty = (draft: PlanningSection, baseline: PlanningSection) =>
  editableFields.some((key) => !equal(draft[key], baseline[key]));

type Snapshot = { scope: object; baseline: PlanningSection; form: PlanningSection };

export function usePlanningDraft(id: string, stored: PlanningSection | undefined, loaded: boolean) {
  const [state, setState] = useState(() => ({
    scope: {}, baseline: stored ?? emptyPlanningSection(id), form: stored ?? emptyPlanningSection(id), saving: false, retained: false,
  }));
  const inFlight = useRef<Snapshot | null>(null);
  const ready = loaded && state.baseline.id === id;
  const form = ready ? state.form : stored ?? emptyPlanningSection(id);
  const baseline = ready ? state.baseline : stored ?? emptyPlanningSection(id);
  const dirty = ready && (state.retained || planningDraftDirty(form, baseline));

  useEffect(() => {
    if (!loaded) return;
    const next = stored ?? emptyPlanningSection(id);
    setState((current) => {
      if (current.baseline.id !== id) return { scope: {}, baseline: next, form: next, saving: false, retained: false };
      if (current.saving || current.retained || planningDraftDirty(current.form, current.baseline)
        || (next.version ?? 0) < (current.baseline.version ?? 0)) return current;
      if (equal(next, current.baseline)) return current;
      return { ...current, baseline: next, form: next };
    });
  }, [id, loaded, stored]);

  function setForm(action: SetStateAction<PlanningSection>) {
    if (!ready) return;
    setState((current) => current.baseline.id !== id ? current : {
      ...current, form: typeof action === "function" ? action(current.form) : action,
    });
  }

  function beginSave(): Snapshot | null {
    if (!ready || inFlight.current) return null;
    const snapshot = { scope: state.scope, baseline, form };
    inFlight.current = snapshot;
    setState((current) => ({ ...current, saving: true }));
    return snapshot;
  }

  function acknowledge(snapshot: Snapshot, saved: PlanningSection) {
    setState((current) => {
      if (current.scope !== snapshot.scope || current.baseline.id !== saved.id) return current;
      // Only replace fields which still match the submitted editor snapshot.
      const next = { ...saved };
      for (const key of editableFields) {
        if (!equal(current.form[key], snapshot.form[key])) Object.assign(next, { [key]: current.form[key] });
      }
      return { ...current, baseline: saved, form: next, retained: false };
    });
  }

  function retainFailedSave(snapshot: Snapshot) {
    setState((current) => current.scope !== snapshot.scope ? current : { ...current, retained: true });
  }

  function finishSave(snapshot: Snapshot) {
    if (inFlight.current === snapshot) inFlight.current = null;
    setState((current) => current.scope !== snapshot.scope ? current : { ...current, saving: false });
  }

  function reload() {
    if (inFlight.current || !loaded) return;
    const next = stored ?? emptyPlanningSection(id);
    setState({ scope: {}, baseline: next, form: next, saving: false, retained: false });
  }

  return {
    form, baseline, setForm, dirty, ready, saving: state.saving,
    remoteChanged: ready && (stored?.version ?? 0) > (baseline.version ?? 0),
    beginSave, acknowledge, retainFailedSave, finishSave, reload,
  };
}
