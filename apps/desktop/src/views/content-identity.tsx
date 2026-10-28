import { ArrowUpRight, FileText, SquarePen } from "lucide-react";
import { createContext, useContext } from "react";
import { aiWorkspaceHref, contentCategories, identityLabel, type AiWorkspaceTarget, type ContentIdentity } from "../lib/content-taxonomy";
import "./content-identity.css";
import { WorkspaceLink } from "./workspace-link";

export const AiWorkspaceContext = createContext(false);
export const useInAiWorkspace = () => useContext(AiWorkspaceContext);

export function ContentTypeLabel({ identity }: { identity: ContentIdentity }) {
  return <span className="content-type-label" data-category={identity.category}
    title={contentCategories[identity.category].description}>{identityLabel(identity)}</span>;
}
export function AiWorkspaceLink({ target, children }: { target: AiWorkspaceTarget; children: React.ReactNode }) {
  return <WorkspaceLink className="secondary-action content-workspace-link" href={aiWorkspaceHref(target)}><ArrowUpRight size={15} />{children}</WorkspaceLink>;
}
export function FormalContent({ title, identity, content, status, target, pending = false, layout = "inline", loadState = "ready" }: {
  title: string; identity: ContentIdentity; content: string; status?: string;
  target: AiWorkspaceTarget; pending?: boolean;
  layout?: "inline" | "reader";
  loadState?: "loading" | "error" | "ready";
}) {
  if (layout === "reader") {
    const hasContent = Boolean(content.trim());
    const editAction = <WorkspaceLink className={`${hasContent ? "secondary-action" : "primary-action"} content-workspace-link`}
      href={aiWorkspaceHref(target)} aria-label={`去构思处理${title}`}>
      <SquarePen size={15} />{hasContent ? "编辑" : pending ? "核对" : "编写"}{identity.subtype}
    </WorkspaceLink>;
    return <section className="formal-content formal-content-reader" aria-label={`${title}正式内容`}>
      <header className="formal-reader-heading"><span>{status ?? identity.subtype}</span><h2>{title}</h2></header>
      <div className="formal-reader-toolbar"><ContentTypeLabel identity={identity} />{loadState === "ready" && hasContent ? editAction : null}</div>
      <div className="formal-reader-body">
        {loadState !== "ready" ? <p role="status" className="formal-reader-message">{loadState === "loading" ? "正在读取规划…" : "暂时无法读取规划"}</p>
          : hasContent ? <p className="formal-content-text">{content}</p> : <div className="formal-reader-empty">
            <FileText size={36} strokeWidth={1.25} aria-hidden="true" /><h3>暂无正式{identity.subtype}</h3>
            {pending && <p role="status">有待核对工作稿</p>}{editAction}
          </div>}
      </div>
      {loadState === "ready" && hasContent && pending ? <footer role="status">有待核对工作稿</footer> : null}
    </section>;
  }
  return <section className="formal-content" aria-label={`${title}正式内容`}>
    <header><ContentTypeLabel identity={identity} /><h2>{title}</h2>{status && <span className="library-meta">{status}</span>}</header>
    <p className="formal-content-text">{content.trim() || "暂无正式内容"}</p>
    <footer>{pending && <span className="library-meta">有待核对工作稿</span>}
      <AiWorkspaceLink target={target}>去构思处理{title}</AiWorkspaceLink></footer>
  </section>;
}
