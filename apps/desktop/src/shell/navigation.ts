import { BookOpenText, FileSearch, ListTree, MessageSquareText, ShieldCheck } from "lucide-react";

export const primaryNavigation = [
  { label: "大纲规划", icon: ListTree, path: "/planning" },
  { label: "写作", icon: BookOpenText, path: "/writing" },
  { label: "构思", icon: MessageSquareText, path: "/discussion" },
  { label: "资料", icon: FileSearch, path: "/knowledge" },
  { label: "待办", icon: ShieldCheck, path: "/review" },
] as const;

export function primaryDestination(pathname: string) {
  if (pathname === "/chapters") return "/writing";
  if (pathname === "/preparation") return "/planning";
  if (pathname === "/knowledge/review") return "/review";
  return primaryNavigation.find(({ path }) => pathname === path || pathname.startsWith(`${path}/`))?.path;
}

export function workspaceLabel(pathname: string) {
  if (pathname === "/") return "作品管理";
  if (pathname === "/search") return "搜索";
  if (pathname === "/jobs") return "后台活动";
  if (pathname === "/settings") return "设置";
  return primaryNavigation.find(({ path }) => path === primaryDestination(pathname))?.label ?? "";
}
