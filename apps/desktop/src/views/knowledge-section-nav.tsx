import { BookMarked, Files, UsersRound } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";

const sections = [
  { label: "人物与世界", href: "/knowledge", icon: UsersRound, exact: true },
  { label: "作者设定", href: "/knowledge/settings", icon: BookMarked },
  { label: "剧情记录", href: "/knowledge/records", icon: BookMarked },
  { label: "参考资料", href: "/knowledge/materials", icon: Files },
];

export function KnowledgeSectionNav() {
  const currentPath = useRouterState({ select: (state) => state.location.pathname }).replace(/\/+$/, "") || "/";

  return <nav className="knowledge-section-nav" aria-label="知识资料分类">
    {sections.map(({ label, href, icon: Icon, exact }) => {
      const active = exact ? currentPath === href : currentPath === href || currentPath.startsWith(`${href}/`);

      return <Link
      key={href}
      to={href}
      preload="intent"
      activeOptions={{ exact: Boolean(exact), includeSearch: false }}
      className="knowledge-section-link"
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
    >
      <Icon size={15} strokeWidth={1.8} />
      <span>{label}</span>
    </Link>;
    })}
  </nav>;
}
