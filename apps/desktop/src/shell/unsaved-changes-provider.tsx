import { useBlocker } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
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
  confirmLeave: () => Promise<boolean>;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function useConfirmLeave() {
  const context = useContext(UnsavedChangesContext);
  return context?.confirmLeave ?? (() => Promise.resolve(true));
}

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
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => () => {
    if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onStay();
      }
      if (event.key === "Tab") {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStay]);

  return (
    <div className="unsaved-dialog-backdrop">
      <section
        ref={dialog}
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
  const entriesRef = useRef(entries);
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null);
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  useEffect(() => () => { leaveResolver.current?.(false); }, []);

  const register = useCallback((id: string, dirty: boolean, message: string) => {
    const current = entriesRef.current;
    const existing = current[id];
    if (existing?.dirty === dirty && existing.message === message) return;
    const next = { ...current, [id]: { dirty, message } };
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const unregister = useCallback((id: string) => {
    const current = entriesRef.current;
    if (!(id in current)) return;
    const next = { ...current };
    delete next[id];
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const confirmLeave = useCallback(() => {
    if (leaveResolver.current) return Promise.resolve(false);
    const entry = Object.values(entriesRef.current).find((item) => item.dirty);
    if (!entry) return Promise.resolve(true);
    setLeaveMessage(entry.message);
    return new Promise<boolean>((resolve) => { leaveResolver.current = resolve; });
  }, []);
  const contextValue = useMemo(() => ({ register, unregister, confirmLeave }), [register, unregister, confirmLeave]);
  const dirtyEntry = Object.values(entries).find((entry) => entry.dirty);
  const dirty = Boolean(dirtyEntry);
  const shouldWarnBeforeUnload = useCallback(
    () => Object.values(entriesRef.current).some((entry) => entry.dirty),
    [],
  );
  const shouldBlock = useCallback(
    ({ current, next }: { current: { pathname: string; search?: Record<string, unknown> }; next: { pathname: string; search?: Record<string, unknown> } }) => (
      Object.values(entriesRef.current).some((entry) => entry.dirty)
      && (current.pathname !== next.pathname || ["/planning", "/discussion"].includes(current.pathname)
        && JSON.stringify(current.search) !== JSON.stringify(next.search))
    ),
    [],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldWarnBeforeUnload,
    disabled: !dirty,
    withResolver: true,
  });

  function finishLeave(allowed: boolean) {
    const resolve = leaveResolver.current;
    leaveResolver.current = null;
    setLeaveMessage(null);
    resolve?.(allowed);
  }

  return (
    <UnsavedChangesContext.Provider value={contextValue}>
      {children}
      {leaveMessage !== null ? (
        <UnsavedChangesDialog message={leaveMessage}
          onStay={() => finishLeave(false)} onLeave={() => finishLeave(true)} />
      ) : blocker.status === "blocked" ? (
        <UnsavedChangesDialog
          message={dirtyEntry?.message ?? "当前内容有未保存修改。"}
          onStay={blocker.reset}
          onLeave={blocker.proceed}
        />
      ) : null}
    </UnsavedChangesContext.Provider>
  );
}
