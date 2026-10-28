import { Link, useRouter } from "@tanstack/react-router";
import type { ComponentProps } from "react";

export function WorkspaceLink({ href, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter({ warn: false });
  if (!router || !href.startsWith("/") || href.startsWith("//")) return <a {...props} href={href} />;
  const url = new URL(href, window.location.origin);
  return <Link {...props} to={url.pathname} search={Object.fromEntries(url.searchParams)}
    hash={url.hash.slice(1)} activeOptions={{ exact: true, includeHash: true }} activeProps={{}} preload={false} />;
}
