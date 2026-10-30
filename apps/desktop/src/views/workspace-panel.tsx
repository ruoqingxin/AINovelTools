import { GripVertical, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./workspace-panel.css";

export function WorkspacePanel({ open, docked = false, modal = true, resizable = false, title, onClose, closeLabel, children, className = "" }: {
  open: boolean; docked?: boolean; modal?: boolean; resizable?: boolean; title: string; onClose: () => void;
  closeLabel?: string; children: ReactNode; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  const [width, setWidth] = useState(920);
  const [resizing, setResizing] = useState(false);
  const drag = useRef({ x: 0, width: 0 });
  const maxWidth = () => Math.max(560, window.innerWidth - 144);
  const constrainWidth = (value: number) => Math.min(maxWidth(), Math.max(560, value));
  closeRef.current = onClose;
  useEffect(() => {
    if (!resizing || !open) return;
    const move = (event: PointerEvent) => setWidth(constrainWidth(drag.current.width + drag.current.x - event.clientX));
    const stop = () => setResizing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [resizing, open]);
  useEffect(() => { if (!open) setResizing(false); }, [open]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (element.open) element.close?.();
    if (!open) { element.removeAttribute("open"); return; }
    const previous = document.activeElement as HTMLElement | null;
    if (docked || !modal || !element.showModal) element.setAttribute("open", "");
    else element.showModal();
    return () => {
      if (element.open) element.close?.();
      if (!docked && previous?.isConnected) previous.focus();
    };
  }, [open, docked, modal]);
  return <dialog ref={dialog} className={`workspace-panel ${className}`} data-docked={docked}
    data-resizable={resizable && !docked} data-resizing={resizing}
    style={resizable && !docked ? { "--workspace-panel-width": `${width}px` } as CSSProperties : undefined}
    hidden={!open} aria-label={title} aria-modal={!docked && modal}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}
    onKeyDown={(event) => {
      if (!modal && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
    }}>
    {resizable && !docked ? <div className="workspace-panel-resize" role="separator" tabIndex={0}
      aria-label={`调整${title}宽度`} aria-orientation="vertical" aria-valuemin={560}
      aria-valuemax={maxWidth()} aria-valuenow={Math.min(width, maxWidth())} title="拖动调整宽度"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { x: event.clientX, width: dialog.current?.getBoundingClientRect().width ?? width };
        setResizing(true);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 100 : 40;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setWidth((current) => constrainWidth(event.key === "Home" ? 560 : event.key === "End" ? maxWidth()
          : Math.min(current, maxWidth()) + (event.key === "ArrowLeft" ? step : -step)));
      }}><GripVertical size={14} /></div> : null}
    <div className="workspace-panel-heading"><h2>{title}</h2>
      <button type="button" className="icon-command" title={closeLabel ?? `关闭${title}`} aria-label={closeLabel ?? `关闭${title}`}
        onClick={onClose}><X size={17} /></button>
    </div>
    <div className="workspace-panel-body">{children}</div>
  </dialog>;
}

export function useWideWorkspace(minWidth: number) {
  const [wide, setWide] = useState(() => window.matchMedia?.(`(min-width: ${minWidth}px)`).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(`(min-width: ${minWidth}px)`);
    if (!media) return;
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [minWidth]);
  return wide;
}
