import { useBlocker } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type GuardEntry = {
  dirty: boolean;
  message: string;
};

type UnsavedChangesContextValue = {
  register: (id: string, dirty: boolean, message: string) => void;
  unregister: (id: string) => void;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function useUnsavedChangesGuard(dirty: boolean, message = "当前内容有未保存修改。") {
  const context = useContext(UnsavedChangesContext);
  const id = useId();

  useEffect(() => {
    if (!context) return;
    context.register(id, dirty, message);
    return () => context.unregister(id);
  }, [context, dirty, id, message]);
}

function UnsavedChangesDialog({
  message,
  onStay,
  onLeave,
}: {
  message: string;
  onStay: () => void;
  onLeave: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onStay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStay]);

  return (
    <div className="unsaved-dialog-backdrop">
      <section
        className="unsaved-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-dialog-title"
        aria-describedby="unsaved-dialog-description"
      >
        <span className="unsaved-dialog-kicker">离开前请确认</span>
        <h2 id="unsaved-dialog-title">当前修改尚未保存</h2>
        <p id="unsaved-dialog-description">{message} 现在离开会丢失这些修改。</p>
        <div className="unsaved-dialog-actions">
          <button type="button" className="primary-action" autoFocus onClick={onStay}>继续编辑</button>
          <button type="button" className="danger-action" onClick={onLeave}>放弃修改并离开</button>
        </div>
      </section>
    </div>
  );
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, GuardEntry>>({});

  const register = useCallback((id: string, dirty: boolean, message: string) => {
    setEntries((current) => {
      const existing = current[id];
      if (existing?.dirty === dirty && existing.message === message) return current;
      return { ...current, [id]: { dirty, message } };
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setEntries((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const contextValue = useMemo(() => ({ register, unregister }), [register, unregister]);
  const dirtyEntry = Object.values(entries).find((entry) => entry.dirty);
  const dirty = Boolean(dirtyEntry);
  const shouldBlock = useCallback(
    ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) => (
      dirty && current.pathname !== next.pathname
    ),
    [dirty],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: dirty,
    disabled: !dirty,
    withResolver: true,
  });

  return (
    <UnsavedChangesContext.Provider value={contextValue}>
      {children}
      {blocker.status === "blocked" ? (
        <UnsavedChangesDialog
          message={dirtyEntry?.message ?? "当前内容有未保存修改。"}
          onStay={blocker.reset}
          onLeave={blocker.proceed}
        />
      ) : null}
    </UnsavedChangesContext.Provider>
  );
}
