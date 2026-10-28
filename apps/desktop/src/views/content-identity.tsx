import { ArrowUpRight } from "lucide-react";
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
export function FormalContent({ title, identity, content, status, target, pending = false }: {
  title: string; identity: ContentIdentity; content: string; status?: string;
  target: AiWorkspaceTarget; pending?: boolean;
}) {
  return <section className="formal-content" aria-label={`${title}正式内容`}>
    <header><ContentTypeLabel identity={identity} /><h2>{title}</h2>{status && <span className="library-meta">{status}</span>}</header>
    <p className="formal-content-text">{content.trim() || "暂无正式内容"}</p>
    <footer>{pending && <span className="library-meta">有待核对工作稿</span>}
      <AiWorkspaceLink target={target}>去构思处理{title}</AiWorkspaceLink></footer>
  </section>;
}
