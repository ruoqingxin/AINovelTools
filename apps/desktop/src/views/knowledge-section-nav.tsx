import { BookMarked, Files, ShieldCheck, UsersRound } from "lucide-react";

const sections = [
  { label: "实体库", href: "/knowledge", icon: UsersRound, exact: true },
  { label: "章节审核", href: "/knowledge/review", icon: ShieldCheck },
  { label: "知识记录", href: "/knowledge/records", icon: BookMarked },
  { label: "摘要与卡片", href: "/knowledge/materials", icon: Files },
];

export function KnowledgeSectionNav() {
  const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";

  return <nav className="knowledge-section-nav" aria-label="知识工作区分类">
    {sections.map(({ label, href, icon: Icon, exact }) => {
      const active = exact ? currentPath === href : currentPath === href || currentPath.startsWith(`${href}/`);

      return <a
      key={href}
      href={href}
      className="knowledge-section-link"
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
    >
      <Icon size={15} strokeWidth={1.8} />
      <span>{label}</span>
    </a>;
    })}
  </nav>;
}
