import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, FilePlus2, FolderOpen, LibraryBig, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getCurrentProject, listRecentProjects } from "../lib/tauri-client";
import { useProjectActions } from "./project-actions-provider";

export function ProjectPicker() {
  const currentProject = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  const recent = useQuery({ queryKey: ["recent-projects"], queryFn: listRecentProjects });
  const actions = useProjectActions();
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpanded(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

  function run(action: () => Promise<void>) {
    setExpanded(false);
    void action();
  }

  return <div className="project-picker" ref={root}>
    <button ref={trigger} type="button" className="project-picker-trigger" aria-label="选择作品"
      aria-expanded={expanded} aria-controls="project-picker-panel" title={currentProject.data?.name ?? "选择作品"}
      disabled={actions.busy !== null} onClick={() => setExpanded((value) => !value)}>
      <LibraryBig size={18} /><span>{currentProject.isPending ? "正在读取作品…" : currentProject.data?.name ?? "选择作品"}</span>
      <ChevronDown size={14} />
    </button>
    {expanded ? <section className="project-picker-panel" id="project-picker-panel" aria-label="作品选择">
      <div className="project-picker-heading"><strong>作品</strong>
        <button type="button" className="shell-icon" aria-label="关闭作品选择" title="关闭"
          onClick={() => { setExpanded(false); trigger.current?.focus(); }}><X size={16} /></button>
      </div>
      {currentProject.data ? <div className="project-picker-current"><Check size={14} /><span>{currentProject.data.name}</span><small>当前</small></div> : null}
      <div className="project-picker-commands">
        <button type="button" onClick={() => run(actions.create)}><FilePlus2 size={16} />新建作品</button>
        <button type="button" onClick={() => run(actions.open)}><FolderOpen size={16} />打开作品</button>
      </div>
      <div className="project-picker-recents">
        <span className="project-picker-label">最近打开</span>
        {recent.isPending ? <p role="status">正在读取…</p> : recent.isError
          ? <div className="project-picker-error" role="alert">{errorMessage(recent.error)}
            <button type="button" onClick={() => void recent.refetch()}>重试</button></div>
          : recent.data?.length ? recent.data.slice(0, 6).map((project) =>
            <button key={project.root} type="button" title={project.root} onClick={() => run(() => actions.openRecent(project))}>
              <FolderOpen size={15} /><span>{project.name}</span>
            </button>) : <p>暂无最近作品</p>}
      </div>
      <Link to="/" search={{ manage: "1" }} className="project-picker-manage" onClick={() => setExpanded(false)}>
        <LibraryBig size={16} />作品管理
      </Link>
    </section> : null}
  </div>;
}
