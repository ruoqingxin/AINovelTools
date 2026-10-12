import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./workspace-panel.css";

export function WorkspacePanel({ open, docked = false, title, onClose, children, className = "" }: {
  open: boolean; docked?: boolean; title: string; onClose: () => void; children: ReactNode; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (element.open) element.close?.();
    if (!open) { element.removeAttribute("open"); return; }
    const previous = document.activeElement as HTMLElement | null;
    if (docked || !element.showModal) element.setAttribute("open", "");
    else element.showModal();
    return () => {
      if (element.open) element.close?.();
      if (!docked && previous?.isConnected) previous.focus();
    };
  }, [open, docked]);
  return <dialog ref={dialog} className={`workspace-panel ${className}`} data-docked={docked}
    hidden={!open} aria-label={title} aria-modal={!docked}
    onCancel={(event) => { event.preventDefault(); closeRef.current(); }}>
    <div className="workspace-panel-heading"><h2>{title}</h2>
      <button type="button" className="icon-command" title={`关闭${title}`} aria-label={`关闭${title}`}
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
