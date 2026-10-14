import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./confirm-action-provider.css";

type Confirmation = { message: string; confirmLabel?: string; title?: string };
type ConfirmAction = (request: Confirmation) => Promise<boolean>;
const Context = createContext<ConfirmAction | null>(null);
const nativeConfirm: ConfirmAction = async ({ message }) => window.confirm(message);

export function useConfirmAction() {
  return useContext(Context) ?? nativeConfirm;
}

function ConfirmationDialog({ request, onFinish }: { request: Confirmation; onFinish: (allowed: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    cancel.current?.focus();
    return () => {
      if (element.open) element.close?.();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="confirm-action-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}
    onCancel={(event) => { event.preventDefault(); onFinish(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onFinish(false); }
      if (event.key !== "Tab") return;
      const buttons = dialog.current?.querySelectorAll("button");
      const first = buttons?.[0], last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <h2 id={`${id}-title`}>{request.title ?? "请确认操作"}</h2>
    <p id={`${id}-message`}>{request.message}</p>
    <div className="confirm-action-commands">
      <button ref={cancel} type="button" className="secondary-action" onClick={() => onFinish(false)}>取消</button>
      <button type="button" className="primary-action" onClick={() => onFinish(true)}>{request.confirmLabel ?? "继续"}</button>
    </div>
  </dialog>;
}

export function ConfirmActionProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolver = useRef<((allowed: boolean) => void) | null>(null);
  const confirm = useCallback<ConfirmAction>((value) => {
    if (resolver.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; setRequest(value); });
  }, []);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  function finish(allowed: boolean) {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(allowed);
  }
  return <Context.Provider value={confirm}>{children}
    {request ? <ConfirmationDialog request={request} onFinish={finish} /> : null}
  </Context.Provider>;
}
