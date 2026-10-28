import { BookMarked, Files, UsersRound } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useInAiWorkspace } from "./content-identity";

const sections = [
  { label: "设定", href: "/knowledge", icon: UsersRound, exact: true },
  { label: "剧情记录", href: "/knowledge/records", icon: BookMarked },
  { label: "辅助参考", href: "/knowledge/materials", icon: Files },
];

export function KnowledgeSectionNav() {
  const aiWorkspace = useInAiWorkspace();
  const currentPath = useRouterState({ select: (state) => state.location.pathname }).replace(/\/+$/, "") || "/";
  if (aiWorkspace) return null;

  const settingSection = currentPath === "/knowledge" || currentPath === "/knowledge/settings";
  return <><nav className="knowledge-section-nav" aria-label="知识资料分类">
    {sections.map(({ label, href, icon: Icon, exact }) => {
      const active = exact ? settingSection : currentPath === href || currentPath.startsWith(`${href}/`);

      return <Link
      key={href}
      to={href}
      preload="intent"
      activeOptions={{ exact: Boolean(exact), includeSearch: false }}
      className="knowledge-section-link"
      aria-current={active ? currentPath === href ? "page" : "location" : undefined}
      data-active={active || undefined}
    >
      <Icon size={15} strokeWidth={1.8} />
      <span>{label}</span>
    </Link>;
    })}
  </nav>
    {settingSection && <nav className="knowledge-subnav" aria-label="设定视图">
      <Link to="/knowledge" activeOptions={{ exact: true, includeSearch: false }}
        data-active={currentPath === "/knowledge" || undefined}
        aria-current={currentPath === "/knowledge" ? "page" : undefined}>设定内容</Link>
      <Link to="/knowledge/settings" activeOptions={{ includeSearch: false }}
        data-active={currentPath === "/knowledge/settings" || undefined}
        aria-current={currentPath === "/knowledge/settings" ? "page" : undefined}>设定揭示状态</Link>
    </nav>}
  </>;
}
